import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const configPath = path.join(projectRoot, 'config.json');

export const THEMES = ['midnight', 'ember', 'violet', 'daylight'];

const DEFAULTS = {
  port: 4317,
  theme: 'midnight',
  diskRoots: [],
  refreshMs: 2000,
  sensorRefreshMs: 5000,
  docker: { enabled: true, refreshMs: 6000 },
  libreHardwareMonitor: { enabled: true, url: 'http://127.0.0.1:8085' },
  sites: [],
};

function detectRoots() {
  const roots = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    try {
      if (existsSync(root)) roots.push(root);
    } catch {
      /* unreadable drive letters are simply skipped */
    }
  }
  return roots.length ? roots : [path.parse(process.cwd()).root];
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Accepts "example.com" and turns it into a usable URL instead of rejecting it. */
function normalizeSiteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  return `https://${raw.replace(/^\/+/, '')}`;
}

function normalizeSites(input) {
  if (!Array.isArray(input)) return [];
  const sites = [];

  for (const entry of input.slice(0, 24)) {
    if (!entry || typeof entry !== 'object') continue;
    const url = normalizeSiteUrl(entry.url);
    if (!/^https?:\/\//i.test(url)) continue;

    const links = Array.isArray(entry.links)
      ? entry.links
          .filter((link) => link && typeof link === 'object' && /^https?:\/\//i.test(String(link.url || '')))
          .slice(0, 12)
          .map((link) => ({ label: String(link.label || link.url).slice(0, 60), url: String(link.url) }))
      : [];

    let host = 'site';
    try {
      host = new URL(url).host;
    } catch {
      /* keep the fallback name */
    }

    sites.push({
      name: String(entry.name || host).slice(0, 60),
      url,
      adminUrl: normalizeSiteUrl(entry.adminUrl),
      links,
    });
  }

  return sites;
}

function sanitizeRoots(input) {
  const list = Array.isArray(input) ? input : [];
  return Array.from(
    new Set(
      list
        .filter((root) => typeof root === 'string' && root.trim() && path.isAbsolute(root.trim()))
        .map((root) => path.resolve(root.trim())),
    ),
  );
}

export function validateSensorUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{2,5})?(\/.*)?$/i.test(url)) {
    throw Object.assign(new Error('The helper URL must point at this machine (127.0.0.1 or localhost).'), {
      statusCode: 400,
    });
  }
  return url;
}

export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const docker = source.docker && typeof source.docker === 'object' ? source.docker : {};
  const lhm = source.libreHardwareMonitor && typeof source.libreHardwareMonitor === 'object' ? source.libreHardwareMonitor : {};

  let lhmUrl = DEFAULTS.libreHardwareMonitor.url;
  try {
    if (lhm.url) lhmUrl = validateSensorUrl(lhm.url);
  } catch {
    /* fall back to the default helper address */
  }

  const roots = sanitizeRoots(source.diskRoots);

  return {
    port: clamp(source.port, 1024, 65535, DEFAULTS.port),
    theme: THEMES.includes(source.theme) ? source.theme : DEFAULTS.theme,
    diskRoots: roots.length ? roots : detectRoots(),
    refreshMs: clamp(source.refreshMs, 500, 15000, DEFAULTS.refreshMs),
    sensorRefreshMs: clamp(source.sensorRefreshMs, 2000, 60000, DEFAULTS.sensorRefreshMs),
    docker: {
      enabled: docker.enabled !== false,
      refreshMs: clamp(docker.refreshMs, 3000, 60000, DEFAULTS.docker.refreshMs),
    },
    libreHardwareMonitor: {
      enabled: lhm.enabled !== false,
      url: lhmUrl,
    },
    sites: normalizeSites(source.sites),
  };
}

function readRawConfig() {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

export function loadConfig() {
  let raw = {};
  let note = null;

  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (error) {
      note = `config.json could not be parsed (${error.message}); using defaults.`;
      raw = {};
    }
  } else {
    try {
      writeFileSync(configPath, `${JSON.stringify(DEFAULTS, null, 2)}\n`, 'utf8');
      note = 'config.json was created with defaults.';
    } catch {
      /* a read-only folder still works from defaults */
    }
  }

  return { config: normalizeConfig(raw), note };
}

