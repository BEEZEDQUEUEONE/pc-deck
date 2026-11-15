import fs from 'node:fs';
import os from 'node:os';

const state = {
  cpuUsage: 0,
  perCore: [],
  lastTimes: null,
  volumes: [],
  volumesAt: 0,
};

function coreTimes() {
  return os.cpus().map((core) => ({ ...core.times }));
}

function computeCpu() {
  const cores = os.cpus();
  if (!cores.length) return;

  if (!state.lastTimes) {
    state.lastTimes = coreTimes();
    return;
  }

  const perCore = [];
  for (let i = 0; i < cores.length; i += 1) {
    const now = cores[i].times;
    const before = state.lastTimes[i] || now;
    const delta = {
      user: Math.max(0, now.user - before.user),
      nice: Math.max(0, now.nice - before.nice),
      sys: Math.max(0, now.sys - before.sys),
      irq: Math.max(0, now.irq - before.irq),
      idle: Math.max(0, now.idle - before.idle),
    };
    const total = delta.user + delta.nice + delta.sys + delta.irq + delta.idle;
    const busy = delta.user + delta.nice + delta.sys + delta.irq;
    perCore.push(total > 0 ? Math.round((busy / total) * 1000) / 10 : 0);
  }

  state.lastTimes = coreTimes();
  state.perCore = perCore;
  state.cpuUsage = Math.round((perCore.reduce((a, b) => a + b, 0) / perCore.length) * 10) / 10;
}

function readVolumes(roots) {
  const volumes = [];
  if (typeof fs.statfsSync !== 'function') {
    state.volumes = volumes;
    return;
  }

  for (const root of roots) {
    try {
      const stats = fs.statfsSync(root);
      const total = Number(stats.bsize) * Number(stats.blocks);
      const free = Number(stats.bsize) * Number(stats.bavail);
      if (!Number.isFinite(total) || total <= 0) continue;
      const used = Math.max(0, total - free);
      volumes.push({
        name: root.replace(/[\\/]+$/, '') || root,
        root,
        total,
        free,
        used,
        usage: Math.round((used / total) * 1000) / 10,
      });
    } catch {
      /* a drive that is not ready is not an error worth showing */
    }
  }

  state.volumes = volumes;
  state.volumesAt = Date.now();
}

export function startSystemProbe(config) {
  computeCpu();
  readVolumes(config.diskRoots);
  setInterval(computeCpu, 1000);
  setInterval(() => readVolumes(config.diskRoots), 20000);
}

export function getSystemSnapshot() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = Math.max(0, total - free);
  const cpus = os.cpus();

  return {
    host: os.hostname(),
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    node: process.version,
    uptimeSec: Math.round(os.uptime()),
    cpu: {
      model: cpus[0]?.model?.trim() || 'Unknown CPU',
      cores: os.availableParallelism ? os.availableParallelism() : cpus.length,
      threads: cpus.length,
      speedMhz: cpus[0]?.speed || 0,
      usage: state.cpuUsage,
      perCore: state.perCore,
    },
    memory: {
      total,
      free,
      used,
      usage: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    },
    volumes: state.volumes,
    dashboard: {
      rss: process.memoryUsage().rss,
      startedAt: Date.now() - Math.round(process.uptime() * 1000),
    },
    sampledAt: Date.now(),
  };
}
