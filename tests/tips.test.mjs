import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import { AccountLayout, TOKEN_PROGRAM_ID as SPL } from '@solana/spl-token';
import { LiteSVM, FailedTransactionMetadata } from 'litesvm';
import { TIP_RECIPIENT, TIP_BASIS_POINTS, calculateTip, batchTipLamports } from '../site/lib/tips.js';
import { transferSolIx, TOKEN_PROGRAM_ID } from '../site/lib/instructions.js';
import { buildBatchTransaction, measureBatch, packItems, PLACEHOLDER_BLOCKHASH } from '../site/lib/batch.js';
import { prepareBurnPlan, executeBurnPlan } from '../site/lib/flow.js';
import { computeUnitLimitFor, BASE_FEE_LAMPORTS } from '../site/lib/fees.js';
import { scanPumpRewards, PUMP_PROGRAM_ID } from '../site/lib/pump-rewards.js';
import { toBase64 } from '../site/lib/bytes.js';
import { encodeBase58 } from '../site/lib/base58.js';
import { checkReturnedTransaction } from '../site/lib/verify.js';

const ownerKey = Keypair.fromSeed(new Uint8Array(32).fill(61));
const owner = ownerKey.publicKey.toBase58();
const recipient = new PublicKey(TIP_RECIPIENT);
const address = () => Keypair.generate().publicKey.toBase58();
const item = (lamports = 2_039_280) => ({ action: 'close', account: { address: address(), programId: TOKEN_PROGRAM_ID, mint: address(), amount: 0n, decimals: 6, lamports } });
const build = (items, options = {}) => buildBatchTransaction({ owner, items, recentBlockhash: PLACEHOLDER_BLOCKHASH, computeUnitLimit: 50_000, computeUnitPrice: 10_000, ...options });
const transfer = (bytes) => Transaction.from(bytes).instructions.filter((ix) => ix.programId.equals(SystemProgram.programId));
const normalize = (ix) => ({ programId: ix.programId.toBase58(), keys: ix.keys.map((key) => ({ pubkey: key.pubkey.toBase58(), isSigner: key.isSigner, isWritable: key.isWritable })), data: new Uint8Array(ix.data) });

test('tip is explicit, fixed to 20 percent, rounded down exactly and excluded for the recipient wallet', () => {
  assert.equal(TIP_RECIPIENT, 'Eytg5SVVcLR2npxstQLjtLgns8MZ4TTdRCBsGmjFydo4');
  assert.equal(TIP_BASIS_POINTS, 2_000);
  assert.equal(calculateTip({ owner, reclaimLamports: 2_039_280 }), 0);
  assert.equal(calculateTip({ owner, reclaimLamports: 2_039_284, enabled: true }), 407_856);
  assert.equal(calculateTip({ owner, reclaimLamports: 4, enabled: true }), 0);
  assert.equal(calculateTip({ owner, reclaimLamports: 5, enabled: true }), 1);
  assert.equal(calculateTip({ owner: TIP_RECIPIENT, reclaimLamports: 2_039_280, enabled: true }), 0);
  assert.equal(calculateTip({ owner, reclaimLamports: Number.MAX_SAFE_INTEGER, enabled: true }), Number(BigInt(Number.MAX_SAFE_INTEGER) * 2_000n / 10_000n));
  assert.equal(batchTipLamports({ owner, items: [item(4), item(4)], withTip: true }), 1, 'rounding applies to the whole batch');
});

test('invalid owners, lamport amounts, item totals and non-boolean choices cannot produce a tip', async () => {
  for (const reclaimLamports of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '5', 5n, null]) {
    assert.throws(() => calculateTip({ owner, reclaimLamports, enabled: true }), /lamport|amount/i);
  }
  for (const enabled of [1, 'true', null]) assert.throws(() => calculateTip({ owner, reclaimLamports: 5, enabled }), /boolean/i);
  assert.throws(() => calculateTip({ owner: 'invalid', reclaimLamports: 5 }), /address/i);
  assert.throws(() => batchTipLamports({ owner, items: [item(Number.MAX_SAFE_INTEGER), item(1)], withTip: true }), /safe|large/i);
  assert.throws(() => batchTipLamports({ owner, items: [item(-1)], withTip: false }), /lamport|amount/i);
  assert.throws(() => build([item()], { withTip: 'true' }), /boolean/i);
  await assert.rejects(prepareBurnPlan({ rpc: {}, owner, items: [], withTip: 1 }), /boolean/i);
});

