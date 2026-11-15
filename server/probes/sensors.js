import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../util/run.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PS_SCRIPT = path.join(here, 'sensors.ps1');

const state = {
  info: { cpu: null, gpus: [], thermalZones: [], fans: [] },
  lhm: { reachable: false, temperatures: [], fans: [], error: null },
  nvidia: { available: false, gpu: null, error: null, checkedAt: 0 },
  lastPs: 0,
};

function toNumber(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/* ---------------------------------------------------------------- PowerShell */

async function refreshPowerShell() {
  if (process.platform !== 'win32') return;
  state.lastPs = Date.now();

  const result = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT],
    { timeoutMs: 15000, maxOutput: 200_000 },
  );
  if (!result.ok || !result.stdout.trim()) return;

  try {
    const parsed = JSON.parse(result.stdout);
    state.info = {
      cpu: parsed.cpu || null,
      gpus: Array.isArray(parsed.gpus) ? parsed.gpus.filter(Boolean) : [],
      thermalZones: Array.isArray(parsed.thermalZones) ? parsed.thermalZones : [],
      fans: Array.isArray(parsed.fans) ? parsed.fans : [],
    };
  } catch {
    /* a partially written script should never take the dashboard down */
  }
}

/* --------------------------------------------------- LibreHardwareMonitor */

function walkLhm(node, trail, out) {
  if (!node || typeof node !== 'object') return;
  const children = Array.isArray(node.Children) ? node.Children : [];
  const text = String(node.Text ?? '').trim();
  const value = String(node.Value ?? '').trim();
  // trail is ["Sensor", hardware, category, ...] in LibreHardwareMonitor's tree
  const hardware = trail[1] || trail[0] || '';
  const category = trail[2] || trail[1] || 'Sensors';

  if (value) {
    const celsius = value.match(/^(-?[\d.,]+)\s*°\s*C/i);
    const rpm = value.match(/^([\d.,]+)\s*RPM/i);
    const percent = value.match(/^([\d.,]+)\s*%/);

    if (celsius) {
      const n = toNumber(celsius[1]);
      if (n != null && n > 0 && n < 130) {
        out.temperatures.push({
          label: text || 'Sensor',
          celsius: n,
          group: category,
          hardware,
          source: 'LibreHardwareMonitor',
        });
      }
    } else if (rpm) {
      const n = toNumber(rpm[1]);
      if (n != null && n > 0) {
        out.fans.push({
          label: text || 'Fan',
          rpm: n,
          percent: null,
          group: category,
          hardware,
          source: 'LibreHardwareMonitor',
        });
      }
    } else if (percent && /fan|pump/i.test(text)) {
      out.fans.push({
        label: text,
        rpm: null,
        percent: toNumber(percent[1]),
        group: category,
        hardware,
        source: 'LibreHardwareMonitor',
      });
    }
  }

  const nextTrail = text && !value ? [...trail, text] : trail;
  for (const child of children) walkLhm(child, nextTrail.slice(0, 3), out);
}

