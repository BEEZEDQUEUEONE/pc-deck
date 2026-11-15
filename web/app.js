const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const THEMES = [
  { id: 'midnight', label: 'Midnight', detail: 'teal on charcoal' },
  { id: 'ember', label: 'Ember', detail: 'amber on warm charcoal' },
  { id: 'violet', label: 'Violet', detail: 'lilac on indigo' },
  { id: 'daylight', label: 'Daylight', detail: 'light and quiet' },
];

const TILE_PALETTES = {
  midnight: {
    dir: { hue: 168, range: 32, sat: 32, light: 24 },
    file: { hue: 198, range: 62, sat: 22, light: 31 },
  },
  ember: {
    dir: { hue: 18, range: 26, sat: 34, light: 23 },
    file: { hue: 8, range: 34, sat: 24, light: 30 },
  },
  violet: {
    dir: { hue: 248, range: 34, sat: 30, light: 26 },
    file: { hue: 226, range: 40, sat: 24, light: 32 },
  },
  daylight: {
    dir: { hue: 172, range: 30, sat: 36, light: 80 },
    file: { hue: 200, range: 50, sat: 20, light: 87 },
  },
};

const state = {
  config: null,
  settings: null,
  panel: 'overview',
  system: null,
  sensors: null,
  docker: null,
  sites: [],
  history: { cpu: [], mem: [] },
  disk: { root: '', path: '', tree: null, jobId: null, poll: null, busy: false },
  toastTimer: null,
};

let editorRoots = [];
let lastDockerAt = 0;
let helperState = null;

/* ------------------------------------------------------------------ utils */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unit]}`;
}

function fmtUptime(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

function timeAgo(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - Number(timestamp || 0)) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function level(value) {
  if (value >= 90) return 'hot';
  if (value >= 70) return 'warm';
  return 'ok';
}

function tempLevel(celsius) {
  if (celsius >= 85) return 'hot';
  if (celsius >= 70) return 'warm';
  return 'ok';
}

function platformLabel(platform, release) {
  if (platform === 'win32') {
    const build = Number(String(release).split('.')[2]);
    return `${build >= 22000 ? 'Windows 11' : 'Windows 10'} · ${release}`;
  }
  if (platform === 'darwin') return `macOS ${release}`;
  return `${platform} ${release}`;
}

async function api(url, options = {}) {
  // Inside the desktop app the page talks to Rust over IPC; in a browser it
  // falls back to the HTTP server so the same UI can still be developed.
  if (window.__pcdeck) {
    return window.__pcdeck.request(url, options.method || 'GET', options.body ?? null);
  }

  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      /* keep the status message */
    }
    throw new Error(message);
  }
  return response.json();
}

function showToast(message, kind = 'ok') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast is-${kind}`;
  toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3400);
}

function setLive(ok) {
  const dot = $('#live-dot');
  dot.classList.toggle('is-live', ok);
  dot.classList.toggle('is-down', !ok);
  $('#live-text').textContent = ok ? 'live' : 'reconnecting';
}

/* ------------------------------------------------------------------ theme */

function applyTheme(theme) {
  const known = THEMES.some((entry) => entry.id === theme);
  const id = known ? theme : 'midnight';
  document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem('pcdeck.theme', id);
  } catch {
    /* private mode: the theme still applies for this session */
  }
  syncChartGradients();
}

function syncChartGradients() {
  const accent = cssVar('--accent');
  const blue = cssVar('--blue');
  for (const stop of $$('#fill-accent stop')) stop.setAttribute('stop-color', accent);
  for (const stop of $$('#fill-blue stop')) stop.setAttribute('stop-color', blue);
}

function markTheme(theme) {
  $$('#theme-picker .theme-option').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.theme === theme);
  });
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  bindNav();
  bindDisk();
  bindDocker();
  bindSite();
  bindSettings();
  tickClock();

  setInterval(tickClock, 1000);

  try {
    state.config = await api('/api/config');
  } catch (error) {
    showToast(`Could not read settings: ${error.message}`, 'error');
    state.config = { refreshMs: 2000, sensorRefreshMs: 5000, diskRoots: [], sites: [], theme: 'midnight' };
  }

  applyTheme(state.config.theme || 'midnight');
  if (state.config.diskRoots?.length) {
    state.disk.root = state.config.diskRoots[0];
    $('#disk-root').value = state.disk.root;
  }
  renderDiskRoots();

  await Promise.allSettled([refreshSystem(), refreshSensors()]);

  const refreshMs = Math.max(1000, state.config.refreshMs || 2000);
  const sensorMs = Math.max(2500, state.config.sensorRefreshMs || 5000);

  setInterval(() => {
    if (!document.hidden) refreshSystem();
  }, refreshMs);

  setInterval(() => {
    if (!document.hidden) refreshSensors();
  }, sensorMs);

  setInterval(() => {
    if (document.hidden || state.panel !== 'docker') return;
    if (Date.now() - lastDockerAt < (state.config?.dockerRefreshMs || 6000)) return;
    refreshDocker();
  }, 1500);

  setInterval(() => {
    if (!document.hidden && state.panel === 'site') refreshSites();
  }, 45000);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    refreshSystem();
    refreshSensors();
    if (state.panel === 'docker') refreshDocker();
    if (state.panel === 'site') refreshSites();
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.panel === 'disk' && state.disk.tree) renderTreemap(state.disk.tree);
    }, 180);
  });
}

