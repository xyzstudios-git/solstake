import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryStore, summarizeHistory, reconcileHistoryEntry } from '../site/lib/history.js';
import { encodeBase58 } from '../site/lib/base58.js';
import { TIP_RECIPIENT } from '../site/lib/tips.js';
import { transferSolIx } from '../site/lib/instructions.js';

const owner = encodeBase58(new Uint8Array(32).fill(7));
const otherOwner = encodeBase58(new Uint8Array(32).fill(8));
const signature = (value) => encodeBase58(new Uint8Array(64).fill(value));
const now = new Date(2026, 10, 18, 12).getTime();
const transaction = (overrides = {}) => ({
  signature: signature(1), timestamp: now, status: 'sent', reclaimLamports: 2_000_000,
  feeLamports: 5_000, actualNetLamports: null,
  sources: [{ kind: 'token', label: 'Leere Konten', count: 1 }], error: null, ...overrides,
});
function storage() {
  const data = new Map();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test('history persists across store instances and stays isolated by wallet', () => {
  const disk = storage();
  const first = createHistoryStore({ storage: disk, now: () => now });
  assert.deepEqual(first.read(owner), { entries: [], warning: null });
  first.upsert(owner, transaction());
  const next = createHistoryStore({ storage: disk });
  assert.equal(next.read(owner).entries.length, 1);
  assert.equal(next.read(otherOwner).entries.length, 0);
  assert.throws(() => next.read('invalid'), /wallet address/);
});

test('upsert deduplicates signatures, preserves first timestamp, and keeps confirmation sticky', () => {
  const store = createHistoryStore({ storage: storage(), now: () => now });
  store.upsert(owner, transaction());
  store.upsert(owner, transaction({ status: 'confirmed', timestamp: now + 100, actualNetLamports: 1_994_000, feeLamports: 6_000 }));
  const result = store.upsert(owner, transaction({ status: 'sent', timestamp: now + 200 }));
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].status, 'confirmed');
  assert.equal(result.entries[0].timestamp, now);
  assert.equal(result.entries[0].actualNetLamports, 1_994_000);
  store.upsert(owner, transaction({ status: 'confirmed', timestamp: now + 300 }));
  assert.equal(store.read(owner).entries[0].feeLamports, 6_000);
});

test('malformed and corrupt stored data is warned about and preserved', () => {
  const disk = storage();
  const key = 'solburn:history:v1:' + owner;
  disk.data.set(key, '{broken');
  const store = createHistoryStore({ storage: disk });
  assert.match(store.read(owner).warning, /incomplete/);
  const result = store.upsert(owner, transaction());
  assert.equal(result.entries.length, 1);
  assert.match(result.warning, /incomplete/);
  assert.equal(disk.data.get(key), '{broken');
});

test('storage read and write failures preserve this session and report a warning', () => {
  const disk = storage();
  disk.setItem = () => { throw new Error('quota'); };
  const store = createHistoryStore({ storage: disk });
  assert.match(store.upsert(owner, transaction()).warning, /session/);
  assert.equal(store.read(owner).entries.length, 1);
  assert.match(store.read(owner).warning, /session/);
  const denied = createHistoryStore({ storage: { getItem() { throw new Error('blocked'); } } });
  assert.match(denied.upsert(owner, transaction()).warning, /session/);
  assert.equal(denied.read(owner).entries.length, 1);
});

test('entry validation rejects fabricated signatures, amounts, and statuses', () => {
  const store = createHistoryStore({ storage: storage() });
  for (const override of [
    { signature: 'invalid' }, { signature: owner }, { status: 'rejected' },
    { reclaimLamports: -1 }, { feeLamports: 1.5 }, { timestamp: Infinity },
    { actualNetLamports: Number.MAX_SAFE_INTEGER + 1 }, { sources: [{ kind: 'invalid', count: 1 }] },
  ]) assert.match(store.upsert(owner, transaction(override)).warning, /could not be recorded/);
  const saved = store.upsert(owner, transaction({ sources: [{ kind: 'pump', label: '\u202ePump\u0000 Rewards', count: 1 }] }));
  assert.equal(saved.entries[0].sources[0].label, 'Pump Rewards');
});

