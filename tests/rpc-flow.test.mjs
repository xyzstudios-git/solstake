import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transaction } from '@solana/web3.js';
import { createRpc, RpcError } from '../site/lib/rpc.js';
import { prepareBurnPlan, executeBurnPlan, explainError } from '../site/lib/flow.js';
import { computeUnitLimitFor, estimateNetworkFee } from '../site/lib/fees.js';
import { encodeBase58 } from '../site/lib/base58.js';
import { TOKEN, TOKEN_2022, randomAddress } from './support/fixtures.mjs';

const owner = randomAddress();

function fakeFetch(handler) {
  const requests = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body, init });
    return handler(body, init);
  };
  impl.requests = requests;
  return impl;
}
const okJson = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });

test('history RPC uses historical status lookup and confirmed versioned transaction details', async () => {
  const f = fakeFetch((body) => okJson(body.method === 'getSignatureStatuses' ? { value: [null] } : null));
  const rpc = createRpc({ fetchImpl: f });
  await rpc.getSignatureStatuses(['signature']);
  await rpc.getSignatureStatuses(['signature'], { searchTransactionHistory: true });
  assert.equal(await rpc.getTransaction('signature'), null);
  assert.equal(f.requests[0].body.params[1].searchTransactionHistory, false);
  assert.equal(f.requests[1].body.params[1].searchTransactionHistory, true);
  assert.deepEqual(f.requests[2].body.params, ['signature', { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
});

test('rent reserve requests validate size and reject malformed RPC amounts', async () => {
  const f = fakeFetch(() => okJson(1513840));
  const rpc = createRpc({ fetchImpl: f });
  assert.equal(await rpc.getMinimumBalanceForRentExemption(170), 1513840);
  assert.deepEqual(f.requests[0].body.params, [170, { commitment: 'confirmed' }]);
  await assert.rejects(rpc.getMinimumBalanceForRentExemption(-1), RangeError);
  await assert.rejects(rpc.getMinimumBalanceForRentExemption(1.5), RangeError);
  const invalid = createRpc({ fetchImpl: fakeFetch(() => okJson(-1)) });
  await assert.rejects(invalid.getMinimumBalanceForRentExemption(170), /Unexpected response/);
});

test('getTokenAccounts asks both token programs and merges the lists', async () => {
  const f = fakeFetch((body) => okJson({ context: { slot: 1 }, value: [{ pubkey: body.params[1].programId }] }));
  const rpc = createRpc({ url: '/rpc', fetchImpl: f });
  const list = await rpc.getTokenAccounts(owner);
  assert.deepEqual(list.map((e) => e.pubkey).sort(), [TOKEN, TOKEN_2022].sort());
  for (const r of f.requests) {
    assert.equal(r.url, '/rpc');
    assert.equal(r.body.method, 'getTokenAccountsByOwner');
    assert.equal(r.body.params[0], owner);
    assert.equal(r.body.params[2].encoding, 'jsonParsed');
    assert.equal(r.init.headers['content-type'], 'application/json');
  }
});

test('simulate, send and status calls use the right options', async () => {
  const f = fakeFetch((body) => {
    if (body.method === 'simulateTransaction') return okJson({ context: {}, value: { err: null, logs: [], unitsConsumed: 1234 } });
    if (body.method === 'sendTransaction') return okJson('sig');
    if (body.method === 'getSignatureStatuses') return okJson({ context: {}, value: [null] });
    if (body.method === 'getLatestBlockhash') return okJson({ context: {}, value: { blockhash: 'abc', lastValidBlockHeight: 7 } });
    if (body.method === 'getBlockHeight') return okJson(5);
    if (body.method === 'getRecentPrioritizationFees') return okJson([{ slot: 1, prioritizationFee: 3 }]);
    if (body.method === 'getMultipleAccounts') return okJson({ context: {}, value: [null] });
    if (body.method === 'getBalance') return okJson({ context: {}, value: 99 });
    return okJson(null);
  });
  const rpc = createRpc({ fetchImpl: f });
  assert.deepEqual(await rpc.simulate('AAA='), { err: null, logs: [], unitsConsumed: 1234 });
  assert.equal(await rpc.send('AAA='), 'sig');
  assert.equal(await rpc.send('AAA=', { skipPreflight: true }), 'sig');
  assert.deepEqual(await rpc.getSignatureStatuses(['s']), [null]);
  assert.deepEqual(await rpc.getLatestBlockhash(), { blockhash: 'abc', lastValidBlockHeight: 7 });
  assert.equal(await rpc.getBlockHeight(), 5);
  assert.deepEqual(await rpc.getRecentPrioritizationFees(), [{ slot: 1, prioritizationFee: 3 }]);
  assert.deepEqual(await rpc.getMultipleAccounts(['x'], 'base64'), [null]);
  assert.equal(await rpc.getBalance(owner), 99);
  const byMethod = Object.fromEntries(f.requests.map((r) => [r.body.method + (r.body.params?.[1]?.skipPreflight ? ':skip' : ''), r.body.params]));
  assert.deepEqual(byMethod.simulateTransaction[1], { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  assert.equal(byMethod.sendTransaction[1].skipPreflight, false);
  assert.equal(byMethod.sendTransaction[1].preflightCommitment, 'confirmed');
  assert.equal(byMethod['sendTransaction:skip'][1].skipPreflight, true);
  assert.deepEqual(byMethod.getMultipleAccounts[1], { encoding: 'base64', commitment: 'confirmed' });
});

test('turns JSON-RPC errors into RpcError with the method name', async () => {
  const f = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'kaputt' } }) }));
  const rpc = createRpc({ fetchImpl: f });
  await assert.rejects(rpc.getLatestBlockhash(), (e) => e instanceof RpcError && e.code === -32002 && /getLatestBlockhash/.test(e.message));
});