test('the SOL transfer matches official SystemProgram bytes and flags and validates all inputs', () => {
  const ours = transferSolIx({ from: owner, to: TIP_RECIPIENT, lamports: 407_856 });
  assert.deepEqual(ours, normalize(SystemProgram.transfer({ fromPubkey: ownerKey.publicKey, toPubkey: recipient, lamports: 407_856 })));
  for (const lamports of [0, -1, 0.2, NaN, Number.MAX_SAFE_INTEGER + 1, '1', 1n]) {
    assert.throws(() => transferSolIx({ from: owner, to: TIP_RECIPIENT, lamports }), /lamport|amount/i);
  }
  assert.throws(() => transferSolIx({ from: 'invalid', to: TIP_RECIPIENT, lamports: 1 }), /address/i);
  assert.throws(() => transferSolIx({ from: owner, to: 'invalid', lamports: 1 }), /address/i);
});

test('a tipped batch appends one fixed transfer after the claims; opting out and self claims contain none', () => {
  const items = [item(), item()];
  const tipped = build(items, { withTip: true, recipient: address() });
  const tx = Transaction.from(tipped.bytes);
  assert.equal(transfer(tipped.bytes).length, 1);
  const last = tx.instructions.at(-1);
  assert.equal(last.programId.toBase58(), SystemProgram.programId.toBase58());
  assert.equal(last.keys[0].pubkey.toBase58(), owner);
  assert.equal(last.keys[1].pubkey.toBase58(), TIP_RECIPIENT, 'a caller cannot override the recipient');
  assert.equal(Number(last.data.readBigUInt64LE(4)), 815_712);
  assert.equal(transfer(build(items).bytes).length, 0);
  assert.equal(transfer(build(items, { withTip: false }).bytes).length, 0);
  assert.equal(transfer(build(items, { owner: TIP_RECIPIENT, withTip: true }).bytes).length, 0);
  assert.equal(transfer(build([item(4)], { withTip: true }).bytes).length, 0, 'zero rounded tips do not add a transfer');
});

test('packing measures the enabled transfer and stays within the 1232 byte packet boundary', () => {
  const items = Array.from({ length: 70 }, () => item());
  const batches = packItems({ owner, items, withTip: true, maxItemsPerTx: 100 });
  assert.deepEqual(batches.flat(), items);
  assert.ok(batches.length > 1);
  for (const [index, batch] of batches.entries()) {
    assert.ok(measureBatch({ owner, items: batch, withTip: true }) <= 1232);
    if (index + 1 < batches.length) assert.ok(measureBatch({ owner, items: [...batch, batches[index + 1][0]], withTip: true }) > 1232);
  }
  const fourItems = items.slice(0, 4);
  const limit = measureBatch({ owner, items: fourItems });
  assert.equal(packItems({ owner, items: fourItems, sizeLimit: limit }).length, 1);
  const split = packItems({ owner, items: fourItems, sizeLimit: limit, withTip: true });
  assert.ok(split.length > 1, 'the transfer makes a previously fitting group split');
  assert.ok(split.every((batch) => measureBatch({ owner, items: batch, withTip: true }) <= limit));
});

