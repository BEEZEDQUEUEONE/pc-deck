import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { projectRoot } from '../config.js';
import { run } from '../util/run.js';

/**
 * Optional sensor helper.
 *
 * Windows will not hand CPU temperatures to a normal user process, so the
 * dashboard can fetch LibreHardwareMonitor from its official GitHub release and
 * launch it for you. Everything lives inside the project folder, and Windows
 * asks for administrator permission for the helper itself — the dashboard never
 * runs elevated.
 */

const VERSION = '0.9.6';
const DOWNLOAD_URL = `https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/download/v${VERSION}/LibreHardwareMonitor.zip`;
const EXPECTED_SHA256 = '086d9f1b5a99e643edc2cfaaac16051685b551e4c5ac0b32a57c58c0e529c001';
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;

const toolsDir = path.join(projectRoot, 'tools');
const helperDir = path.join(toolsDir, 'libre-hardware-monitor');
const helperExe = path.join(helperDir, 'LibreHardwareMonitor.exe');
const zipPath = path.join(toolsDir, 'libre-hardware-monitor.zip');

let installing = false;
let runningCache = { at: 0, value: false };

function helperIsRunning() {
  const now = Date.now();
  if (now - runningCache.at < 5000) return runningCache.value;

  return run(
    'tasklist',
    ['/FI', 'IMAGENAME eq LibreHardwareMonitor.exe', '/NH'],
    { timeoutMs: 5000 },
  ).then((result) => {
    const value = result.ok && /LibreHardwareMonitor\.exe/i.test(result.stdout);
    runningCache = { at: Date.now(), value };
    return value;
  });
}

export async function helperStatus() {
  const installed = existsSync(helperExe);
  return {
    version: VERSION,
    installed,
    running: installed ? await helperIsRunning() : false,
    directory: installed ? helperDir : null,
    downloadMb: 6.3,
  };
}

export async function installHelper() {
  if (installing) {
    throw Object.assign(new Error('The helper is already downloading.'), { statusCode: 409 });
  }
  if (existsSync(helperExe)) return helperStatus();

  installing = true;
  try {
    mkdirSync(helperDir, { recursive: true });

    const response = await fetch(DOWNLOAD_URL, {
      redirect: 'follow',
      signal: AbortSignal.timeout(180000),
      headers: { 'user-agent': 'pc-deck/0.1 (+local dashboard)' },
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('The download was empty.');
    if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error('The download was larger than expected.');

    const digest = createHash('sha256').update(buffer).digest('hex');
    if (digest !== EXPECTED_SHA256) {
      throw new Error('The downloaded helper did not match the expected checksum, so it was discarded.');
    }

    writeFileSync(zipPath, buffer);

    const extracted = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Expand-Archive -LiteralPath $env:PC_DECK_ZIP -DestinationPath $env:PC_DECK_DIR -Force',
      ],
      {
        timeoutMs: 180000,
        env: { ...process.env, PC_DECK_ZIP: zipPath, PC_DECK_DIR: helperDir },
      },
    );

    if (!extracted.ok) {
      throw new Error(extracted.stderr.split(/\r?\n/).find((line) => line.trim()) || 'Could not unpack the helper.');
    }
    if (!existsSync(helperExe)) {
      throw new Error('The helper archive did not contain LibreHardwareMonitor.exe.');
    }

    return helperStatus();
  } finally {
    installing = false;
    rmSync(zipPath, { force: true });
  }
}

export async function startHelper() {
  if (!existsSync(helperExe)) {
    throw Object.assign(new Error('Download the helper first.'), { statusCode: 400 });
  }

  const launched = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'Start-Process -FilePath $env:PC_DECK_HELPER -WorkingDirectory $env:PC_DECK_HELPER_DIR -Verb RunAs',
    ],
    {
      timeoutMs: 20000,
      env: { ...process.env, PC_DECK_HELPER: helperExe, PC_DECK_HELPER_DIR: helperDir },
    },
  );

  runningCache.at = 0;

  if (!launched.ok) {
    const line = launched.stderr.split(/\r?\n/).find((row) => row.trim());
    return {
      ok: false,
      error:
        line && !/cancel/i.test(line)
          ? line.slice(0, 240)
          : 'The helper was not started. Windows asks for administrator permission — approve it to continue.',
      status: await helperStatus(),
    };
  }

  return { ok: true, status: await helperStatus() };
}

/** Used by the tests to clean up without touching the user's install. */
export function helperPaths() {
  return { toolsDir, helperDir, helperExe };
}