test('explains HTTP 429, 403 and malformed responses in plain English', async () => {
  const rpc429 = createRpc({ fetchImpl: fakeFetch(() => ({ ok: false, status: 429, json: async () => ({}) })) });
  await assert.rejects(rpc429.getBalance(owner), (e) => e.status === 429 && /Too many requests/.test(e.message));
  const rpc403 = createRpc({ fetchImpl: fakeFetch(() => ({ ok: false, status: 403, json: async () => ({}) })) });
  await assert.rejects(rpc403.getBalance(owner), /blocked/);
  const rpcJunk = createRpc({ fetchImpl: fakeFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } })) });
  await assert.rejects(rpcJunk.getBalance(owner), /response/);
  const rpcShape = createRpc({ fetchImpl: fakeFetch(() => okJson({ value: 'kein Array' })) });
  await assert.rejects(rpcShape.getTokenAccounts(owner), /response/);
  const rpcNet = createRpc({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(rpcNet.getBalance(owner), /unreachable/);
});

test('gives up after the timeout', async () => {
  const f = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const rpc = createRpc({ fetchImpl: f, timeoutMs: 20 });
  await assert.rejects(rpc.getBlockHeight(), /timed out/);
});

function makeItems(count) {
  return Array.from({ length: count }, (_, i) => ({
    action: i % 2 ? 'burn' : 'close',
    account: { address: randomAddress(), programId: TOKEN, mint: randomAddress(), amount: i % 2 ? 10n : 0n, decimals: 6, lamports: 2039280 },
  }));
}

function simulatingRpc(badAddresses = []) {
  const calls = { simulate: 0 };
  return {
    calls,
    async getRecentPrioritizationFees() { return [{ slot: 1, prioritizationFee: 40_000 }]; },
    async simulate(b64) {
      calls.simulate += 1;
      const tx = Transaction.from(Buffer.from(b64, 'base64'));
      const touched = tx.instructions.flatMap((ix) => ix.keys.map((k) => k.pubkey.toBase58()));
      if (badAddresses.some((a) => touched.includes(a))) {
        return { err: { InstructionError: [2, { Custom: 17 }] }, logs: ['Program log: Error: Account is frozen'], unitsConsumed: 900 };
      }
      const closes = tx.instructions.filter((ix) => ix.data[0] === 9).length;
      return { err: null, logs: [], unitsConsumed: 3000 * closes + 300 };
    },
  };
}