function tickClock() {
  $('#clock').textContent = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function bindNav() {
  $$('.nav-item').forEach((button) => {
    button.addEventListener('click', () => {
      const panel = button.dataset.panel;
      state.panel = panel;
      $$('.nav-item').forEach((item) => item.classList.toggle('is-active', item === button));
      $$('.panel').forEach((section) => section.classList.toggle('is-active', section.id === `panel-${panel}`));

      if (panel === 'disk') {
        if (state.disk.tree) renderTreemap(state.disk.tree);
        else if (!state.disk.busy) loadDisk(state.disk.root);
      }
      if (panel === 'docker') refreshDocker();
      if (panel === 'site') refreshSites();
      if (panel === 'settings' && !state.settings) loadSettings({ quiet: true });
    });
  });

  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-open-panel]');
    if (!link) return;
    event.preventDefault();
    const button = $(`.nav-item[data-panel="${link.dataset.openPanel}"]`);
    if (button) button.click();
  });
}

/* --------------------------------------------------------------- overview */

async function refreshSystem() {
  try {
    const data = await api('/api/system');
    state.system = data;
    setLive(true);
    state.history.cpu.push(data.cpu.usage);
    state.history.mem.push(data.memory.usage);
    if (state.history.cpu.length > 90) state.history.cpu.shift();
    if (state.history.mem.length > 90) state.history.mem.shift();
    renderOverview(data);
  } catch {
    setLive(false);
  }
}

function renderOverview(data) {
  const platform = platformLabel(data.platform, data.release);

  $('#host-name').textContent = data.host;
  $('#host-meta').textContent = `${data.cpu.model} · ${platform} · up ${fmtUptime(data.uptimeSec)}`;

  $('#cpu-value').textContent = Math.round(data.cpu.usage);
  $('#cpu-model').textContent = `${data.cpu.model} · ${data.cpu.threads} threads`;
  $('#cpu-spark').innerHTML = sparkline(state.history.cpu, cssVar('--accent'), 'fill-accent');
  renderCores(data.cpu.perCore);

  const memory = data.memory;
  $('#mem-value').textContent = Math.round(memory.usage);
  $('#mem-sub').textContent = `${fmtBytes(memory.used)} of ${fmtBytes(memory.total)} in use`;
  $('#mem-spark').innerHTML = sparkline(state.history.mem, cssVar('--blue'), 'fill-blue');
  const memoryBar = $('#mem-bar');
  memoryBar.style.width = `${Math.min(100, memory.usage)}%`;
  memoryBar.dataset.level = level(memory.usage);
  $('#mem-foot').textContent = `${fmtBytes(memory.free)} free`;

  renderVolumes(data.volumes);

  const physicalCores = state.sensors?.cpu?.cores;
  const rows = [
    ['System', platform],
    ['Processor cores', physicalCores ? `${physicalCores} cores / ${data.cpu.threads} threads` : `${data.cpu.threads} threads`],
    ['Uptime', fmtUptime(data.uptimeSec)],
    ['Dashboard memory', `${(data.dashboard.rss / 1048576).toFixed(0)} MB`],
    ['Engine', data.node],
  ];

  $('#system-list').innerHTML = rows
    .map(([label, value]) => `<div class="kv-row"><span>${esc(label)}</span><span>${esc(value)}</span></div>`)
    .join('');
}

function renderCores(perCore) {
  const box = $('#cores');
  const values = Array.isArray(perCore) ? perCore : [];

  if (box.children.length !== values.length) {
    box.innerHTML = values
      .map(
        (_, index) => `
        <div class="core">
          <span class="core-id">${String(index + 1).padStart(2, '0')}</span>
          <span class="core-track"><i></i></span>
          <span class="core-val">0%</span>
        </div>`,
      )
      .join('');
  }

  Array.from(box.children).forEach((row, index) => {
    const value = Math.min(100, Math.max(0, values[index] ?? 0));
    const fill = row.querySelector('.core-track i');
    fill.style.width = `${value}%`;
    fill.dataset.level = level(value);
    row.querySelector('.core-val').textContent = `${Math.round(value)}%`;
  });
}

function renderVolumes(volumes) {
  const box = $('#volumes');
  const list = Array.isArray(volumes) ? volumes : [];

  if (!list.length) {
    box.innerHTML = '<p class="empty">No volumes reported.</p>';
    $('#drive-sub').textContent = '—';
    return;
  }

  const totalCapacity = list.reduce((sum, volume) => sum + volume.total, 0);
  $('#drive-sub').textContent = `${list.length} volume${list.length === 1 ? '' : 's'} · ${fmtBytes(totalCapacity)} total`;

  box.innerHTML = list
    .map(
      (volume) => `
      <div class="volume">
        <div class="volume-head">
          <span class="volume-name">${esc(volume.name)}</span>
          <span class="volume-size">${fmtBytes(volume.used)} / ${fmtBytes(volume.total)}</span>
        </div>
        <div class="bar"><i style="width:${Math.min(100, volume.usage)}%" data-level="${level(volume.usage)}"></i></div>
        <p class="volume-meta">${fmtBytes(volume.free)} free · ${volume.usage}% used</p>
      </div>`,
    )
    .join('');
}

function sparkline(values, color, gradientId) {
  if (!Array.isArray(values) || values.length < 2) return '';
  const max = Math.max(10, ...values);
  const coords = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 100;
    const y = 100 - (Math.min(Math.max(value, 0), max) / max) * 90 - 5;
    return [x, y];
  });
  const line = coords.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `M0,100 L${coords.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' L')} L100,100 Z`;

  return `<svg class="spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    <path d="${area}" fill="url(#${gradientId})" />
    <polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
  </svg>`;
}

/* ---------------------------------------------------------------- sensors */

async function refreshSensors() {
  try {
    const data = await api('/api/sensors');
    state.sensors = data;
    renderSensors(data);
  } catch {
    /* the panel keeps its last values */
  }
}