test('plan simulation and execution use the same explicit tip and fee compute budget', async () => {
  const simulations = [];
  const sent = [];
  const rpc = {
    async getRecentPrioritizationFees() { return []; },
    async simulate(base64) {
      const tx = Transaction.from(Buffer.from(base64, 'base64'));
      simulations.push(tx);
      return { err: null, logs: [], unitsConsumed: transfer(Buffer.from(base64, 'base64')).length ? 10_150 : 10_000 };
    },
    async getLatestBlockhash() { return { blockhash: owner, lastValidBlockHeight: 100 }; },
    async send(base64) { const tx = VersionedTransaction.deserialize(Buffer.from(base64, 'base64')); sent.push(tx); return encodeBase58(tx.signatures[0]); },
    async getSignatureStatuses(signatures) { return signatures.map(() => ({ err: null, confirmationStatus: 'confirmed' })); },
  };
  const items = [item(8), item(8)];
  const defaultPlan = await prepareBurnPlan({ rpc, owner, items, maxItemsPerTx: 1 });
  assert.equal(defaultPlan.withTip, false);
  assert.equal(defaultPlan.tipLamports, 0);
  assert.ok(simulations.every((tx) => tx.instructions.every((ix) => !ix.programId.equals(SystemProgram.programId))));
  const plan = await prepareBurnPlan({ rpc, owner, items, maxItemsPerTx: 1, withTip: true });
  assert.equal(plan.withTip, true);
  assert.equal(plan.tipLamports, 2, 'exact sum of per-batch floors, not floor of all claims');
  assert.equal(plan.reclaimLamports, 16);
  assert.ok(plan.batches.every((batch) => batch.computeUnitLimit === computeUnitLimitFor(10_150)));
  const signer = { mode: 'sign', async signTransactions(list) { return list.map((bytes) => { const tx = VersionedTransaction.deserialize(bytes); tx.sign([ownerKey]); return tx.serialize(); }); } };
  const results = await executeBurnPlan({ rpc, signer, owner, plan, sleep: async () => {} });
  assert.ok(results.every((result) => result.status === 'confirmed'));
  assert.equal(sent.length, 2);
  for (const tx of sent) {
    const last = Transaction.from(tx.serialize()).instructions.at(-1);
    assert.equal(last.keys[1].pubkey.toBase58(), TIP_RECIPIENT);
    assert.equal(last.data.readBigUInt64LE(4), 1n);
  }
});

test('executing a declined-tip plan never adds a transfer at signing or sending', async () => {
  const seen = [];
  const rpc = {
    async getRecentPrioritizationFees() { return []; },
    async simulate(base64) { seen.push(...transfer(Buffer.from(base64, 'base64'))); return { err: null, logs: [], unitsConsumed: 10_000 }; },
    async getLatestBlockhash() { return { blockhash: owner, lastValidBlockHeight: 100 }; },
    async send(base64) { const tx = VersionedTransaction.deserialize(Buffer.from(base64, 'base64')); seen.push(...transfer(tx.serialize())); return encodeBase58(tx.signatures[0]); },
    async getSignatureStatuses(signatures) { return signatures.map(() => ({ err: null, confirmationStatus: 'confirmed' })); },
  };
  const plan = await prepareBurnPlan({ rpc, owner, items: [item()], withTip: false });
  const signer = { mode: 'sign', async signTransactions(list) { return list.map((bytes) => {
    seen.push(...transfer(bytes));
    const tx = VersionedTransaction.deserialize(bytes);
    tx.sign([ownerKey]);
    return tx.serialize();
  }); } };
  const results = await executeBurnPlan({ rpc, signer, owner, plan, sleep: async () => {} });
  assert.equal(results[0].status, 'confirmed');
  assert.equal(plan.tipLamports, 0);
  assert.deepEqual(seen, [], 'no System transfer exists in simulation, signing or submitted bytes');
});

test('failed simulated claims are excluded from both tip and gross totals', async () => {
  const bad = item(1_000);
  const good = item(8);
  const rpc = { async getRecentPrioritizationFees() { return []; }, async simulate(base64) {
    const tx = Transaction.from(Buffer.from(base64, 'base64'));
    const containsBad = tx.instructions.some((ix) => ix.keys.some((key) => key.pubkey.toBase58() === bad.account.address));
    return { err: containsBad ? { InstructionError: [2, { Custom: 17 }] } : null, logs: [], unitsConsumed: 10_000 };
  } };
  const plan = await prepareBurnPlan({ rpc, owner, items: [bad, good], withTip: true });
  assert.equal(plan.failed.length, 1);
  assert.equal(plan.reclaimLamports, 8);
  assert.equal(plan.tipLamports, 1);
  const empty = await prepareBurnPlan({ rpc, owner, items: [], withTip: true });
  assert.equal(empty.withTip, true);
  assert.equal(empty.tipLamports, 0);
});

