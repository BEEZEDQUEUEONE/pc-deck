import { run } from '../util/run.js';

const ACTIONS = new Set(['start', 'stop', 'restart']);
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

const state = { checkedAt: 0, available: false, version: null, error: null };

function describeFailure(result) {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (text.includes('enoent') || text.includes('not recognized')) {
    return 'Docker CLI is not on PATH. Install Docker Desktop, or turn the container panel off in config.json.';
  }
  if (text.includes('error during connect') || text.includes('cannot connect') || text.includes('pipe')) {
    return 'Docker is installed but the engine is not running. Start Docker Desktop and this panel will connect.';
  }
  if (result.timedOut) return 'Docker did not answer in time.';
  const firstLine = result.stderr.split(/\r?\n/).find((line) => line.trim());
  return firstLine ? firstLine.trim().slice(0, 240) : 'Docker is unavailable.';
}

async function probe(force = false) {
  if (!force && state.checkedAt && Date.now() - state.checkedAt < 15000) return;
  const result = await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 5000 });
  state.checkedAt = Date.now();

  if (result.ok) {
    state.available = true;
    state.version = result.stdout.trim() || null;
    state.error = null;
  } else {
    state.available = false;
    state.version = null;
    state.error = describeFailure(result);
  }
}

function parseContainers(stdout) {
  const containers = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      containers.push({
        id: String(row.ID || '').slice(0, 12),
        name: String(row.Names || '').trim(),
        image: String(row.Image || ''),
        command: String(row.Command || ''),
        state: String(row.State || '').toLowerCase(),
        status: String(row.Status || ''),
        ports: String(row.Ports || ''),
        runningFor: String(row.RunningFor || ''),
      });
    } catch {
      /* skip malformed rows rather than failing the whole list */
    }
  }
  return containers.sort((a, b) => {
    const aRunning = a.state === 'running' ? 0 : 1;
    const bRunning = b.state === 'running' ? 0 : 1;
    return aRunning - bRunning || a.name.localeCompare(b.name);
  });
}

export async function listContainers() {
  await probe();
  if (!state.available) {
    return { available: false, version: null, error: state.error, containers: [] };
  }

  const result = await run('docker', ['ps', '-a', '--no-trunc', '--format', '{{json .}}'], { timeoutMs: 15000 });
  if (!result.ok) {
    state.available = false;
    state.checkedAt = 0;
    return { available: false, version: null, error: describeFailure(result), containers: [] };
  }

  return {
    available: true,
    version: state.version,
    error: null,
    containers: parseContainers(result.stdout),
  };
}

export async function containerAction(name, action) {
  const normalizedAction = String(action || '').toLowerCase();
  if (!ACTIONS.has(normalizedAction)) {
    return { ok: false, error: 'Only start, stop and restart are allowed.' };
  }
  if (!NAME_PATTERN.test(String(name || ''))) {
    return { ok: false, error: 'Invalid container name.' };
  }

  // Confirm the container exists so nothing but a real container name can reach docker.
  const listing = await listContainers();
  if (!listing.available) return { ok: false, error: listing.error };
  if (!listing.containers.some((container) => container.name === name)) {
    return { ok: false, error: `No container named "${name}".` };
  }

  const result = await run('docker', [normalizedAction, name], { timeoutMs: 45000, maxOutput: 200_000 });
  if (!result.ok) {
    return { ok: false, error: describeFailure(result) };
  }
  return { ok: true, message: `${normalizedAction} sent to ${name}` };
}