test('summaries count only confirmed reclaim and preserve negative actual net changes', () => {
  const entries = [
    transaction({ status: 'confirmed' }),
    transaction({ signature: signature(2), status: 'confirmed', reclaimLamports: 0, feeLamports: 10_000, actualNetLamports: -10_000 }),
    transaction({ signature: signature(3), status: 'failed', actualNetLamports: -5_000 }),
    transaction({ signature: signature(4), status: 'sent' }),
    transaction({ signature: signature(5), status: 'unknown' }),
    transaction({ signature: signature(6), status: 'expired' }),
  ];
  const summary = summarizeHistory(entries, { now });
  assert.equal(summary.totalClaimedLamports, 2_000_000);
  assert.equal(summary.confirmedCount, 2);
  assert.equal(summary.pendingCount, 2);
  assert.equal(summary.failedCount, 2);
  assert.equal(summary.totalFeeLamports, 20_000);
  assert.equal(summary.netLamports, 1_980_000);
  assert.equal(summary.netIsEstimated, true);
  assert.equal(summary.chartPoints[0].lamports, 0);
  assert.equal(summary.chartPoints.at(-1).lamports, summary.totalClaimedLamports);
});

test('seven-day calendar ranges include the first day and exclude older, future and failed entries', () => {
  const start = new Date(2026, 10, 12).getTime();
  const entries = [
    transaction({ status: 'confirmed', timestamp: start }),
    transaction({ signature: signature(2), status: 'confirmed', timestamp: start - 1 }),
    transaction({ signature: signature(3), status: 'confirmed', timestamp: now + 1 }),
  ];
  const week = summarizeHistory(entries, { range: '7d', now });
  assert.equal(week.totalClaimedLamports, 2_000_000);
  assert.equal(week.chartPoints.length, 8);
  assert.equal(week.chartPoints[0].timestamp, start);
  assert.equal(summarizeHistory(entries, { range: 'all', now }).confirmedCount, 2);
  assert.equal(summarizeHistory([], { range: '30d', now }).chartPoints.length, 31);
  assert.throws(() => summarizeHistory([], { range: 'year', now }), /date range/);
});

test('summary refuses overflowing totals rather than silently rounding lamports', () => {
  assert.throws(() => summarizeHistory([
    transaction({ status: 'confirmed', reclaimLamports: Number.MAX_SAFE_INTEGER }),
    transaction({ status: 'confirmed', signature: signature(2), reclaimLamports: Number.MAX_SAFE_INTEGER }),
  ], { now }), /too large/);
});

function confirmedTransaction(overrides = {}) {
  return {
    transaction: { signatures: [signature(1)], message: { accountKeys: [{ pubkey: owner, signer: true }] } },
    meta: { err: null, fee: 6_000, preBalances: [10_000_000], postBalances: [11_994_000] },
    ...overrides,
  };
}

test('reconciliation uses actual gross recovery, network fee, and signed net amount', () => {
  const entry = transaction({ reclaimLamports: 2_100_000 });
  const confirmed = reconcileHistoryEntry(entry, confirmedTransaction(), owner);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.reclaimLamports, 2_000_000);
  assert.equal(confirmed.feeLamports, 6_000);
  assert.equal(confirmed.actualNetLamports, 1_994_000);
  assert.equal(confirmed.timestamp, entry.timestamp);
  const summary = summarizeHistory([confirmed], { now });
  assert.equal(summary.totalClaimedLamports, 2_000_000);
  assert.equal(summary.claimedIsEstimated, false);
  const store = createHistoryStore({ storage: storage() });
  store.upsert(owner, confirmed);
  store.upsert(owner, transaction({ status: 'confirmed', reclaimLamports: 9_000_000 }));
  assert.equal(store.read(owner).entries[0].reclaimLamports, 2_000_000);
});

test('reconciliation rejects wrong signatures, payers and malformed balances', () => {
  for (const mutate of [
    (tx) => { tx.transaction.signatures[0] = signature(2); },
    (tx) => { tx.transaction.message.accountKeys[0] = otherOwner; },
    (tx) => { tx.meta.postBalances = []; },
    (tx) => { tx.meta.preBalances[0] = -1; },
    (tx) => { tx.meta.fee = 0.5; },
    (tx) => { delete tx.meta.err; },
  ]) {
    const tx = confirmedTransaction();
    mutate(tx);
    assert.throws(() => reconcileHistoryEntry(transaction(), tx, owner));
  }
});