function renderSensors(data) {
  const temperatures = [...(data.temperatures || [])].sort((a, b) => b.celsius - a.celsius);
  const fans = [...(data.fans || [])];

  const sources = [];
  if (data.sources.libreHardwareMonitor) sources.push('LibreHardwareMonitor');
  if (data.sources.nvidiaSmi) sources.push('nvidia-smi');
  if (data.sources.wmiThermalZones) sources.push('ACPI');
  $('#sensor-sources').textContent = sources.length ? sources.join(' · ') : 'No sensor source reachable';

  const rows = [];
  let lastHardware = '';

  if (temperatures.length) {
    rows.push('<p class="group-label">Temperatures</p>');
    for (const sensor of temperatures) {
      const hardware = sensor.hardware && sensor.hardware !== lastHardware ? sensor.hardware : '';
      if (hardware) lastHardware = sensor.hardware;
      rows.push(`
        <div class="sensor">
          <span class="sensor-name">${esc(sensor.label)}${hardware ? `<small>${esc(hardware)}</small>` : ''}</span>
          <span class="sensor-value ${tempLevel(sensor.celsius)}">${Number(sensor.celsius).toFixed(1)}<small>°C</small></span>
        </div>`);
    }
  }

  if (fans.length) {
    rows.push('<p class="group-label">Fans</p>');
    for (const fan of fans) {
      const shown =
        fan.rpm != null
          ? `${Math.round(fan.rpm)}<small> rpm</small>`
          : `${Math.round(fan.percent ?? 0)}<small> %</small>`;
      rows.push(`
        <div class="sensor">
          <span class="sensor-name">${esc(fan.label)}<small>${esc(fan.hardware || fan.group || fan.source)}</small></span>
          <span class="sensor-value">${shown}</span>
        </div>`);
    }
  }

  $('#sensor-list').innerHTML = rows.length
    ? rows.join('')
    : '<p class="empty">No temperature or fan sensors reported.</p>';

  const hint = $('#sensor-hint');
  if (data.hint) {
    hint.hidden = false;
    hint.textContent = data.hint;
  } else {
    hint.hidden = true;
  }

  renderGpu(data.gpu);
}

function renderGpu(gpu) {
  const card = $('#gpu-card');
  if (!gpu) {
    card.hidden = true;
    return;
  }

  card.hidden = false;
  $('#gpu-name').textContent = gpu.name;
  $('#gpu-temp').textContent = gpu.temperatureC != null ? Math.round(gpu.temperatureC) : '—';

  const rows = [
    ['Fan', gpu.fanPercent != null ? `${Math.round(gpu.fanPercent)}%` : '—'],
    ['Load', gpu.utilizationPercent != null ? `${Math.round(gpu.utilizationPercent)}%` : '—'],
    [
      'VRAM',
      gpu.memoryTotalMb
        ? `${((gpu.memoryUsedMb || 0) / 1024).toFixed(1)} / ${(gpu.memoryTotalMb / 1024).toFixed(1)} GB`
        : '—',
    ],
    ['Power', gpu.powerW != null ? `${gpu.powerW.toFixed(0)} W` : '—'],
  ];

  $('#gpu-stats').innerHTML = rows
    .map(([label, value]) => `<div class="kv-row"><span>${label}</span><span>${esc(value)}</span></div>`)
    .join('');

  const util = Math.min(100, Math.max(0, gpu.utilizationPercent ?? 0));
  const bar = $('#gpu-util-bar');
  bar.style.width = `${util}%`;
  bar.dataset.level = level(util);
}

/* ------------------------------------------------------------------- disk */

function renderDiskRoots() {
  const roots = state.config?.diskRoots || [];
  const select = $('#disk-root');
  select.innerHTML = roots.map((root) => `<option value="${esc(root)}">${esc(root)}</option>`).join('');
  if (roots.length) select.value = state.disk.root || roots[0];
}

function bindDisk() {
  $('#disk-root').addEventListener('change', (event) => {
    state.disk.root = event.target.value;
    loadDisk(state.disk.root, { refresh: true });
  });

  $('#disk-rescan').addEventListener('click', () => {
    if (state.disk.path) loadDisk(state.disk.path, { refresh: true });
  });
}

function setDiskBusy(busy) {
  state.disk.busy = busy;
  $('#disk-progress').hidden = !busy;
  $('#disk-rescan').disabled = busy;
}

function updateProgress(progress) {
  if (!progress) return;
  $('#disk-progress-text').textContent = `${fmtBytes(progress.bytes)} measured · ${progress.files.toLocaleString()} files · ${progress.dirs.toLocaleString()} folders`;
}

function resetDiskPanel(message) {
  state.disk.tree = null;
  state.disk.path = '';
  $('#treemap').innerHTML = `<p class="empty">${esc(message)}</p>`;
  $('#disk-children').innerHTML = '';
  $('#crumbs').innerHTML = '';
  $('#disk-total').textContent = '';
  $('#disk-note').hidden = true;
}

async function loadDisk(target, { refresh = false } = {}) {
  if (!target) {
    resetDiskPanel('No drives were detected. Add one in Settings, or in config.json.');
    return;
  }

  clearTimeout(state.disk.poll);
  setDiskBusy(true);

  try {
    const result = await api('/api/disk/scan', {
      method: 'POST',
      body: JSON.stringify({ path: target, refresh }),
    });

    if (result.state === 'done' && result.tree) {
      applyTree(result.tree);
      setDiskBusy(false);
      return;
    }

    state.disk.jobId = result.id;
    updateProgress(result.progress);
    pollScan(result.id);
  } catch (error) {
    setDiskBusy(false);
    $('#treemap').innerHTML = `<p class="empty">${esc(error.message)}</p>`;
    showToast(error.message, 'error');
  }
}

