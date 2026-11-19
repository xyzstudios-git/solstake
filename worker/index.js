import { METHODS, SECURITY_HEADERS, MAX_BODY_BYTES, UPSTREAM_TIMEOUT_MS } from '../server/rpc-policy.js';

async function readBounded(body, limit, timeoutMs) {
  if (!body) return '';
  const reader = body.getReader();
  let timer;
  const read = async () => {
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { void reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  };
  try {
    return await Promise.race([
      read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Read timeout')), timeoutMs); }),
    ]);
  } catch (error) {
    // Cancellation must not retain the concurrency slot, even if it never settles.
    void reader.cancel().catch(() => {});
    throw error;
  } finally { clearTimeout(timer); }
}

/** Public runtime. Limits are per isolate; provider-side quota remains necessary. */
export function createWorker({
  assets = {}, fetchImpl = (...args) => fetch(...args), now = () => Date.now(),
  maxBodyBytes = MAX_BODY_BYTES, maxResponseBytes = 8 * 1024 * 1024,
  requestsPerMinute = 180, maxConcurrent = 4, maxClients = 2000, bodyTimeoutMs = 5000,
} = {}) {
  const clients = new Map();
  let active = 0;
  const response = (status, body, type = 'text/plain; charset=utf-8', extra = {}) => new Response(body, {
    status, headers: { ...SECURITY_HEADERS, 'Strict-Transport-Security': 'max-age=31536000', 'Content-Type': type, ...extra },
  });
  const error = (status, message, id = null, extra = {}) => response(status,
    JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32600, message } }), 'application/json; charset=utf-8', extra);

  return {
    async fetch(request, env = {}) {
      try {
        const url = new URL(request.url);
        const origins = String(env.SOLSTAKE_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        if (!origins.length) return response(503, 'Site configuration unavailable');
        if (url.protocol !== 'https:' || !origins.includes(url.origin)) return response(403, 'Unknown host');
        if (url.pathname !== '/rpc') {
          if (!['GET', 'HEAD'].includes(request.method)) return response(405, 'Method not allowed');
          if (request.headers.get('sec-fetch-site') === 'cross-site' && request.headers.get('sec-fetch-mode') !== 'navigate') return response(403, 'Forbidden');
          let path;
          try { path = decodeURIComponent(url.pathname); } catch { return response(400, 'Invalid path'); }
          if (path.includes('\0')) return response(400, 'Invalid path');
          const asset = Object.hasOwn(assets, path === '/' ? '/index.html' : path) ? assets[path === '/' ? '/index.html' : path] : null;
          if (!asset) return response(404, 'Not found');
          const bytes = request.method === 'HEAD' ? null : Uint8Array.from(atob(asset.base64), (c) => c.charCodeAt(0));
          return response(200, bytes, asset.type);
        }
        if (request.method !== 'POST') return error(405, 'POST only');
        const fetchSite = request.headers.get('sec-fetch-site');
        if (request.headers.get('origin') !== url.origin || (fetchSite && fetchSite !== 'same-origin')) return error(403, 'Only this site may use this endpoint');
        if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return error(415, 'JSON only');
        let upstreamUrl;
        try {
          upstreamUrl = new URL(env.SOLSTAKE_RPC_URL);
          if (upstreamUrl.protocol !== 'https:' || upstreamUrl.username || upstreamUrl.password) throw new Error('Invalid upstream');
        } catch { return error(503, 'Solana RPC configuration unavailable'); }

        const timestamp = now();
        // Cloudflare overwrites this header; never use arbitrary X-Forwarded-For.
        const client = request.headers.get('cf-connecting-ip') ?? 'unknown';
        let bucket = clients.get(client);
        if (!bucket || timestamp >= bucket.until) {
          for (const [key, value] of clients) if (timestamp >= value.until) clients.delete(key);
          // Do not evict live buckets: rotating IPs must not reset an existing quota.
          if (!clients.has(client) && clients.size >= maxClients) return error(429, 'Server busy. Try again shortly.', null, { 'Retry-After': '60' });
          bucket = { count: 0, until: timestamp + 60_000 };
          clients.set(client, bucket);
        }
        if (++bucket.count > requestsPerMinute || active >= maxConcurrent) return error(429, 'Too many requests. Try again shortly.', null, { 'Retry-After': String(Math.max(1, Math.ceil((bucket.until - timestamp) / 1000))) });
        active++;
        try {
          if (Number(request.headers.get('content-length')) > maxBodyBytes) return error(413, 'Request too large');
          let raw;
          try { raw = await readBounded(request.body, maxBodyBytes, bodyTimeoutMs); }
          catch { return error(408, 'Request body timed out'); }
          if (raw === null) return error(413, 'Request too large');
          let payload;
          try { payload = JSON.parse(raw); } catch { return error(400, 'Invalid JSON'); }
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return error(400, 'Only individual requests are supported');
          const id = typeof payload.id === 'number' || typeof payload.id === 'string' ? payload.id : null;
          const check = Object.hasOwn(METHODS, payload.method) ? METHODS[payload.method] : null;
          if (!check) return error(403, 'Method not allowed', id);
          const params = payload.params ?? [];
          if (!Array.isArray(params) || !check(params)) return error(400, 'Parameters not allowed', id);
          try {
            const upstream = await fetchImpl(upstreamUrl.toString(), {
              method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id, method: payload.method, params }),
              signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            });
            if (!upstream.ok || !/^application\/json\b/i.test(upstream.headers.get('content-type') ?? '')) {
              console.warn('Solstake RPC HTTP failure', upstream.status);
              void upstream.body?.cancel().catch(() => {});
              return error(502, 'Solana RPC unavailable', id);
            }
            const text = await readBounded(upstream.body, maxResponseBytes, UPSTREAM_TIMEOUT_MS);
            if (text === null) return error(502, 'Solana RPC response too large', id);
            // Never expose provider diagnostic strings, paths or API keys.
            const data = JSON.parse(text);
            if (!data || typeof data !== 'object' || Array.isArray(data)) return error(502, 'Invalid Solana RPC response', id);
            if (data.error) {
              const code = Number.isInteger(data.error.code) ? data.error.code : -32603;
              return response(200, JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: 'Solana RPC rejected the request. Reload and try again.' } }), 'application/json; charset=utf-8');
            }
            if (!Object.hasOwn(data, 'result')) return error(502, 'Invalid Solana RPC response', id);
            return response(200, JSON.stringify({ jsonrpc: '2.0', id, result: data.result }), 'application/json; charset=utf-8');
          } catch { return error(502, 'Solana RPC unavailable', id); }
        } finally { active--; }
      } catch { return response(500, 'Server error'); }
    },
  };
}
