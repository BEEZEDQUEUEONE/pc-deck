const CACHE_TTL_MS = 45000;
const cache = new Map();

function describeError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'Timed out after 7s';
  const code = error?.cause?.code || error?.code;
  if (code === 'ENOTFOUND') return 'DNS lookup failed';
  if (code === 'ECONNREFUSED') return 'Connection refused';
  if (code === 'ECONNRESET') return 'Connection reset';
  if (code === 'CERT_HAS_EXPIRED') return 'TLS certificate expired';
  if (code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') return 'TLS certificate not trusted';
  return String(error?.message || error).slice(0, 160);
}

async function probeSite(site) {
  const startedAt = performance.now();
  const base = {
    name: site.name,
    url: site.url,
    adminUrl: site.adminUrl,
    links: site.links,
    checkedAt: Date.now(),
  };

  try {
    const response = await fetch(site.url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(7000),
      headers: { 'user-agent': 'pc-deck/0.1 (local dashboard)', accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    try {
      await response.body?.cancel();
    } catch {
      /* body already gone */
    }
    return { ...base, ok: response.ok, status: response.status, latencyMs, error: null };
  } catch (error) {
    return {
      ...base,
      ok: false,
      status: 0,
      latencyMs: Math.round(performance.now() - startedAt),
      error: describeError(error),
    };
  }
}

export async function checkSites(sites, { force = false } = {}) {
  const now = Date.now();
  return Promise.all(
    sites.map(async (site) => {
      const cached = cache.get(site.url);
      if (!force && cached && now - cached.at < CACHE_TTL_MS) return cached.result;
      const result = await probeSite(site);
      cache.set(site.url, { at: Date.now(), result });
      return result;
    }),
  );
}
