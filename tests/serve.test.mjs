import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, redact } from '../serve.mjs';

let upstream;
let app;
const seen = [];

before(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      seen.push({ headers: req.headers, body: parsed });
      res.writeHead(200, { 'content-type': 'application/json' });
      const result = parsed.method === 'getMultipleAccounts' ? 'x'.repeat(5000) : 'weitergeleitet';
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  app = await startServer({ port: 0, upstreamUrl: `http://127.0.0.1:${upstream.address().port}`, quiet: true });
});

after(async () => {
  await app.close();
  await new Promise((resolve) => upstream.close(resolve));
});

const rpcCall = (method, { origin = app.url, headers = {}, body } = {}) =>
  fetch(`${app.url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...headers },
    body: body ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
  });

test('serves the app with strict security headers', async () => {
  const res = await fetch(`${app.url}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
  const js = await fetch(`${app.url}/lib/base58.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
});

test('forwards rent lookups only for bounded integer account sizes', async () => {
  const call = (size) => rpcCall('getMinimumBalanceForRentExemption', {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMinimumBalanceForRentExemption', params: [size, { commitment: 'confirmed' }] }),
  });
  assert.equal((await call(170)).status, 200);
  for (const size of [-1, 1.5, 10 * 1024 * 1024 + 1, '170']) assert.equal((await call(size)).status, 400);
});

test('never serves files outside the site folder', async () => {
  for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fserve.mjs', '/%00']) {
    const res = await fetch(`${app.url}${path}`);
    assert.notEqual(res.status, 200, path);
  }
  assert.equal((await fetch(`${app.url}/gibt-es-nicht.js`)).status, 404);
});

test('forwards allowed RPC methods without the browser origin', async () => {
  const res = await rpcCall('getBalance', { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: ['11111111111111111111111111111111'] }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result, 'weitergeleitet');
  const last = seen.at(-1);
  assert.equal(last.body.method, 'getBalance');
  assert.equal(last.headers.origin, undefined);
  assert.equal(last.headers.cookie, undefined);
});

test('blocks other methods, other sites, foreign hosts and odd requests', async () => {
  const count = seen.length;
  assert.equal((await rpcCall('getProgramAccounts')).status, 403);
  assert.equal((await rpcCall('getBalance', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await rpcCall('getBalance', { origin: null })).status, 403);
  assert.equal((await rpcCall('getBalance', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await rpcCall('getBalance', { body: '[{"method":"getBalance"}]' })).status, 400);
  assert.equal((await rpcCall('getBalance', { body: '{kaputt' })).status, 400);
  assert.equal((await rpcCall('getBalance', { body: JSON.stringify({ method: 'getBalance', params: 'x'.repeat(70_000) }) })).status, 413);
  assert.equal((await rpcCall('getBalance', { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await fetch(`${app.url}/rpc`)).status, 405);
  const rebound = await new Promise((resolve) => {
    const req = http.request(`${app.url}/rpc`, { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } }, (res) => resolve(res.statusCode));
    req.end(JSON.stringify({ method: 'getBalance' }));
  });
  assert.equal(rebound, 403);
  assert.equal(seen.length, count);
});

const rpcBody = (method, params) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

test('allows bounded transaction history reads with fixed safe options', async () => {
  const options = { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 };
  const call = (params) => rpcCall('getTransaction', { body: rpcBody('getTransaction', params) });
  assert.equal((await call(['1'.repeat(64), options])).status, 200);
  for (const params of [
    ['invalid', options], ['1'.repeat(89), options], ['1'.repeat(64)],
    ['1'.repeat(64), { ...options, encoding: 'jsonParsed' }],
    ['1'.repeat(64), { ...options, extra: true }],
  ]) assert.equal((await call(params)).status, 400);
});

test('checks parameters before forwarding', async () => {
  const tooMany = Array.from({ length: 101 }, () => '11111111111111111111111111111111');
  assert.equal((await rpcCall('getMultipleAccounts', { body: rpcBody('getMultipleAccounts', [tooMany, { encoding: 'base64' }]) })).status, 400);
  assert.equal((await rpcCall('getMultipleAccounts', { body: rpcBody('getMultipleAccounts', [['11111111111111111111111111111111'], { encoding: 'base64', dataSlice: { offset: 0, length: 9 } }]) })).status, 400);
  const badProgram = [ '11111111111111111111111111111111', { programId: '11111111111111111111111111111111' }, { encoding: 'jsonParsed' }];
  assert.equal((await rpcCall('getTokenAccountsByOwner', { body: rpcBody('getTokenAccountsByOwner', badProgram) })).status, 400);
  const fine = ['11111111111111111111111111111111', { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }];
  assert.equal((await rpcCall('getTokenAccountsByOwner', { body: rpcBody('getTokenAccountsByOwner', fine) })).status, 200);
});

test('limits the size of upstream answers', async () => {
  const small = await startServer({ port: 0, upstreamUrl: `http://127.0.0.1:${upstream.address().port}`, quiet: true, maxResponseBytes: 1000 });
  try {
    const res = await fetch(`${small.url}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: small.url },
      body: rpcBody('getMultipleAccounts', [['11111111111111111111111111111111'], { encoding: 'base64' }]),
    });
    assert.equal(res.status, 502);
  } finally {
    await small.close();
  }
});

// Nodes fetch setzt sec-fetch-mode selbst; deshalb hier eine rohe Anfrage
const rawGet = (path, headers) =>
  new Promise((resolve) => {
    http.get(`${app.url}${path}`, { headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
  });

test('other sites cannot embed files, but links still open', async () => {
  assert.equal(await rawGet('/icon.svg', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' }), 403);
  assert.equal(await rawGet('/', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }), 200);
  assert.equal(await rawGet('/icon.svg', {}), 200);
});

test('redact hides keys in paths and queries', () => {
  assert.equal(redact('https://solana-mainnet.g.alchemy.com/v2/SECRETKEY123'), 'https://solana-mainnet.g.alchemy.com/…');
  assert.equal(redact('https://mainnet.helius-rpc.com/?api-key=abc'), 'https://mainnet.helius-rpc.com/…');
  assert.equal(redact('https://api.mainnet-beta.solana.com'), 'https://api.mainnet-beta.solana.com');
});