export function parseLhmPayload(payload) {
  const out = { temperatures: [], fans: [] };
  walkLhm(payload, [], out);

  const seen = new Set();
  const dedupe = (items) =>
    items.filter((item) => {
      const key = `${item.hardware}|${item.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return {
    temperatures: dedupe(out.temperatures).slice(0, 32),
    fans: dedupe(out.fans).slice(0, 16),
  };
}

async function fetchLhmPayload(url) {
  const response = await fetch(`${String(url).replace(/\/+$/, '')}/data.json`, {
    signal: AbortSignal.timeout(4000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function refreshLibreHardwareMonitor(url) {
  try {
    const parsed = parseLhmPayload(await fetchLhmPayload(url));
    state.lhm = { reachable: true, ...parsed, error: null };
  } catch (error) {
    state.lhm = {
      reachable: false,
      temperatures: [],
      fans: [],
      error: error?.name === 'TimeoutError' ? 'No response from LibreHardwareMonitor' : String(error?.message || error),
    };
  }
}

/** Used by the settings page so a helper can be checked before saving it. */
export async function testSensorSource(url) {
  try {
    const parsed = parseLhmPayload(await fetchLhmPayload(url));
    return {
      ok: true,
      temperatures: parsed.temperatures.length,
      fans: parsed.fans.length,
      samples: [
        ...parsed.temperatures.slice(0, 3).map((item) => `${item.label} ${item.celsius.toFixed(1)}°C`),
        ...parsed.fans
          .slice(0, 2)
          .map((fan) =>
            fan.rpm != null ? `${fan.label} ${Math.round(fan.rpm)} rpm` : `${fan.label} ${Math.round(fan.percent ?? 0)}%`,
          ),
      ],
    };
  } catch (error) {
    return {
      ok: false,
      temperatures: 0,
      fans: 0,
      samples: [],
      error: error?.name === 'TimeoutError' ? 'No response from that URL' : String(error?.message || error),
    };
  }
}

/* ------------------------------------------------------------------ NVIDIA */

async function refreshNvidia() {
  const stale = Date.now() - state.nvidia.checkedAt > 60000;
  if (!state.nvidia.available && !stale) return;

  const result = await run(
    'nvidia-smi',
    [
      '--query-gpu=index,name,temperature.gpu,fan.speed,utilization.gpu,memory.used,memory.total,power.draw',
      '--format=csv,noheader,nounits',
    ],
    { timeoutMs: 5000, maxOutput: 100_000 },
  );

  state.nvidia.checkedAt = Date.now();

  if (!result.ok) {
    state.nvidia = {
      available: false,
      gpu: null,
      error: 'nvidia-smi not available',
      checkedAt: state.nvidia.checkedAt,
    };
    return;
  }

  const line = result.stdout.split(/\r?\n/).find((row) => row.trim());
  if (!line) return;

  const [index, name, temperature, fan, utilization, memoryUsed, memoryTotal, power] = line
    .split(',')
    .map((part) => part.trim());

  state.nvidia = {
    available: true,
    error: null,
    checkedAt: state.nvidia.checkedAt,
    gpu: {
      index: toNumber(index),
      name: name || 'GPU',
      temperatureC: toNumber(temperature),
      fanPercent: toNumber(fan),
      utilizationPercent: toNumber(utilization),
      memoryUsedMb: toNumber(memoryUsed),
      memoryTotalMb: toNumber(memoryTotal),
      powerW: toNumber(power),
      source: 'nvidia-smi',
    },
  };
}

/* ---------------------------------------------------------------- lifecycle */

let started = false;
let activeConfig = null;

export function startSensors(config) {
  activeConfig = config;
  if (started) return;
  started = true;

  refreshPowerShell();
  refreshLibreHardwareMonitor(config.libreHardwareMonitor.url);
  refreshNvidia();

  // Sensor names and ACPI zones barely change; polling them rarely keeps the
  // dashboard's own CPU use close to zero.
  setInterval(() => refreshPowerShell(), 90000);

  setInterval(() => {
    if (config.libreHardwareMonitor.enabled) refreshLibreHardwareMonitor(config.libreHardwareMonitor.url);
    refreshNvidia();
  }, config.sensorRefreshMs);
}

export async function refreshSensorSources() {
  if (!activeConfig) return;
  if (activeConfig.libreHardwareMonitor.enabled) {
    await refreshLibreHardwareMonitor(activeConfig.libreHardwareMonitor.url);
  }
  await refreshNvidia();
}

export function getSensors() {
  const temperatures = [...state.lhm.temperatures];
  const fans = [...state.lhm.fans];
  const gpu = state.nvidia.gpu;

  for (const zone of state.info.thermalZones) {
    const celsius = toNumber(zone.celsius);
    if (celsius != null && celsius > 0) {
      temperatures.push({
        label: String(zone.name || 'ACPI zone').replace(/\\/g, ' / '),
        celsius,
        group: 'ACPI',
        hardware: 'Motherboard',
        source: 'WMI',
      });
    }
  }

  for (const fan of state.info.fans) {
    const rpm = toNumber(fan.rpm);
    if (rpm != null && rpm > 0) {
      fans.push({
        label: String(fan.name || 'Fan').replace(/\\/g, ' / '),
        rpm,
        percent: null,
        group: 'Chassis',
        hardware: 'Motherboard',
        source: 'WMI',
      });
    }
  }

  // If the hardware helper already reports the graphics card, prefer its numbers
  // instead of listing the same GPU twice.
  const helperCoversGpu =
    state.lhm.temperatures.some((item) => /gpu|nvidia|radeon|arc/i.test(`${item.hardware} ${item.label}`)) ||
    state.lhm.fans.some((item) => /gpu|nvidia|radeon|arc/i.test(`${item.hardware} ${item.label}`));

  if (gpu?.temperatureC != null && !helperCoversGpu) {
    temperatures.push({
      label: 'GPU core',
      celsius: gpu.temperatureC,
      group: 'GPU',
      hardware: gpu.name,
      source: 'nvidia-smi',
    });
  }
  if (gpu?.fanPercent != null && !helperCoversGpu) {
    fans.push({
      label: 'GPU fan',
      rpm: null,
      percent: gpu.fanPercent,
      group: 'GPU',
      hardware: gpu.name,
      source: 'nvidia-smi',
    });
  }

  const hasCpuTemp = temperatures.some(
    (t) => t.source !== 'nvidia-smi' && /cpu|core|package|tctl|tdie|ccd/i.test(t.label),
  );
  let hint = null;
  if (!temperatures.length) {
    hint = configHint();
  } else if (!hasCpuTemp) {
    hint = 'CPU temperature is not exposed by Windows. Run LibreHardwareMonitor with its web server on port 8085 to add per-core temperatures and fan RPM.';
  }

  return {
    cpu: state.info.cpu,
    gpus: state.info.gpus,
    temperatures,
    fans,
    gpu,
    sources: {
      libreHardwareMonitor: state.lhm.reachable,
      nvidiaSmi: state.nvidia.available,
      wmiThermalZones: state.info.thermalZones.length,
    },
    hint,
    updatedAt: Date.now(),
  };
}

function configHint() {
  return 'No temperature sensors reported. Windows does not expose them without a helper: run LibreHardwareMonitor (Options → Remote Web Server, port 8085) and this panel picks it up automatically.';
}
