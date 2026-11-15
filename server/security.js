/**
 * The dashboard is a loopback-only tool. These helpers keep it that way:
 *  - the server binds to 127.0.0.1 (see index.js), so nothing remote can connect
 *  - requests whose Host header is not loopback are rejected (DNS rebinding)
 *  - state-changing requests must come from the dashboard's own origin
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function stripPort(hostHeader) {
  const value = String(hostHeader || '').trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.lastIndexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

export function requestIsLoopback(req) {
  const raw = String(req.headers.host || '').toLowerCase();
  if (!raw) return false;
  const host = stripPort(raw);
  if (!LOOPBACK_HOSTS.has(host)) return false;
  const port = raw.includes(']') ? raw.slice(raw.indexOf(']') + 1).replace(':', '') : raw.split(':')[1];
  if (port && !/^\d+$/.test(port)) return false;
  return true;
}

export function originIsAllowed(req, port) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetches and address-bar loads send no Origin
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  if (String(parsed.port || '80') !== String(port)) return false;
  return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
}

export const baseHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export const pageHeaders = {
  ...baseHeaders,
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '),
  'Cache-Control': 'no-store',
};