test('prepareBurnPlan simulates every batch and isolates a failing account', async () => {
  const items = makeItems(23);
  const rpc = simulatingRpc([items[5].account.address]);
  const plan = await prepareBurnPlan({ rpc, owner, items, maxItemsPerTx: 10 });
  assert.equal(plan.failed.length, 1);
  assert.equal(plan.failed[0].item, items[5]);
  assert.match(plan.failed[0].error, /frozen/);
  const planned = plan.batches.flatMap((b) => b.items);
  assert.equal(planned.length, items.length - 1);
  assert.ok(!planned.includes(items[5]));
  assert.equal(plan.computeUnitPrice, 40_000);
  assert.equal(plan.reclaimLamports, (items.length - 1) * 2039280);
  for (const b of plan.batches) assert.equal(b.computeUnitLimit, computeUnitLimitFor(b.unitsConsumed));
  assert.equal(
    plan.networkFeeLamports,
    estimateNetworkFee(plan.batches.map((b) => ({ computeUnitLimit: b.computeUnitLimit, computeUnitPrice: 40_000 }))),
  );
  assert.ok(rpc.calls.simulate <= 3 + 8, `zu viele Simulationen: ${rpc.calls.simulate}`);
});

test('prepareBurnPlan does not bisect errors that affect the whole transaction', async () => {
  const items = makeItems(12);
  let calls = 0;
  const rpc = {
    async getRecentPrioritizationFees() { return []; },
    async simulate() {
      calls += 1;
      return { err: 'InvalidAccountForFee', logs: [], unitsConsumed: 0 };
    },
  };
  const plan = await prepareBurnPlan({ rpc, owner, items, maxItemsPerTx: 6 });
  assert.equal(calls, 2);
  assert.equal(plan.batches.length, 0);
  assert.equal(plan.failed.length, 12);
  assert.match(plan.failed[0].error, /cannot pay fees/);
});

test('prepareBurnPlan with nothing selected or a broken RPC', async () => {
  const empty = await prepareBurnPlan({ rpc: simulatingRpc(), owner, items: [] });
  assert.deepEqual(empty.batches, []);
  assert.equal(empty.reclaimLamports, 0);
  const broken = { getRecentPrioritizationFees: async () => [], simulate: async () => { throw new RpcError('weg', {}); } };
  await assert.rejects(prepareBurnPlan({ rpc: broken, owner, items: makeItems(2) }), /weg/);
});

function fakeChain({ failSignature = () => false, expire = false, confirmAfterPolls = 2 } = {}) {
  const sent = [];
  let polls = 0;
  return {
    sent,
    async getLatestBlockhash() { return { blockhash: randomAddress(), lastValidBlockHeight: 100 }; },
    async getBlockHeight() { return expire ? 101 : 50; },
    async send(b64, opts = {}) {
      const bytes = Buffer.from(b64, 'base64');
      const signature = encodeBase58(bytes.subarray(1, 65));
      sent.push({ signature, skipPreflight: Boolean(opts.skipPreflight) });
      return signature;
    },
    async getSignatureStatuses(signatures) {
      polls += 1;
      return signatures.map((s) => {
        if (expire || polls < confirmAfterPolls) return null;
        return { confirmationStatus: 'confirmed', err: failSignature(s) ? { InstructionError: [3, { Custom: 1 }] } : null };
      });
    },
  };
}

function fakeSigner() {
  let counter = 0;
  return {
    mode: 'sign',
    requests: [],
    async signTransactions(list) {
      this.requests.push(list.length);
      return list.map((bytes) => {
        counter += 1;
        const copy = bytes.slice();
        copy.fill(counter % 250 + 1, 1, 65);
        return copy;
      });
    },
  };
}

async function readyPlan(count = 12) {
  return prepareBurnPlan({ rpc: simulatingRpc(), owner, items: makeItems(count), maxItemsPerTx: 4 });
}
const noSleep = async () => {};

test('executeBurnPlan signs per round, sends and confirms every batch', async () => {
  const plan = await readyPlan(12);
  const chain = fakeChain();
  const signer = fakeSigner();
  const events = [];
  const results = await executeBurnPlan({ rpc: chain, signer, owner, plan, roundSize: 2, sleep: noSleep, onProgress: (e) => events.push(e) });
  assert.equal(results.length, plan.batches.length);
  assert.ok(results.every((r) => r.status === 'confirmed' && r.signature));
  assert.deepEqual(signer.requests, [2, 1]);
  assert.ok(events.some((e) => e.type === 'signing'));
  assert.ok(events.some((e) => e.type === 'confirmed'));
  assert.equal(new Set(chain.sent.filter((s) => !s.skipPreflight).map((s) => s.signature)).size, plan.batches.length);
});