function pollScan(id) {
  state.disk.poll = setTimeout(async () => {
    try {
      const job = await api(`/api/disk/scan?id=${encodeURIComponent(id)}`);
      updateProgress(job.progress);

      if (job.state === 'queued' || job.state === 'running') {
        pollScan(id);
        return;
      }

      if (job.state === 'error') {
        setDiskBusy(false);
        $('#treemap').innerHTML = `<p class="empty">${esc(job.error || 'Scan failed.')}</p>`;
        return;
      }

      applyTree(job.tree);
      setDiskBusy(false);
    } catch (error) {
      setDiskBusy(false);
      showToast(error.message, 'error');
    }
  }, 700);
}

function applyTree(tree) {
  state.disk.tree = tree;
  state.disk.path = tree.path;

  renderCrumbs(tree.path);
  $('#disk-total').textContent = `${fmtBytes(tree.size)} · ${tree.fileCount.toLocaleString()} files${tree.partial ? ' · partial' : ''}`;
  renderTreemap(tree);
  renderChildren(tree);

  const note = $('#disk-note');
  if (tree.partial) {
    note.hidden = false;
    note.textContent = 'This folder was only partly measured (size or time limit reached). Rescan to continue.';
  } else if (tree.omitted > 0) {
    note.hidden = false;
    note.textContent = `${tree.omitted.toLocaleString()} smaller folders are not drawn in the map.`;
  } else {
    note.hidden = true;
  }
}

function renderCrumbs(fullPath) {
  const isWindows = /^[a-zA-Z]:[\\/]/.test(fullPath);
  const parts = fullPath.split(/[\\/]+/).filter(Boolean);
  const crumbs = [];

  parts.forEach((part, index) => {
    const accumulated = isWindows
      ? index === 0
        ? `${part}\\`
        : `${parts.slice(0, index + 1).join('\\')}`
      : `/${parts.slice(0, index + 1).join('/')}`;
    const isLast = index === parts.length - 1;
    crumbs.push(
      `<button type="button" class="crumb${isLast ? ' is-current' : ''}" data-path="${esc(accumulated)}">${esc(part)}</button>`,
    );
    if (!isLast) crumbs.push('<span class="crumb-sep">/</span>');
  });

  const nav = $('#crumbs');
  nav.innerHTML = crumbs.join('');
  nav.querySelectorAll('.crumb:not(.is-current)').forEach((button) => {
    button.addEventListener('click', () => loadDisk(button.dataset.path));
  });
}

