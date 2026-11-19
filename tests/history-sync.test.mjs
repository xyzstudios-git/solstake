import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryStore } from '../site/lib/history.js';
import { syncHistory } from '../site/lib/history-sync.js';
import { encodeBase58 } from '../site/lib/base58.js';

const owner = encodeBase58(new Uint8Array(32).fill(17));
const signature = (value) => encodeBase58(new Uint8Array(64).fill(value));
const now = Date.now();
const entry = (value, status = 'sent') => ({
  signature: signature(value), timestamp: now - value, status,
  reclaimLamports: 2_000_000, feeLamports: 5_000, actualNetLamports: null,
  sources: [{ kind: 'token', label: 'Kontomiete', count: 1 }], error: null,
});
const store = () => {
  const data = new Map();
  return createHistoryStore({ storage: { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) } });
};
const transaction = (sig) => ({
  transaction: { signatures: [sig], message: { accountKeys: [owner] } },
  meta: { err: null, fee: 6_000, preBalances: [10_000_000], postBalances: [11_994_000] },
});

test('history sync verifies tracked signatures and replaces estimates with chain balances', async () => {
  const saved = store();
  saved.upsert(owner, entry(1));
  let updates = 0;
  const rpc = {
    async getSignatureStatuses(signatures, options) {
      assert.deepEqual(signatures, [signature(1)]);
      assert.equal(options.searchTransactionHistory, true);
      return [{ err: null, confirmationStatus: 'confirmed' }];
    },
    async getTransaction(sig) { return transaction(sig); },
  };
  assert.equal(await syncHistory({ store: saved, rpc, owner, onUpdate: () => updates++ }), null);
  const checked = saved.read(owner).entries[0];
  assert.equal(checked.status, 'confirmed');
  assert.equal(checked.actualNetLamports, 1_994_000);
  assert.equal(checked.feeLamports, 6_000);
  assert.equal(updates, 1);
});

test('history sync revisits expired signatures and rotates past unresolved recent entries', async () => {
  const saved = store();
  for (let value = 1; value <= 21; value++) saved.upsert(owner, entry(value, value === 21 ? 'expired' : 'unknown'));
  const calls = [];
  const rpc = {
    async getSignatureStatuses(signatures) {
      calls.push(signatures);
      return signatures.map((sig) => sig === signature(21) ? { err: null, confirmationStatus: 'finalized' } : null);
    },
    async getTransaction(sig) { return transaction(sig); },
  };
  assert.match(await syncHistory({ store: saved, rpc, owner }), /more saved transactions/);
  await syncHistory({ store: saved, rpc, owner });
  assert.ok(calls[1].includes(signature(21)));
  assert.equal(saved.read(owner).entries.find((item) => item.signature === signature(21)).status, 'confirmed');
});

test('history sync preserves data on invalid details and rejects incomplete status responses', async () => {
  const saved = store();
  saved.upsert(owner, entry(1));
  const rpc = {
    async getSignatureStatuses() { return [{ err: null, confirmationStatus: 'confirmed' }]; },
    async getTransaction() { return transaction(signature(2)); },
  };
  assert.match(await syncHistory({ store: saved, rpc, owner }), /transaction details/);
  assert.equal(saved.read(owner).entries[0].status, 'sent');
  rpc.getSignatureStatuses = async () => [];
  await assert.rejects(syncHistory({ store: saved, rpc, owner }), /completely/);
  await assert.rejects(syncHistory({ store: saved, rpc, owner, limit: 0 }), /limit/);
});