test('executeBurnPlan reports failed and expired transactions', async () => {
  const plan = await readyPlan(8);
  let first = null;
  const failing = fakeChain({ failSignature: (s) => (first ??= s) === s });
  const results = await executeBurnPlan({ rpc: failing, signer: fakeSigner(), owner, plan, sleep: noSleep });
  assert.equal(results[0].status, 'failed');
  assert.match(results[0].error, /balance/);
  assert.ok(results.slice(1).every((r) => r.status === 'confirmed'));

  const expired = await executeBurnPlan({ rpc: fakeChain({ expire: true }), signer: fakeSigner(), owner, plan, sleep: noSleep });
  assert.ok(expired.every((r) => r.status === 'expired'));
});

test('executeBurnPlan stops cleanly when the wallet refuses', async () => {
  const plan = await readyPlan(12);
  const chain = fakeChain();
  const signer = { mode: 'sign', async signTransactions() { throw new Error('User rejected the request.'); } };
  const results = await executeBurnPlan({ rpc: chain, signer, owner, plan, roundSize: 2, sleep: noSleep });
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.equal(chain.sent.length, 0);
});

test('executeBurnPlan refuses transactions the wallet did not sign', async () => {
  const plan = await readyPlan(4);
  const signer = { mode: 'sign', async signTransactions(list) { return list; } };
  const results = await executeBurnPlan({ rpc: fakeChain(), signer, owner, plan, sleep: noSleep });
  assert.equal(results[0].status, 'failed');
  assert.match(results[0].error, /did not sign/);
});

test('executeBurnPlan refuses a transaction the wallet changed', async () => {
  const plan = await readyPlan(4);
  const chain = fakeChain();
  const signer = {
    mode: 'sign',
    async signTransactions(list) {
      return list.map((bytes) => {
        const copy = bytes.slice();
        copy.fill(9, 1, 65);
        copy[copy.length - 1] ^= 0xff;
        return copy;
      });
    },
  };
  const results = await executeBurnPlan({ rpc: chain, signer, owner, plan, sleep: noSleep });
  assert.equal(results[0].status, 'failed');
  assert.match(results[0].error, /changed/);
  assert.equal(chain.sent.length, 0);
});

test('executeBurnPlan supports wallets that only sign and send', async () => {
  const plan = await readyPlan(4);
  const chain = fakeChain();
  let n = 0;
  const signer = { mode: 'signAndSend', async signAndSend() { n += 1; return encodeBase58(new Uint8Array(64).fill(n)); } };
  const results = await executeBurnPlan({ rpc: chain, signer, owner, plan, sleep: noSleep });
  assert.ok(results.every((r) => r.status === 'confirmed'));
  assert.equal(chain.sent.length, 0);
});

test('explainError translates common Solana errors', () => {
  assert.match(explainError({ InstructionError: [0, { Custom: 11 }] }), /not empty/);
  assert.match(explainError({ InstructionError: [0, { Custom: 4 }] }), /belong/);
  assert.match(explainError('InsufficientFundsForFee'), /network fee/);
  assert.match(explainError('BlockhashNotFound'), /expired/);
  assert.match(explainError('InvalidAccountForFee'), /cannot pay fees/);
  assert.match(explainError({ InstructionError: [1, { Custom: 99 }] }, ['Program log: Error: Mint is paused']), /Mint is paused/);
  assert.match(explainError({ Weird: 1 }), /Weird/);
});


test('a wallet authorization failure asks for reconnection and submits no transaction', async () => {
  const plan = await readyPlan(4);
  const chain = fakeChain();
  const signer = { mode: 'sign', async signTransactions() { throw Object.assign(new Error('The requested method and/or account has not been authorized by the user.'), { code: 4100 }); } };
  const results = await executeBurnPlan({ rpc: chain, signer, owner, plan, sleep: noSleep });
  assert.ok(results.every((entry) => entry.status === 'rejected'));
  assert.ok(results.every((entry) => /Reconnect your wallet/i.test(entry.error)));
  assert.equal(chain.sent.length, 0);
});
