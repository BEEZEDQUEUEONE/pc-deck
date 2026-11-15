import { spawn } from 'node:child_process';

/**
 * Run a command with an argument array (never a shell string), a timeout and a
 * capped output buffer. Resolves instead of rejecting so callers can treat a
 * missing tool as normal, uninteresting state.
 */
export function run(command, args, options = {}) {
  const { timeoutMs = 10000, maxOutput = 2_000_000, env } = options;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(env ? { env } : {}),
      });
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(error?.message || error) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ ok: false, code: -1, stdout, stderr: `${stderr}\n[timed out after ${timeoutMs}ms]`, timedOut: true });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > maxOutput) stdout = stdout.slice(-maxOutput);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 60_000) stderr = stderr.slice(-60_000);
    });
    child.on('error', (error) => finish({ ok: false, code: -1, stdout, stderr: String(error?.message || error) }));
    child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }));
  });
}
