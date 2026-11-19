#!/usr/bin/env node
// Leergut lokal: liefert die Seite aus und reicht erlaubte Solana-Anfragen an den RPC weiter.
// Der Proxy ist nötig, weil öffentliche RPCs Kontoabfragen aus dem Browser sperren, und er hält
// einen eigenen RPC-Schlüssel (LEERGUT_RPC_URL) aus dem Browser heraus.
//
//   node serve.mjs                         → http://127.0.0.1:8790
//   LEERGUT_RPC_URL=https://… node serve.mjs   (z. B. Helius mit Schlüssel)
//
// Gedacht für den eigenen Rechner. Für öffentliches Hosting fehlen noch Ratenbegrenzung je Nutzer
// und ein Host, der die Sicherheits-Header setzt (siehe README).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_DIR = fileURLToPath(new URL('./site/', import.meta.url));
export const DEFAULT_UPSTREAM = 'https://api.mainnet-beta.solana.com';
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 45_000;

const isText = (value, max = 100) => typeof value === 'string' && value.length > 0 && value.length <= max;
const isList = (value, max) => Array.isArray(value) && value.length > 0 && value.length <= max && value.every((v) => isText(v));
const optionsOnly = (value, allowed) => value === undefined || (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((k) => allowed.includes(k)));

/** Erlaubte Methoden mit Prüfung ihrer Parameter; alles andere wird nicht weitergereicht. */
const METHODS = Object.freeze({
  getTokenAccountsByOwner: (p) => isText(p[0]) && TOKEN_PROGRAMS.has(p[1]?.programId) && Object.keys(p[1]).length === 1 && optionsOnly(p[2], ['encoding', 'commitment']),
  getMultipleAccounts: (p) => isList(p[0], 100) && optionsOnly(p[1], ['encoding', 'commitment']),
  getBalance: (p) => isText(p[0]) && optionsOnly(p[1], ['commitment']),
  getMinimumBalanceForRentExemption: (p) => Number.isInteger(p[0]) && p[0] >= 0 && p[0] <= 10 * 1024 * 1024 && optionsOnly(p[1], ['commitment']),
  getLatestBlockhash: (p) => optionsOnly(p[0], ['commitment']),
  getBlockHeight: (p) => optionsOnly(p[0], ['commitment']),
  getRecentPrioritizationFees: (p) => p.length === 0 || (Array.isArray(p[0]) && p[0].length <= 128),
  simulateTransaction: (p) => isText(p[0], 4096) && optionsOnly(p[1], ['encoding', 'sigVerify', 'replaceRecentBlockhash', 'commitment']),
  sendTransaction: (p) => isText(p[0], 4096) && optionsOnly(p[1], ['encoding', 'skipPreflight', 'preflightCommitment', 'maxRetries']),
  getSignatureStatuses: (p) => isList(p[0], 256) && optionsOnly(p[1], ['searchTransactionHistory']),
  getTransaction: (p) => isText(p[0], 88) && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(p[0]) && optionsOnly(p[1], ['encoding', 'commitment', 'maxSupportedTransactionVersion']) && p[1]?.encoding === 'json' && p[1]?.commitment === 'confirmed' && p[1]?.maxSupportedTransactionVersion === 0,
});
export const ALLOWED_METHODS = new Set(Object.keys(METHODS));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://api.jup.ag",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');
const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CSP,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
});