test('failed confirmed transactions contribute only their actual SOL loss and fee', () => {
  const tx = confirmedTransaction();
  tx.meta.err = { InstructionError: [1, { Custom: 1 }] };
  tx.meta.postBalances = [9_994_000];
  const failed = reconcileHistoryEntry(transaction(), tx, owner);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reclaimLamports, 0);
  assert.equal(failed.actualNetLamports, -6_000);
  const summary = summarizeHistory([failed], { now });
  assert.equal(summary.totalClaimedLamports, 0);
  assert.equal(summary.totalFeeLamports, 6_000);
  assert.equal(summary.netLamports, -6_000);
  const store = createHistoryStore({ storage: storage() });
  store.upsert(owner, failed);
  const late = store.upsert(owner, transaction({ status: 'unknown' }));
  assert.equal(late.entries[0].status, 'failed');
  assert.equal(late.entries[0].actualNetLamports, -6_000);
});

test('old history entries default to no tip and estimated net subtracts only confirmed tips', () => {
  const store = createHistoryStore({ storage: storage() });
  store.upsert(owner, transaction({ status: 'confirmed' }));
  assert.equal(store.read(owner).entries[0].tipLamports, 0);
  const summary = summarizeHistory([
    transaction({ status: 'confirmed', tipLamports: 400_000 }),
    transaction({ signature: signature(2), status: 'sent', tipLamports: 400_000 }),
  ], { now });
  assert.equal(summary.totalClaimedLamports, 2_000_000);
  assert.equal(summary.totalTipLamports, 400_000);
  assert.equal(summary.netLamports, 1_595_000);
  assert.equal(summary.netIsEstimated, true);
  assert.match(store.upsert(owner, transaction({ tipLamports: -1 })).warning, /could not be recorded/);
  assert.match(store.upsert(owner, transaction({ tipLamports: 2_000_001 })).warning, /could not be recorded/);
});

test('tip reconciliation verifies the exact chain transfer and keeps gross recovery separate from net', () => {
  const ix = transferSolIx({ from: owner, to: TIP_RECIPIENT, lamports: 400_000 });
  const tx = confirmedTransaction();
  tx.transaction.message.accountKeys = [owner, TIP_RECIPIENT, '11111111111111111111111111111111'];
  tx.transaction.message.instructions = [{ programIdIndex: 2, accounts: [0, 1], data: encodeBase58(ix.data) }];
  tx.meta.preBalances = [10_000_000, 1_000_000, 1];
  tx.meta.postBalances = [11_594_000, 1_400_000, 1];
  const checked = reconcileHistoryEntry(transaction({ tipLamports: 400_000 }), tx, owner);
  assert.equal(checked.reclaimLamports, 2_000_000);
  assert.equal(checked.tipLamports, 400_000);
  assert.equal(checked.feeLamports, 6_000);
  assert.equal(checked.actualNetLamports, 1_594_000);
  const summary = summarizeHistory([checked], { now });
  assert.equal(summary.totalClaimedLamports, 2_000_000);
  assert.equal(summary.totalTipLamports, 400_000);
  assert.equal(summary.netLamports, 1_594_000);
  delete tx.transaction.message.instructions;
  assert.throws(() => reconcileHistoryEntry(transaction({ tipLamports: 400_000 }), tx, owner), /unavailable/);
});

test('failed tipped transactions record zero paid tip and only the actual network loss', () => {
  const tx = confirmedTransaction();
  tx.meta.err = { InstructionError: [3, { Custom: 1 }] };
  tx.meta.postBalances = [9_994_000];
  const checked = reconcileHistoryEntry(transaction({ tipLamports: 400_000 }), tx, owner);
  assert.equal(checked.tipLamports, 0);
  assert.equal(checked.reclaimLamports, 0);
  const summary = summarizeHistory([checked], { now });
  assert.equal(summary.totalTipLamports, 0);
  assert.equal(summary.netLamports, -6_000);
});
