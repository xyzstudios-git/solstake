import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../worker/index.js';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';

const origin = 'https://solfund.xyzstudios.de';
const env = { SOLSTAKE_ALLOWED_ORIGINS: origin, SOLSTAKE_RPC_URL: 'https://rpc.example/?api-key=test-secret' };
const payload = (method = 'getBalance', params = ['11111111111111111111111111111111']) => JSON.stringify({ jsonrpc: '2.0', id: 7, method, params });
const request = (body = payload(), headers = {}, url = `${origin}/rpc`) => new Request(url, {
  method: 'POST', headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1', ...headers }, body,
});
const upstream = () => Response.json({ jsonrpc: '2.0', id: 7, result: { value: 42 } });

test('production build serves all original assets byte-for-byte without filesystem or environment secrets', async () => {
  execFileSync(process.execPath, ['tools/build-hosted.mjs'], { cwd: new URL('../', import.meta.url) });
  const built = await import(`../dist/server/index.js?test=${Date.now()}`);
  const walk = async (directory = '') => {
    for (const entry of await readdir(new URL(`../site/${directory}`, import.meta.url), { withFileTypes: true })) {
      const path = `${directory}${entry.name}`;
      if (entry.isDirectory()) await walk(`${path}/`);
      else {
        const result = await built.default.fetch(new Request(`${origin}/${path}`), env);
        assert.equal(result.status, 200, path);
        assert.deepEqual(Buffer.from(await result.arrayBuffer()), await readFile(new URL(`../site/${path}`, import.meta.url)), path);
      }
    }
  };
  await walk();
  const source = await readFile(new URL('../dist/server/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|\/Users\/anton|test-secret/);
});

test('hosted app serves exact embedded assets, HEAD and security headers', async () => {
  const app = createWorker({ assets: { '/index.html': { type: 'text/html', base64: btoa('<h1>Solstake</h1>') } } });
  const response = await app.fetch(new Request(origin), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<h1>Solstake</h1>');
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(await (await app.fetch(new Request(origin, { method: 'HEAD' }), env)).text(), '');
  assert.equal((await app.fetch(new Request(`${origin}/.env`), env)).status, 404);
  assert.equal((await app.fetch(new Request(`${origin}/%00`), env)).status, 400);
});

test('public RPC fails closed on unconfigured, unencrypted or foreign hosts and origins', async () => {
  let calls = 0;
  const app = createWorker({ fetchImpl: async () => { calls++; return upstream(); } });
  assert.equal((await app.fetch(request(), {})).status, 503);
  assert.equal((await app.fetch(request(), { ...env, SOLSTAKE_RPC_URL: 'http://rpc.example' })).status, 503);
  assert.equal((await app.fetch(request(payload(), {}, 'http://solfund.xyzstudios.de/rpc'), env)).status, 403);
  assert.equal((await app.fetch(request(payload(), {}, 'https://other.example/rpc'), env)).status, 403);
  for (const headers of [{ origin: 'https://evil.example' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await app.fetch(request(payload(), headers), env)).status, 403);
  }
  assert.equal((await app.fetch(new Request(`${origin}/rpc`), env)).status, 405);
  assert.equal(calls, 0);
});

test('RPC forwards only supported method/parameter combinations and strips browser headers', async () => {
  const seen = [];
  const app = createWorker({ fetchImpl: async (url, init) => { seen.push({ url, init }); return upstream(); } });
  const response = await app.fetch(request(), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.value, 42);
  assert.equal(seen[0].url, env.SOLSTAKE_RPC_URL);
  assert.equal(seen[0].init.redirect, 'manual');
  assert.deepEqual(seen[0].init.headers, { 'content-type': 'application/json' });
  for (const body of [payload('getProgramAccounts'), payload('constructor'), payload('getBalance', []), '[{}]', 'invalid']) {
    assert.ok([400, 403].includes((await app.fetch(request(body), env)).status));
  }
  assert.equal(seen.length, 1);
  assert.equal((await app.fetch(request(payload(), { 'content-type': 'text/plain' }), env)).status, 415);
});

test('Cloudflare-compatible manual redirect mode never follows an RPC credential to another host', async () => {
  let calls = 0;
  const app = createWorker({ fetchImpl: async (_url, init) => {
    calls++;
    assert.equal(init.redirect, 'manual', 'Cloudflare Workers does not implement redirect:error');
    return new Response(null, { status: 302, headers: { location: 'https://other.example/' } });
  } });
  assert.equal((await app.fetch(request(), env)).status, 502);
  assert.equal(calls, 1);
  const working = createWorker({ fetchImpl: async (_url, init) => init.redirect === 'manual' ? upstream() : (() => { throw new TypeError('Unsupported redirect mode'); })() });
  assert.equal((await working.fetch(request(), env)).status, 200);
});

test('RPC bounds streamed request/response bytes and never returns provider errors or secrets', async () => {
  let calls = 0;
  const app = createWorker({ maxBodyBytes: 256, maxResponseBytes: 128, fetchImpl: async () => { calls++; return new Response('x'.repeat(129), { headers: { 'content-type': 'application/json' } }); } });
  assert.equal((await app.fetch(request(' '.repeat(257), { 'content-length': '1' }), env)).status, 413);
  assert.equal(calls, 0);
  assert.equal((await app.fetch(request(), env)).status, 502);
  for (const fail of [
    async () => { throw new Error(env.SOLSTAKE_RPC_URL); },
    async () => new Response(env.SOLSTAKE_RPC_URL, { status: 500 }),
    async () => Response.json({ error: { message: env.SOLSTAKE_RPC_URL } }),
  ]) {
    const response = await createWorker({ fetchImpl: fail }).fetch(request(), env);
    assert.ok([200, 502].includes(response.status));
    assert.doesNotMatch(await response.text(), /test-secret|rpc\.example/);
  }
});

test('rate limits isolate users, expire, and cap concurrent provider requests', async () => {
  let now = 0;
  const app = createWorker({ fetchImpl: async () => upstream(), now: () => now, requestsPerMinute: 2 });
  assert.equal((await app.fetch(request(), env)).status, 200);
  assert.equal((await app.fetch(request(), env)).status, 200);
  const limited = await app.fetch(request(), env);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await app.fetch(request(payload(), { 'cf-connecting-ip': '192.0.2.2' }), env)).status, 200);
  now = 60_001;
  assert.equal((await app.fetch(request(), env)).status, 200);
  let release;
  const busy = createWorker({ maxConcurrent: 1, fetchImpl: () => new Promise((resolve) => { release = resolve; }) });
  const first = busy.fetch(request(), env);
  while (!release) await new Promise(setImmediate);
  assert.equal((await busy.fetch(request(), env)).status, 429);
  release(upstream());
  assert.equal((await first).status, 200);
  assert.equal((await busy.fetch(request(payload('constructor')), env)).status, 403);
});

test('incomplete uploads time out and release the provider capacity', { timeout: 1000 }, async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } });
  const app = createWorker({ bodyTimeoutMs: 20, maxConcurrent: 1, fetchImpl: async () => upstream() });
  const slow = new Request(`${origin}/rpc`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body, duplex: 'half' });
  const pending = app.fetch(slow, env);
  const result = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve({ status: 599 }), 100))]);
  assert.equal(result.status, 408);
  assert.equal(cancelled, true);
  assert.equal((await app.fetch(request(), env)).status, 200);
});