function sendText(res, status, text) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendRpcError(res, status, message, id = null) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32600, message } }));
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => resolveBody(size > limit ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Liest die Antwort des RPC höchstens bis `limit` Byte; darüber null. */
async function readLimited(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Zeigt nur Schema und Host; Pfad und Abfrage können Schlüssel enthalten. */
export function redact(url) {
  try {
    const parsed = new URL(url);
    const hasMore = parsed.pathname !== '/' || parsed.search !== '' || parsed.username !== '';
    return hasMore ? `${parsed.origin}/…` : parsed.origin;
  } catch {
    return '(ungültige Adresse)';
  }
}

function checkUpstream(url) {
  const parsed = new URL(url);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new Error('RPC URL must start with https://.');
  }
  return parsed.toString();
}

async function serveStatic(req, res, root) {
  // Fremde Seiten dürfen Dateien nicht einbetten (sonst könnten sie erkennen, dass Leergut läuft)
  if (req.headers['sec-fetch-site'] === 'cross-site' && req.headers['sec-fetch-mode'] !== 'navigate') {
    sendText(res, 403, 'Forbidden');
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    sendText(res, 400, 'Invalid path');
    return;
  }
  if (pathname.includes('\0')) {
    sendText(res, 400, 'Invalid path');
    return;
  }
  const file = resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`);
  if (!file.startsWith(root + sep)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      sendText(res, 404, 'Not found');
      return;
    }
    throw error;
  }
}

async function handleRpc(req, res, { upstreamUrl, fetchImpl, allowedOrigins, maxResponseBytes }) {
  if (req.method !== 'POST') {
    sendRpcError(res, 405, 'POST only');
    return;
  }
  // Nur die eigene Seite: Browser schicken Origin bei POST immer mit
  const fetchSite = req.headers['sec-fetch-site'];
  if (!allowedOrigins.includes(req.headers.origin) || (fetchSite && fetchSite !== 'same-origin')) {
    sendRpcError(res, 403, 'Only this site may use this endpoint');
    return;
  }
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    sendRpcError(res, 415, 'JSON only');
    return;
  }
  const raw = await readBody(req, MAX_BODY_BYTES);
  if (raw === null) {
    sendRpcError(res, 413, 'Request too large');
    return;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    sendRpcError(res, 400, 'Invalid JSON');
    return;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    sendRpcError(res, 400, 'Only individual requests are supported');
    return;
  }
  const id = typeof payload.id === 'number' || typeof payload.id === 'string' ? payload.id : null;
  const check = METHODS[payload.method];
  if (!check) {
    sendRpcError(res, 403, `Method not allowed: ${String(payload.method).slice(0, 60)}`, id);
    return;
  }
  const params = payload.params ?? [];
  if (!Array.isArray(params) || !check(params)) {
    sendRpcError(res, 400, `Parameters not allowed: ${payload.method}`, id);
    return;
  }
  let upstream;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: payload.method, params }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    process.stderr.write(`Solfund: Solana RPC unavailable (${payload.method}): ${error.message}\n`);
    sendRpcError(res, 502, 'Solana RPC unavailable', id);
    return;
  }
  const text = await readLimited(upstream, maxResponseBytes);
  if (text === null) {
    sendRpcError(res, 502, 'Solana RPC response too large', id);
    return;
  }
  res.writeHead(upstream.status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

/**
 * Startet den lokalen Server. Hört nur auf 127.0.0.1.
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function startServer({
  port = Number(process.env.SOLFUND_PORT ?? process.env.LEERGUT_PORT ?? 8790),
  host = '127.0.0.1',
  root = SITE_DIR,
  upstreamUrl = process.env.SOLFUND_RPC_URL ?? process.env.LEERGUT_RPC_URL ?? DEFAULT_UPSTREAM,
  fetchImpl = (...args) => globalThis.fetch(...args),
  maxResponseBytes = MAX_RESPONSE_BYTES,
  quiet = false,
} = {}) {
  const rootDir = resolve(root);
  const upstream = checkUpstream(upstreamUrl);
  const state = { allowedHosts: [], allowedOrigins: [] };

  const server = http.createServer((req, res) => {
    const handle = async () => {
      // Schutz vor DNS-Rebinding: nur Anfragen an unsere eigene Adresse beantworten
      if (!state.allowedHosts.includes(req.headers.host ?? '')) {
        sendText(res, 403, 'Unknown host');
        return;
      }
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname === '/rpc') {
        await handleRpc(req, res, { upstreamUrl: upstream, fetchImpl, allowedOrigins: state.allowedOrigins, maxResponseBytes });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method not allowed');
        return;
      }
      await serveStatic(req, res, rootDir);
    };
    handle().catch((error) => {
      process.stderr.write(`Solfund: Request failed: ${error.stack ?? error}\n`);
      if (!res.headersSent) sendText(res, 500, 'Server error');
      else res.end();
    });
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  const actualPort = server.address().port;
  state.allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
  state.allowedOrigins = state.allowedHosts.map((h) => `http://${h}`);
  const url = `http://${host}:${actualPort}`;
  if (!quiet) {
    process.stdout.write(`Solfund is running: ${url}\nSolana RPC: ${redact(upstream)}\nPress Ctrl+C to stop.\n`);
  }
  return {
    url,
    port: actualPort,
    close: () =>
      new Promise((resolveClose) => {
        server.closeAllConnections?.();
        server.close(() => resolveClose());
      }),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().catch((error) => {
    process.stderr.write(`Solfund could not start: ${error.message}\n`);
    process.exit(1);
  });
}
