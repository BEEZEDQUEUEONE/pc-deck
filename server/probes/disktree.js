import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILES = 1500000;
const MAX_DIRS = 400000;
const TIME_BUDGET_MS = 120000;
const MAX_CHILDREN = 240;
const TOP_FILES = 14;
const CACHE_TTL_MS = 10 * 60 * 1000;
const JOB_TTL_MS = 15 * 60 * 1000;

const cache = new Map();
const jobs = new Map();

export function validateScanPath(input, roots) {
  if (typeof input !== 'string' || !input.trim()) {
    throw Object.assign(new Error('A folder path is required'), { statusCode: 400 });
  }

  const resolved = path.resolve(input.trim());
  const lower = resolved.toLowerCase();

  const allowed = roots.some((root) => {
    const base = path.resolve(root).toLowerCase();
    const prefix = base.endsWith(path.sep) ? base : base + path.sep;
    return lower === base || lower.startsWith(prefix);
  });

  if (!allowed) {
    throw Object.assign(new Error('That path is outside the configured disk roots'), { statusCode: 403 });
  }

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw Object.assign(new Error('That folder does not exist or cannot be read'), { statusCode: 404 });
  }
  if (!stat.isDirectory()) {
    throw Object.assign(new Error('That path is not a folder'), { statusCode: 400 });
  }

  return resolved;
}

function starved(job, deadline) {
  return job.cancelled || Date.now() > deadline || job.progress.files > MAX_FILES || job.progress.dirs > MAX_DIRS;
}

/** Bounds outstanding file system calls so a huge folder cannot flood the machine. */
function createLimiter(max) {
  let active = 0;
  const queue = [];

  const pump = () => {
    while (active < max && queue.length) {
      const { task, resolve, reject } = queue.shift();
      active += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
}

const limitStat = createLimiter(32);
const limitRead = createLimiter(12);

async function fileSize(filePath) {
  return limitStat(async () => {
    try {
      const stat = await fs.promises.lstat(filePath);
      return stat.isFile() ? stat.size : 0;
    } catch {
      return 0;
    }
  });
}

function keepLargest(list, entry, limit) {
  if (entry.size <= 0) return;
  if (list.length < limit) {
    list.push(entry);
    list.sort((a, b) => b.size - a.size);
    return;
  }
  if (entry.size <= list[list.length - 1].size) return;
  list[list.length - 1] = entry;
  list.sort((a, b) => b.size - a.size);
}

async function walk(dirPath, depth, job, deadline) {
  const node = {
    name: path.basename(dirPath) || dirPath,
    path: dirPath,
    size: 0,
    fileCount: 0,
    children: [],
    topFiles: [],
  };

  if (starved(job, deadline)) {
    job.aborted = true;
    return node;
  }

  let entries;
  try {
    entries = await limitRead(() => fs.promises.readdir(dirPath, { withFileTypes: true }));
    job.progress.dirs += 1;
  } catch {
    job.progress.errors += 1;
    return node;
  }

  const directories = [];
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // junctions would double count or loop forever
    if (entry.isDirectory()) directories.push(entry.name);
    else if (entry.isFile()) files.push(entry.name);
  }

  for (let i = 0; i < files.length; i += 64) {
    if (starved(job, deadline)) {
      job.aborted = true;
      break;
    }
    const chunk = files.slice(i, i + 64);
    const sizes = await Promise.all(chunk.map((name) => fileSize(path.join(dirPath, name))));

    for (let j = 0; j < chunk.length; j += 1) {
      const size = sizes[j];
      node.size += size;
      if (size > 0) node.fileCount += 1;
      job.progress.files += 1;
      job.progress.bytes += size;
      if (depth === 0 && size > 0) {
        keepLargest(node.topFiles, { name: chunk[j], path: path.join(dirPath, chunk[j]), size }, TOP_FILES);
      }
    }
  }

  // A few branches at a time keeps the file system queue busy without
  // opening thousands of handles on a big drive.
  const BRANCHES = 6;
  for (let i = 0; i < directories.length; i += BRANCHES) {
    if (starved(job, deadline)) {
      job.aborted = true;
      break;
    }
    const batch = directories.slice(i, i + BRANCHES);
    const children = await Promise.all(
      batch.map((name) => walk(path.join(dirPath, name), depth + 1, job, deadline)),
    );
    for (const child of children) {
      node.size += child.size;
      node.fileCount += child.fileCount;
      if (depth === 0) {
        node.children.push({
          name: child.name,
          path: child.path,
          size: child.size,
          fileCount: child.fileCount,
        });
      }
    }
  }

  return node;
}

function buildTree(root, job, durationMs) {
  const directories = root.children.filter((child) => child.size > 0).sort((a, b) => b.size - a.size);
  return {
    name: root.name,
    path: root.path,
    size: root.size,
    fileCount: root.fileCount,
    partial: job.aborted,
    durationMs,
    counts: { ...job.progress },
    omitted: Math.max(0, directories.length - MAX_CHILDREN),
    children: directories.slice(0, MAX_CHILDREN),
    files: root.topFiles.sort((a, b) => b.size - a.size),
  };
}

function prune() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
  }
  for (const [key, entry] of cache) {
    if (Date.now() - entry.at > CACHE_TTL_MS) cache.delete(key);
  }
}

async function executeJob(job) {
  const deadline = Date.now() + TIME_BUDGET_MS;
  job.state = 'running';
  job.startedAt = Date.now();

  try {
    const root = await walk(job.path, 0, job, deadline);
    job.tree = buildTree(root, job, Date.now() - job.startedAt);
    job.state = 'done';
    if (!job.aborted) cache.set(job.path.toLowerCase(), { at: Date.now(), tree: job.tree });
  } catch (error) {
    job.state = 'error';
    job.error = String(error?.message || error);
  } finally {
    job.finishedAt = Date.now();
    prune();
  }
}

function publicJob(job) {
  return {
    id: job.id,
    path: job.path,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: { ...job.progress },
    tree: job.tree,
    error: job.error,
  };
}

export function startScan(target, { refresh = false } = {}) {
  const key = target.toLowerCase();

  if (!refresh) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { state: 'done', cached: true, path: target, tree: cached.tree };
    }
  }

  for (const job of jobs.values()) {
    if (job.path.toLowerCase() === key && job.state === 'running') return publicJob(job);
  }

  const job = {
    id: crypto.randomUUID(),
    path: target,
    state: 'queued',
    startedAt: Date.now(),
    finishedAt: null,
    progress: { files: 0, dirs: 0, bytes: 0, errors: 0 },
    aborted: false,
    cancelled: false,
    tree: null,
    error: null,
  };

  jobs.set(job.id, job);
  executeJob(job).catch(() => {
    job.state = 'error';
    job.error = 'Scan failed unexpectedly';
    job.finishedAt = Date.now();
  });

  return publicJob(job);
}

export function getScan(id) {
  const job = jobs.get(String(id || ''));
  if (job) return publicJob(job);
  return null;
}