function hashHue(text) {
  let hash = 0;
  const value = String(text);
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function tileColor(tile) {
  const theme = document.documentElement.dataset.theme || 'midnight';
  const palette = TILE_PALETTES[theme] || TILE_PALETTES.midnight;
  const base = tile.isDir ? palette.dir : palette.file;
  const hue = base.hue + (hashHue(tile.name) % base.range);
  return `hsl(${hue} ${base.sat}% ${base.light}%)`;
}

function renderTreemap(tree) {
  const container = $('#treemap');
  container.innerHTML = '';

  const items = [
    ...(tree.children || []).map((child) => ({ ...child, isDir: true })),
    ...(tree.files || []).map((file) => ({ ...file, isDir: false, fileCount: 1 })),
  ].filter((item) => item.size > 0);

  if (!items.length) {
    container.innerHTML = '<p class="empty">Nothing measurable here — the folder is empty or unreadable.</p>';
    return;
  }

  const width = container.clientWidth;
  const height = container.clientHeight;
  if (!width || !height) return;

  const sorted = items.sort((a, b) => b.size - a.size);
  const total = tree.size || sorted.reduce((sum, item) => sum + item.size, 0) || 1;
  const tiles = squarify(
    sorted.map((item) => ({ ...item, value: item.size })),
    { x: 0, y: 0, w: width, h: height },
  );

  const fragment = document.createDocumentFragment();

  for (const tile of tiles) {
    const { rect } = tile;
    if (rect.w < 2 || rect.h < 2) continue;

    const node = document.createElement('div');
    node.className = `tile${tile.isDir ? '' : ' is-file'}${rect.w < 64 || rect.h < 34 ? ' is-tiny' : ''}`;
    node.style.left = `${rect.x}px`;
    node.style.top = `${rect.y}px`;
    node.style.width = `${rect.w}px`;
    node.style.height = `${rect.h}px`;
    node.style.background = tileColor(tile);
    node.dataset.path = tile.path;
    node.dataset.name = tile.name;
    node.dataset.size = String(tile.size);
    node.dataset.files = String(tile.fileCount || 0);
    node.dataset.dir = tile.isDir ? '1' : '0';
    node.dataset.total = String(total);
    node.innerHTML = `<span class="tile-name">${esc(tile.name)}</span><span class="tile-size">${fmtBytes(tile.size)}</span>`;

    if (tile.isDir) node.addEventListener('click', () => loadDisk(tile.path));
    node.addEventListener('mousemove', showTileTooltip);
    node.addEventListener('mouseleave', hideTooltip);
    fragment.appendChild(node);
  }

  container.appendChild(fragment);
}

function renderChildren(tree) {
  const box = $('#disk-children');
  const total = tree.size || 1;
  const items = [
    ...(tree.children || []).map((child) => ({ ...child, isDir: true })),
    ...(tree.files || []).map((file) => ({ ...file, isDir: false })),
  ]
    .filter((item) => item.size > 0)
    .sort((a, b) => b.size - a.size);

  if (!items.length) {
    box.innerHTML = '';
    return;
  }

  box.innerHTML = items
    .map((item) => {
      const percent = Math.min(100, (item.size / total) * 100);
      return `<div class="child${item.isDir ? ' is-clickable' : ''}" data-path="${esc(item.path)}">
        <span class="child-name"><span class="child-tag">${item.isDir ? 'dir' : 'file'}</span><span>${esc(item.name)}</span></span>
        <span class="child-bar"><i style="width:${percent.toFixed(1)}%"></i></span>
        <span class="child-size">${fmtBytes(item.size)}</span>
      </div>`;
    })
    .join('');

  box.querySelectorAll('.child.is-clickable').forEach((row) => {
    row.addEventListener('click', () => loadDisk(row.dataset.path));
  });
}

function showTileTooltip(event) {
  const tile = event.currentTarget;
  const tooltip = $('#tooltip');

  if (tooltip.dataset.path !== tile.dataset.path) {
    const size = Number(tile.dataset.size);
    const total = Number(tile.dataset.total) || 1;
    const isDir = tile.dataset.dir === '1';
    const percent = ((size / total) * 100).toFixed(1);
    const fileCount = Number(tile.dataset.files) || 0;

    tooltip.dataset.path = tile.dataset.path;
    tooltip.innerHTML = `<strong>${esc(tile.dataset.name)}</strong><span>${esc(tile.dataset.path)}</span><span>${fmtBytes(size)} · ${percent}% of this folder${isDir ? ` · ${fileCount.toLocaleString()} files` : ''}</span>`;
    tooltip.hidden = false;
  }

  const x = Math.min(event.clientX + 14, window.innerWidth - tooltip.offsetWidth - 12);
  const y = Math.min(event.clientY + 14, window.innerHeight - tooltip.offsetHeight - 12);
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
}

function hideTooltip() {
  const tooltip = $('#tooltip');
  tooltip.hidden = true;
  tooltip.dataset.path = '';
}

/**
 * Squarified treemap: rectangles proportional to size that stay as close to
 * square as the space allows, which is what makes the map readable.
 */
function squarify(items, bounds) {
  const output = [];
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!(total > 0) || bounds.w <= 0 || bounds.h <= 0) return output;

  const scale = (bounds.w * bounds.h) / total;
  const areas = items
    .map((item) => ({ ...item, area: Math.max(item.value * scale, 0.0001) }))
    .filter((item) => item.area > 0);

  const worst = (row, side) => {
    let sum = 0;
    let max = 0;
    let min = Infinity;
    for (const item of row) {
      sum += item.area;
      max = Math.max(max, item.area);
      min = Math.min(min, item.area);
    }
    if (!sum || !side) return Infinity;
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };

  let free = { ...bounds };
  let row = [];
  let index = 0;

  const place = (group) => {
    const sum = group.reduce((accumulator, item) => accumulator + item.area, 0);
    if (!sum) return;

    if (free.w >= free.h) {
      const columnWidth = Math.min(sum / free.h, free.w);
      let y = free.y;
      for (const item of group) {
        const height = (item.area / sum) * free.h;
        output.push({ ...item, rect: { x: free.x, y, w: columnWidth, h: height } });
        y += height;
      }
      free = { x: free.x + columnWidth, y: free.y, w: Math.max(0, free.w - columnWidth), h: free.h };
    } else {
      const rowHeight = Math.min(sum / free.w, free.h);
      let x = free.x;
      for (const item of group) {
        const width = (item.area / sum) * free.w;
        output.push({ ...item, rect: { x, y: free.y, w: width, h: rowHeight } });
        x += width;
      }
      free = { x: free.x, y: free.y + rowHeight, w: free.w, h: Math.max(0, free.h - rowHeight) };
    }
  };

  while (index < areas.length) {
    const side = Math.min(free.w, free.h);
    if (!side || free.w <= 0.5 || free.h <= 0.5) {
      output.push({ ...areas[index], rect: { x: free.x, y: free.y, w: 0, h: 0 } });
      index += 1;
      continue;
    }

    const candidate = [...row, areas[index]];
    if (!row.length || worst(candidate, side) <= worst(row, side)) {
      row = candidate;
      index += 1;
    } else {
      place(row);
      row = [];
    }
  }

  if (row.length) place(row);
  return output;
}

/* ----------------------------------------------------------------- docker */

function bindDocker() {
  $('#docker-refresh').addEventListener('click', () => refreshDocker());
  $('#docker-list').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const { action, name } = button.dataset;
    button.disabled = true;
    button.textContent = '…';

    try {
      const result = await api('/api/docker/action', {
        method: 'POST',
        body: JSON.stringify({ name, action }),
      });
      showToast(result.ok ? `${action} · ${name}` : result.error, result.ok ? 'ok' : 'error');
    } catch (error) {
      showToast(error.message, 'error');
    }

    refreshDocker();
  });
}

async function refreshDocker() {
  lastDockerAt = Date.now();
  try {
    const data = await api('/api/docker');
    state.docker = data;
    renderDocker(data);
  } catch (error) {
    $('#docker-summary').textContent = error.message;
  }
}