test('Pump cashback and recovered rent share the same gross tip base', async () => {
  const raw = new Uint8Array(106);
  raw.set([86, 255, 112, 14, 102, 53, 154, 250]);
  raw.set(ownerKey.publicKey.toBytes(), 8);
  const reserve = 1_000_000;
  const rpc = { async getMultipleAccounts() { return [{ owner: PUMP_PROGRAM_ID, lamports: reserve + 125_000, executable: false, data: [toBase64(raw), 'base64'] }, null, null, null]; }, async getTokenAccounts() { return []; }, async getMinimumBalanceForRentExemption() { return reserve; } };
  const rewards = await scanPumpRewards({ rpc, owner });
  const mixed = [item(2_000_000), { action: 'claim-pump', account: rewards.accounts[0] }];
  assert.equal(batchTipLamports({ owner, items: mixed, withTip: true }), 625_000);
  assert.equal(transfer(build(mixed, { withTip: true }).bytes).length, 1);
});

test('signed transaction validation rejects an added, redirected or resized tip', () => {
  const expected = build([item()], { withTip: true });
  const sign = (transaction) => { transaction.sign(ownerKey); return transaction.serialize(); };
  assert.equal(checkReturnedTransaction({ signed: sign(Transaction.from(expected.bytes)), expected }).ok, true);
  const redirected = Transaction.from(expected.bytes);
  redirected.instructions.at(-1).keys[1].pubkey = new PublicKey(address());
  assert.equal(checkReturnedTransaction({ signed: sign(redirected), expected }).ok, false);
  const resized = Transaction.from(expected.bytes);
  resized.instructions.at(-1).data.writeBigUInt64LE(1n, 4);
  assert.equal(checkReturnedTransaction({ signed: sign(resized), expected }).ok, false);
  const optedOut = build([item()]);
  const added = Transaction.from(optedOut.bytes);
  added.add(SystemProgram.transfer({ fromPubkey: ownerKey.publicKey, toPubkey: recipient, lamports: 1 }));
  assert.equal(checkReturnedTransaction({ signed: sign(added), expected: optedOut }).ok, false);
});

function localChain() {
  const svm = new LiteSVM();
  svm.airdrop(ownerKey.publicKey, 1_000_000_000n);
  svm.airdrop(recipient, 1_000_000_000n);
  const token = new PublicKey(address());
  const data = Buffer.alloc(165);
  AccountLayout.encode({ mint: new PublicKey(address()), owner: ownerKey.publicKey, amount: 0n, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  const rent = Number(svm.minimumBalanceForRentExemption(165n));
  svm.setAccount(token, { lamports: rent, data, owner: SPL, executable: false });
  const claim = { action: 'close', account: { ...item(rent).account, address: token.toBase58() } };
  return { svm, token, rent, claim };
}

test('LiteSVM pays the opted-in tip only after rent recovery and leaves the entire transaction atomic', () => {
  for (const enabled of [false, true]) {
    const { svm, token, rent, claim } = localChain();
    const beforeOwner = svm.getBalance(ownerKey.publicKey);
    const beforeRecipient = svm.getBalance(recipient);
    const built = build([claim], { recentBlockhash: svm.latestBlockhash(), withTip: enabled, computeUnitPrice: 0 });
    const tx = VersionedTransaction.deserialize(built.bytes);
    tx.sign([ownerKey]);
    const result = svm.sendTransaction(tx);
    assert.equal(result instanceof FailedTransactionMetadata, false);
    assert.equal(svm.getAccount(token)?.lamports ?? 0, 0);
    const tip = calculateTip({ owner, reclaimLamports: rent, enabled });
    assert.equal(svm.getBalance(recipient) - beforeRecipient, BigInt(tip));
    assert.equal(svm.getBalance(ownerKey.publicKey) - beforeOwner, BigInt(rent - tip - BASE_FEE_LAMPORTS));
  }
  const { svm, token, claim } = localChain();
  const recipientBefore = svm.getBalance(recipient);
  // A false rent estimate makes the last transfer exceed recovered funds. The
  // close must roll back with it, leaving the recipient unchanged.
  const built = build([{ ...claim, account: { ...claim.account, lamports: 10_000_000_000 } }], { recentBlockhash: svm.latestBlockhash(), withTip: true, computeUnitPrice: 0 });
  const tx = VersionedTransaction.deserialize(built.bytes);
  tx.sign([ownerKey]);
  assert.equal(svm.sendTransaction(tx) instanceof FailedTransactionMetadata, true);
  assert.equal(svm.getBalance(recipient), recipientBefore);
  assert.ok(svm.getAccount(token).lamports > 0, 'failed tip rolls back the preceding close');
});
