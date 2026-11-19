import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../serve.mjs';

const names = ['SOLSTAKE_PORT', 'SOLSTAKE_RPC_URL', 'SOLFUND_PORT', 'SOLFUND_RPC_URL', 'LEERGUT_PORT', 'LEERGUT_RPC_URL'];
function environment(t, values) {
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
}

async function configuredServer(t) {
  const requests = [];
  const app = await startServer({ quiet: true, fetchImpl: async (url) => {
    requests.push(url);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: 1 } }), { headers: { 'content-type': 'application/json' } });
  } });
  t.after(() => app.close());
  const response = await fetch(`${app.url}/rpc`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: app.url },
    body: JSON.stringify({ method: 'getBalance', params: ['11111111111111111111111111111111'] }),
  });
  assert.equal(response.status, 200);
  await response.json();
  return { app, requests };
}

test('Solstake variables take precedence over both previous configuration names', async (t) => {
  environment(t, { SOLSTAKE_PORT: '0', SOLFUND_PORT: 'previous-invalid-port', LEERGUT_PORT: 'legacy-invalid-port', SOLSTAKE_RPC_URL: 'https://current.example.test/rpc', SOLFUND_RPC_URL: 'https://previous.example.test/rpc', LEERGUT_RPC_URL: 'https://legacy.example.test/rpc' });
  const { app, requests } = await configuredServer(t);
  assert.equal(requests[0], 'https://current.example.test/rpc');
  assert.ok(Number.isInteger(app.port) && app.port > 0);
});

test('previous Solfund server variables take precedence over Leergut configuration', async (t) => {
  environment(t, { SOLFUND_PORT: '0', LEERGUT_PORT: 'legacy-invalid-port', SOLFUND_RPC_URL: 'https://primary.example.test/rpc', LEERGUT_RPC_URL: 'https://legacy.example.test/rpc' });
  const { app, requests } = await configuredServer(t);
  assert.equal(requests[0], 'https://primary.example.test/rpc');
  assert.ok(Number.isInteger(app.port) && app.port > 0);
});

test('legacy server variables continue to work', async (t) => {
  environment(t, { LEERGUT_PORT: '0', LEERGUT_RPC_URL: 'https://legacy.example.test/rpc' });
  const { requests } = await configuredServer(t);
  assert.equal(requests[0], 'https://legacy.example.test/rpc');
});

test('the start command loads an optional environment file and serves Solstake', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'solstake-env-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, '.env');
  await writeFile(envFile, 'SOLSTAKE_PORT=0\nSOLSTAKE_RPC_URL=https://rpc.example.test/\n');
  const env = { ...process.env };
  for (const name of names) delete env[name];
  const child = spawn(process.execPath, [`--env-file-if-exists=${envFile}`, fileURLToPath(new URL('../serve.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Local server did not start.')), 5_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Local server exited with ${code}.`)); });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const html = await (await fetch(url)).text();
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Solstake/);
});

test('mainnet simulation requires explicit public addresses before any RPC call', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../tools/mainnet-sim-check.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:.*<OWNER_ADDRESS>.*<FEE_PAYER_ADDRESS>/);
});