function renderDocker(data) {
  const summary = $('#docker-summary');
  const list = $('#docker-list');

  const settingsNote = $('#docker-settings-note');
  if (settingsNote) {
    settingsNote.textContent = data.available
      ? `Docker ${data.version || ''} detected on this PC.`.replace('  ', ' ')
      : data.error || 'Docker is not reachable.';
  }

  if (!data.available) {
    summary.innerHTML = `<span class="pill is-down">offline</span> &nbsp;${esc(data.error || 'Docker is not reachable.')}`;
    list.innerHTML = '<p class="empty">Docker Desktop has to be installed and running for this panel. Everything else keeps working without it.</p>';
    return;
  }

  const running = data.containers.filter((container) => container.state === 'running').length;
  summary.textContent = `${data.version ? `Docker ${data.version} · ` : ''}${data.containers.length} container${data.containers.length === 1 ? '' : 's'} · ${running} running`;

  if (!data.containers.length) {
    list.innerHTML = '<p class="empty">Docker is running but there are no containers yet.</p>';
    return;
  }

  list.innerHTML = data.containers
    .map((container) => {
      const isRunning = container.state === 'running';
      return `<div class="container">
        <div class="container-main">
          <span class="state-dot${isRunning ? ' is-up' : ''}"></span>
          <div class="container-text">
            <p class="container-name">${esc(container.name)}</p>
            <p class="container-meta">${esc(container.image)}${container.ports ? ` · ${esc(container.ports)}` : ''}</p>
          </div>
        </div>
        <div class="container-side">
          <span class="pill${isRunning ? ' is-up' : ' is-down'}">${esc(container.status || container.state)}</span>
          <div class="container-actions">
            <button class="btn btn-sm" type="button" data-action="start" data-name="${esc(container.name)}" ${isRunning ? 'disabled' : ''}>Start</button>
            <button class="btn btn-sm" type="button" data-action="restart" data-name="${esc(container.name)}" ${isRunning ? '' : 'disabled'}>Restart</button>
            <button class="btn btn-sm" type="button" data-action="stop" data-name="${esc(container.name)}" ${isRunning ? '' : 'disabled'}>Stop</button>
          </div>
        </div>
      </div>`;
    })
    .join('');
}

/* ------------------------------------------------------------------- site */

function bindSite() {
  $('#site-refresh').addEventListener('click', () => refreshSites(true));
}

async function refreshSites(force = false) {
  if (!state.config) return;
  try {
    const data = await api(`/api/sites${force ? '?refresh=1' : ''}`);
    state.sites = data.sites || [];
    renderSites(state.sites);
  } catch (error) {
    $('#site-list').innerHTML = `<div class="card"><p class="empty">${esc(error.message)}</p></div>`;
  }
}

function renderSites(sites) {
  const box = $('#site-list');

  if (!sites.length) {
    box.innerHTML = `<div class="card">
      <p class="card-title">No sites yet</p>
      <p class="empty">Add your site in <a href="#settings" data-open-panel="settings">Settings</a> to check it from here.</p>
    </div>`;
    return;
  }

  box.innerHTML = sites
    .map((site) => {
      const status = site.ok ? 'up' : 'down';
      const detail = site.error ? site.error : `HTTP ${site.status}`;
      const links = (site.links || [])
        .map(
          (link) =>
            `<a class="btn btn-sm" href="${esc(link.url)}" target="_blank" rel="noreferrer noopener">${esc(link.label)}</a>`,
        )
        .join('');

      return `<article class="card site-card">
        <div class="card-head">
          <div class="card-heading">
            <p class="card-title">${esc(site.name)}</p>
            <a class="site-url" href="${esc(site.url)}" target="_blank" rel="noreferrer noopener">${esc(site.url)}</a>
          </div>
          <span class="pill is-${status}">${status}</span>
        </div>
        <div class="site-meta">
          <span class="mono">${site.ok ? `${site.latencyMs} ms` : '—'}</span>
          <span>${esc(detail)}</span>
          <span class="muted">checked ${timeAgo(site.checkedAt)}</span>
        </div>
        <div class="site-actions">
          <a class="btn" href="${esc(site.url)}" target="_blank" rel="noreferrer noopener">Open site</a>
          ${site.adminUrl ? `<a class="btn" href="${esc(site.adminUrl)}" target="_blank" rel="noreferrer noopener">Admin</a>` : ''}
          ${links}
        </div>
      </article>`;
    })
    .join('');
}

/* --------------------------------------------------------------- settings */

function bindSettings() {
  $('#settings-save').addEventListener('click', saveSettings);
  $('#settings-save-2').addEventListener('click', saveSettings);
  $('#settings-discard').addEventListener('click', () => loadSettings({ quiet: true }));
  $('#settings-discard-2').addEventListener('click', () => loadSettings({ quiet: true }));

  $('#panel-settings').addEventListener('input', markDirty);
  $('#panel-settings').addEventListener('change', markDirty);

  $('#sites-editor').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.target.tagName === 'TEXTAREA') return;
    event.preventDefault();
    saveSettings();
  });

  $('#helper-install').addEventListener('click', () => installHelper());
  $('#helper-start').addEventListener('click', () => startSensorHelper());

  $('#theme-picker').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-theme]');
    if (!button) return;
    applyTheme(button.dataset.theme);
    markTheme(button.dataset.theme);
    if (state.disk.tree) renderTreemap(state.disk.tree);
  });

  $('#site-add').addEventListener('click', () => {
    const sites = collectSites();
    sites.push({ name: '', url: '', adminUrl: '', links: [] });
    renderSiteRows(sites);
    const rows = $$('.site-edit');
    rows[rows.length - 1]?.querySelector('[data-field="url"]')?.focus();
  });

  $('#sites-editor').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-site]');
    if (!remove) return;
    const row = remove.closest('.site-edit');
    const sites = collectSites();
    sites.splice(Number(row.dataset.index), 1);
    renderSiteRows(sites);
  });

  $('#root-add').addEventListener('click', () => {
    $('#root-add-row').hidden = false;
    $('#root-new').focus();
  });

  $('#root-cancel').addEventListener('click', () => {
    $('#root-add-row').hidden = true;
    $('#root-new').value = '';
  });

  $('#root-confirm').addEventListener('click', () => {
    const value = $('#root-new').value.trim();
    if (!value) return;
    if (!editorRoots.includes(value)) editorRoots.push(value);
    $('#root-new').value = '';
    $('#root-add-row').hidden = true;
    renderRootChips();
  });

  $('#root-new').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('#root-confirm').click();
    }
  });

  $('#roots-editor').addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-root]');
    if (!button) return;
    editorRoots = editorRoots.filter((root) => root !== button.dataset.removeRoot);
    renderRootChips();
  });

  $('#sensors-test').addEventListener('click', testSensors);
}

