import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  applySettings,
  loadConfig,
  projectRoot,
  saveSettings,
  validateSensorUrl,
  validateSettings,
} from './config.js';
import { baseHeaders, originIsAllowed, pageHeaders, requestIsLoopback } from './security.js';
import { getSystemSnapshot, startSystemProbe } from './probes/system.js';
import { getSensors, refreshSensorSources, startSensors, testSensorSource } from './probes/sensors.js';
import { helperStatus, installHelper, startHelper } from './probes/helper.js';
import { containerAction, listContainers } from './probes/docker.js';
import { checkSites } from './probes/sites.js';
import { getScan, startScan, validateScanPath } from './probes/disktree.js';

const { config, note } = loadConfig();
const webRoot = path.join(projectRoot, 'web');
const startedAt = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...baseHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });

    req.on('error', reject);
  });
}

function settingsView() {
  return {
    theme: config.theme,
    sites: config.sites,
    docker: { enabled: config.docker.enabled, refreshMs: config.docker.refreshMs },
    sensors: { enabled: config.libreHardwareMonitor.enabled, url: config.libreHardwareMonitor.url },
    diskRoots: config.diskRoots,
  };
}

async function handleApi(req, res, url, pathname) {
  const method = req.method;

  if (pathname === '/api/config' && method === 'GET') {
    return sendJson(res, 200, {
      version: '0.1.0',
      refreshMs: config.refreshMs,
      sensorRefreshMs: config.sensorRefreshMs,
      diskRoots: config.diskRoots,
      dockerEnabled: config.docker.enabled,
      dockerRefreshMs: config.docker.refreshMs,
      theme: config.theme,
      sites: config.sites,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    });
  }

  if (pathname === '/api/settings' && method === 'GET') {
    return sendJson(res, 200, { settings: settingsView() });
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await readJsonBody(req);
    const next = validateSettings(body, config);
    try {
      saveSettings(next);
    } catch (error) {
      throw Object.assign(new Error(`Could not write config.json: ${error.message}`), { statusCode: 500 });
    }
    applySettings(config, next);
    await refreshSensorSources();
    return sendJson(res, 200, { ok: true, settings: settingsView() });
  }

  if (pathname === '/api/sensors/test' && method === 'POST') {
    const body = await readJsonBody(req);
    return sendJson(res, 200, await testSensorSource(validateSensorUrl(body.url)));
  }

  if (pathname === '/api/helper' && method === 'GET') {
    return sendJson(res, 200, await helperStatus());
  }

  if (pathname === '/api/helper/install' && method === 'POST') {
    try {
      return sendJson(res, 200, { ok: true, status: await installHelper() });
    } catch (error) {
      return sendJson(res, error?.statusCode || 500, {
        ok: false,
        error: String(error?.message || error),
        status: await helperStatus(),
      });
    }
  }

  if (pathname === '/api/helper/start' && method === 'POST') {
    try {
      return sendJson(res, 200, await startHelper());
    } catch (error) {
      return sendJson(res, error?.statusCode || 500, {
        ok: false,
        error: String(error?.message || error),
        status: await helperStatus(),
      });
    }
  }

  if (pathname === '/api/system' && method === 'GET') {
    return sendJson(res, 200, getSystemSnapshot());
  }

  if (pathname === '/api/sensors' && method === 'GET') {
    return sendJson(res, 200, getSensors());
  }

  if (pathname === '/api/docker' && method === 'GET') {
    if (!config.docker.enabled) {
      return sendJson(res, 200, {
        available: false,
        disabled: true,
        error: 'The container panel is turned off in config.json.',
        containers: [],
      });
    }
    return sendJson(res, 200, await listContainers());
  }

  if (pathname === '/api/docker/action' && method === 'POST') {
    if (!config.docker.enabled) {
      return sendJson(res, 403, { ok: false, error: 'The container panel is turned off in config.json.' });
    }
    const body = await readJsonBody(req);
    return sendJson(res, 200, await containerAction(body.name, body.action));
  }

  if (pathname === '/api/sites' && method === 'GET') {
    const sites = await checkSites(config.sites, { force: url.searchParams.get('refresh') === '1' });
    return sendJson(res, 200, { sites });
  }

  if (pathname === '/api/disk/scan' && method === 'POST') {
    const body = await readJsonBody(req);
    const target = validateScanPath(body.path, config.diskRoots);
    return sendJson(res, 200, startScan(target, { refresh: body.refresh === true }));
  }

  if (pathname === '/api/disk/scan' && method === 'GET') {
    const job = getScan(url.searchParams.get('id'));
    if (!job) return sendJson(res, 404, { error: 'That scan is no longer available. Start a new one.' });
    return sendJson(res, 200, job);
  }

  return sendJson(res, 404, { error: 'Unknown API route' });
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(webRoot, relative);
  const prefix = webRoot.endsWith(path.sep) ? webRoot : webRoot + path.sep;

  if (target !== webRoot && !target.startsWith(prefix)) {
    return sendJson(res, 404, { error: 'Not found' });
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return sendJson(res, 404, { error: 'Not found' });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: 'Not found' });

  const ext = path.extname(target).toLowerCase();
  const headers =
    ext === '.html'
      ? pageHeaders
      : { ...baseHeaders, 'Cache-Control': 'no-cache' };

  res.writeHead(200, {
    ...headers,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
  });

  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).pipe(res);
}

const server = http.createServer(async (req, res) => {
  if (!requestIsLoopback(req)) {
    res.writeHead(421, baseHeaders);
    res.end('This dashboard only answers on 127.0.0.1');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch {
    return sendJson(res, 400, { error: 'Malformed request' });
  }

  if (pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !originIsAllowed(req, config.port)) {
      return sendJson(res, 403, { error: 'Cross-origin request rejected' });
    }
    try {
      await handleApi(req, res, new URL(req.url, 'http://127.0.0.1'), pathname);
    } catch (error) {
      const status = error?.statusCode || 500;
      sendJson(res, status, { error: status === 500 ? 'The dashboard hit an unexpected error.' : String(error.message) });
      if (status === 500) console.error('[api]', error);
    }
    return;
  }

  serveStatic(req, res, pathname);
});

startSystemProbe(config);
startSensors(config);

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\nPort ${config.port} is already in use. Change "port" in config.json and try again.\n`);
  } else {
    console.error('\nCould not start the dashboard:', error.message, '\n');
  }
  process.exit(1);
});

server.listen(config.port, '127.0.0.1', () => {
  const lines = [
    '',
    '  PC Deck',
    `  ───────────────────────────────────────────`,
    `  http://127.0.0.1:${config.port}`,
    '',
    `  drives        ${config.diskRoots.join('  ')}`,
    `  containers    ${config.docker.enabled ? 'enabled (Docker CLI required)' : 'disabled'}`,
    `  sites         ${config.sites.length ? config.sites.map((site) => site.name).join(', ') : 'none configured'}`,
    `  sensors       ${config.libreHardwareMonitor.enabled ? `LibreHardwareMonitor at ${config.libreHardwareMonitor.url}` : 'LibreHardwareMonitor disabled'}`,
    '',
    '  Loopback only. No admin rights, no shell, no telemetry.',
    '  Settings live in config.json.',
    '',
  ];
  console.log(lines.join('\n'));
  if (note) console.log(`  note: ${note}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