/** Validate a settings payload from the UI. Throws with statusCode 400 when invalid. */
export function validateSettings(input, live) {
  const body = input && typeof input === 'object' ? input : {};
  const next = {
    theme: THEMES.includes(body.theme) ? body.theme : live.theme,
    sites: live.sites,
    docker: { ...live.docker },
    sensors: { enabled: live.libreHardwareMonitor.enabled, url: live.libreHardwareMonitor.url },
    diskRoots: live.diskRoots,
  };

  if (Array.isArray(body.sites)) {
    const sites = [];
    for (const [index, entry] of body.sites.slice(0, 24).entries()) {
      if (!entry || typeof entry !== 'object') continue;
      const url = normalizeSiteUrl(entry.url);
      if (!url) continue;
      if (!/^https?:\/\//i.test(url)) {
        throw Object.assign(new Error(`Site ${index + 1} needs a URL like https://example.com`), {
          statusCode: 400,
        });
      }
      let host = 'site';
      try {
        host = new URL(url).host;
      } catch {
        throw Object.assign(new Error(`Site ${index + 1} has a URL that cannot be parsed`), { statusCode: 400 });
      }
      const links = Array.isArray(entry.links)
        ? entry.links
            .filter((link) => link && /^https?:\/\//i.test(String(link.url || '')))
            .slice(0, 12)
            .map((link) => ({ label: String(link.label || link.url).slice(0, 60), url: String(link.url) }))
        : [];
      sites.push({
        name: String(entry.name || host).slice(0, 60),
        url,
        adminUrl: normalizeSiteUrl(entry.adminUrl),
        links,
      });
    }
    next.sites = sites;
  }

  if (body.docker && typeof body.docker === 'object') {
    next.docker.enabled = body.docker.enabled !== false;
    next.docker.refreshMs = clamp(body.docker.refreshMs, 3000, 60000, live.docker.refreshMs);
  }

  if (body.sensors && typeof body.sensors === 'object') {
    next.sensors.enabled = body.sensors.enabled !== false;
    if (body.sensors.url) next.sensors.url = validateSensorUrl(body.sensors.url);
  }

  if (Array.isArray(body.diskRoots) && body.diskRoots.length) {
    const roots = [];
    for (const entry of body.diskRoots.slice(0, 8)) {
      const raw = String(entry || '').trim();
      if (!raw) continue;
      if (!path.isAbsolute(raw)) {
        throw Object.assign(new Error(`"${raw}" is not a full path. Use something like D:\\`), { statusCode: 400 });
      }
      const resolved = path.resolve(raw);
      let stat;
      try {
        stat = statSync(resolved);
      } catch {
        throw Object.assign(new Error(`"${resolved}" cannot be read from this PC`), { statusCode: 400 });
      }
      if (!stat.isDirectory()) {
        throw Object.assign(new Error(`"${resolved}" is not a folder`), { statusCode: 400 });
      }
      roots.push(resolved);
    }
    if (!roots.length) {
      throw Object.assign(new Error('Keep at least one drive in the list'), { statusCode: 400 });
    }
    next.diskRoots = Array.from(new Set(roots));
  }

  return next;
}

/** Write settings back into config.json, leaving any unknown keys untouched. */
export function saveSettings(settings) {
  const raw = readRawConfig();
  const merged = {
    ...raw,
    theme: settings.theme,
    diskRoots: settings.diskRoots,
    docker: { ...(raw.docker || {}), enabled: settings.docker.enabled, refreshMs: settings.docker.refreshMs },
    libreHardwareMonitor: {
      ...(raw.libreHardwareMonitor || {}),
      enabled: settings.sensors.enabled,
      url: settings.sensors.url,
    },
    sites: settings.sites,
  };

  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

/** Mutate the live config object in place so running probes pick changes up. */
export function applySettings(config, settings) {
  config.theme = settings.theme;
  config.diskRoots = settings.diskRoots;
  config.docker.enabled = settings.docker.enabled;
  config.docker.refreshMs = settings.docker.refreshMs;
  config.libreHardwareMonitor.enabled = settings.sensors.enabled;
  config.libreHardwareMonitor.url = settings.sensors.url;
  config.sites = settings.sites;
}