function setSettingsState(text, kind = '') {
  const bar = $('#settings-bar');
  const status = $('#settings-state');
  status.textContent = text;
  status.className = `settings-bar-state${kind === 'error' ? ' is-error' : ''}`;
  bar.classList.toggle('is-dirty', kind === 'dirty');
}

function markDirty() {
  setSettingsState('Unsaved changes', 'dirty');
}

async function loadSettings({ quiet = false } = {}) {
  try {
    const data = await api('/api/settings');
    applyTheme(data.settings.theme);
    renderSettings(data.settings);
    if (!state.docker) refreshDocker();
    refreshHelper();
    setSettingsState('All changes saved');
    if (!quiet) showToast('Settings reloaded', 'ok');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function refreshHelper() {
  try {
    helperState = await api('/api/helper');
    renderHelper(helperState);
  } catch {
    $('#helper-pill').textContent = 'unknown';
  }
}

function renderHelper(status) {
  const pill = $('#helper-pill');
  const text = $('#helper-text');
  const install = $('#helper-install');
  const start = $('#helper-start');

  if (!status.installed) {
    pill.className = 'pill';
    pill.textContent = 'not installed';
    text.textContent = `Download LibreHardwareMonitor ${status.version} from its official GitHub release (${status.downloadMb} MB) and start it from here.`;
    install.hidden = false;
    install.textContent = `Download helper (${status.downloadMb} MB)`;
    start.hidden = true;
  } else if (status.running) {
    pill.className = 'pill is-up';
    pill.textContent = 'running';
    text.textContent = 'The helper is running. With its web server on, CPU temperatures appear on the overview within a few seconds.';
    install.hidden = true;
    start.hidden = false;
    start.textContent = 'Restart helper';
  } else {
    pill.className = 'pill';
    pill.textContent = 'installed';
    text.textContent = 'Installed. Starting it asks Windows for administrator permission, then you can switch on its web server.';
    install.hidden = true;
    start.hidden = false;
    start.textContent = 'Start helper';
  }
}

async function installHelper() {
  const button = $('#helper-install');
  if (!button || button.disabled) return;

  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Downloading…';
  setSettingsState('Downloading the helper…');

  try {
    const result = await api('/api/helper/install', { method: 'POST' });
    helperState = result.status;
    renderHelper(result.status);
    setSettingsState('Helper downloaded — press Start helper', 'ok');
    showToast('Helper downloaded', 'ok');
  } catch (error) {
    setSettingsState(error.message, 'error');
    showToast(error.message, 'error');
    refreshHelper();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function startSensorHelper() {
  const button = $('#helper-start');
  if (!button || button.disabled) return;

  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Starting…';
  setSettingsState('Waiting for the Windows permission prompt…');

  try {
    const result = await api('/api/helper/start', { method: 'POST' });
    if (result.status) {
      helperState = result.status;
      renderHelper(result.status);
    }

    if (result.ok) {
      setSettingsState('Helper started — enable Options → Remote Web Server, then Test connection', 'ok');
      showToast('Helper started', 'ok');
      setTimeout(refreshHelper, 4000);
      setTimeout(refreshSensors, 6000);
    } else {
      setSettingsState(result.error, 'error');
      showToast(result.error, 'error');
      refreshHelper();
    }
  } catch (error) {
    setSettingsState(error.message, 'error');
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function renderSettings(settings) {
  state.settings = settings;

  $('#theme-picker').innerHTML = THEMES.map(
    (theme) => `<button type="button" class="theme-option${settings.theme === theme.id ? ' is-active' : ''}" data-theme="${theme.id}">
      <span class="theme-swatch" data-swatch="${theme.id}"></span>
      <span class="theme-name">${theme.label}<small>${theme.detail}</small></span>
    </button>`,
  ).join('');

  $('#sensors-enabled').checked = settings.sensors.enabled;
  $('#sensors-url').value = settings.sensors.url;

  const helperLive = Boolean(state.sensors?.sources?.libreHardwareMonitor);
  const status = $('#sensors-status');
  status.className = `setting-status${helperLive ? ' is-ok' : ''}`;
  status.textContent = helperLive
    ? 'Connected to the helper'
    : settings.sensors.enabled
      ? 'No helper answering yet'
      : 'Helper disabled';

  $('#sensor-settings-status').textContent = helperLive
    ? `${state.sensors.temperatures.length} temperature sensors live`
    : 'Windows hides these from normal apps';

  $('#docker-enabled').checked = settings.docker.enabled;
  const dockerSelect = $('#docker-interval');
  if (!Array.from(dockerSelect.options).some((option) => option.value === String(settings.docker.refreshMs))) {
    dockerSelect.append(new Option(`${Math.round(settings.docker.refreshMs / 1000)} seconds`, String(settings.docker.refreshMs)));
  }
  dockerSelect.value = String(settings.docker.refreshMs);

  $('#docker-settings-note').textContent = state.docker?.available
    ? `Docker ${state.docker.version || ''} detected on this PC.`.replace(/\s+/g, ' ').trim()
    : state.docker?.error || 'Checking Docker…';

  renderSiteRows(settings.sites || []);
  renderRoots(settings.diskRoots || []);
}

function renderSiteRows(sites) {
  const box = $('#sites-editor');

  if (!sites.length) {
    box.innerHTML = '<p class="empty">No sites yet. Add one to check its uptime from here.</p>';
    return;
  }

  box.innerHTML = sites
    .map(
      (site, index) => `<div class="site-edit" data-index="${index}">
        <div class="site-edit-head">
          <span class="setting-label">Site ${index + 1}</span>
          <button class="btn btn-sm" type="button" data-remove-site>Remove</button>
        </div>
        <div class="site-edit-grid">
          <div class="field">
            <label>Name</label>
            <input class="input" data-field="name" value="${esc(site.name)}" placeholder="My site" />
          </div>
          <div class="field">
            <label>URL</label>
            <input class="input mono" data-field="url" value="${esc(site.url)}" placeholder="https://example.com" spellcheck="false" />
          </div>
          <div class="field">
            <label>Admin URL <span>optional</span></label>
            <input class="input mono" data-field="adminUrl" value="${esc(site.adminUrl)}" placeholder="https://example.com/admin" spellcheck="false" />
          </div>
          <div class="field field-wide">
            <label>Quick links <span>one per line — label | url</span></label>
            <textarea class="input mono" data-field="links" rows="2" spellcheck="false">${esc(
              (site.links || []).map((link) => `${link.label} | ${link.url}`).join('\n'),
            )}</textarea>
          </div>
        </div>
      </div>`,
    )
    .join('');
}

function collectSites() {
  return $$('.site-edit').map((row) => {
    const value = (name) => row.querySelector(`[data-field="${name}"]`)?.value.trim() || '';
    return {
      name: value('name'),
      url: normalizeUrl(value('url')),
      adminUrl: normalizeUrl(value('adminUrl')),
      links: parseLinks(value('links')),
    };
  });
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  return `https://${raw.replace(/^\/+/, '')}`;
}

function parseLinks(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf('|');
      const label = index === -1 ? line : line.slice(0, index).trim();
      const url = (index === -1 ? line : line.slice(index + 1)).trim();
      if (!/^https?:\/\//i.test(url)) return null;
      return { label: (label || url).slice(0, 60), url };
    })
    .filter(Boolean);
}

function renderRoots(roots) {
  editorRoots = [...roots];
  renderRootChips();
}

function renderRootChips() {
  const box = $('#roots-editor');
  box.innerHTML = editorRoots.length
    ? editorRoots
        .map(
          (root) =>
            `<span class="chip">${esc(root)}<button type="button" data-remove-root="${esc(root)}" aria-label="Remove ${esc(root)}">×</button></span>`,
        )
        .join('')
    : '<p class="empty">No drives listed. Add at least one so the disk map can read it.</p>';
}

async function testSensors() {
  const status = $('#sensors-status');
  const url = $('#sensors-url').value.trim();
  status.className = 'setting-status';
  status.textContent = 'Testing…';

  try {
    const result = await api('/api/sensors/test', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });

    if (result.ok) {
      status.className = 'setting-status is-ok';
      const sample = result.samples.length ? ` (${result.samples.slice(0, 2).join(', ')})` : '';
      status.textContent = `Connected · ${result.temperatures} temperatures, ${result.fans} fans${sample}`;
    } else {
      status.className = 'setting-status is-error';
      status.textContent = result.error || 'No response from that URL';
    }
  } catch (error) {
    status.className = 'setting-status is-error';
    status.textContent = error.message;
  }
}

async function saveSettings() {
  const payload = {
    theme: document.documentElement.dataset.theme || 'midnight',
    sites: collectSites().filter((site) => site.url),
    docker: {
      enabled: $('#docker-enabled').checked,
      refreshMs: Number($('#docker-interval').value),
    },
    sensors: {
      enabled: $('#sensors-enabled').checked,
      url: $('#sensors-url').value.trim(),
    },
    diskRoots: editorRoots,
  };

  try {
    const result = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });

    const settings = result.settings;
    state.settings = settings;

    state.config.theme = settings.theme;
    state.config.sites = settings.sites;
    state.config.diskRoots = settings.diskRoots;
    state.config.dockerEnabled = settings.docker.enabled;
    state.config.dockerRefreshMs = settings.docker.refreshMs;

    const previousRoot = state.disk.root;
    state.disk.root = settings.diskRoots.includes(previousRoot) ? previousRoot : settings.diskRoots[0];
    renderDiskRoots();

    if (state.disk.path && !isInsideRoots(state.disk.path, settings.diskRoots)) {
      resetDiskPanel('That folder is no longer in the drive list. Pick a drive to map it.');
    } else if (state.disk.tree) {
      renderTreemap(state.disk.tree);
    }

    applyTheme(settings.theme);
    renderSettings(settings);
    setSettingsState('Saved to config.json', 'ok');

    refreshSensors();
    refreshSites(true);
    if (state.panel === 'docker') refreshDocker();

    showToast('Settings saved to config.json', 'ok');
  } catch (error) {
    setSettingsState(error.message, 'error');
    showToast(error.message, 'error');
  }
}

function isInsideRoots(target, roots) {
  const value = String(target).toLowerCase();
  return roots.some((root) => {
    const base = String(root).toLowerCase();
    const prefix = base.endsWith('\\') || base.endsWith('/') ? base : `${base}\\`;
    return value === base || value.startsWith(prefix) || value.startsWith(base);
  });
}

/* ------------------------------------------------------------------ start */

function storedTheme() {
  try {
    return localStorage.getItem('pcdeck.theme');
  } catch {
    // Opaque origins (the desktop shell) have no storage; config.json carries the theme there.
    return null;
  }
}

applyTheme(storedTheme() || 'midnight');

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
