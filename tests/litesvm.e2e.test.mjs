// Ende-zu-Ende gegen die echten SPL-Token-Programme (LiteSVM führt sie lokal aus).
// Prüft: unsere Transaktionen verbrennen und schließen wirklich, die Miete landet bei der Wallet,
// und der Ablauf aus Simulation, Unterschrift, Senden und Bestätigen funktioniert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiteSVM, FailedTransactionMetadata } from 'litesvm';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  MintLayout,
  AccountLayout,
  MINT_SIZE,
  ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID as SPL,
  TOKEN_2022_PROGRAM_ID as T22,
  ExtensionType,
  getAccountLen,
} from '@solana/spl-token';
import { buildBatchTransaction } from '../site/lib/batch.js';
import { closeAccountIx } from '../site/lib/instructions.js';
import { buildUnsignedTransaction } from '../site/lib/tx.js';
import { prepareBurnPlan, executeBurnPlan } from '../site/lib/flow.js';
import { encodeBase58 } from '../site/lib/base58.js';
import { fromBase64 } from '../site/lib/bytes.js';
import { BASE_FEE_LAMPORTS, priorityFeeLamports } from '../site/lib/fees.js';

function mintData({ supply, decimals, authority }) {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    { mintAuthorityOption: 1, mintAuthority: authority, supply, decimals, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default },
    data,
  );
  return data;
}

function tokenAccountData({ mint, owner, amount, token2022 = false, frozen = false }) {
  const base = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: frozen ? 2 : 1,
      isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
    },
    base,
  );
  if (!token2022) return base;
  // Token-2022-Konto mit Erweiterung ImmutableOwner: Kontotyp 2, dann TLV (Typ 7, Länge 0)
  const data = Buffer.alloc(getAccountLen([ExtensionType.ImmutableOwner]));
  base.copy(data, 0);
  data[ACCOUNT_SIZE] = 2;
  data.writeUInt16LE(ExtensionType.ImmutableOwner, ACCOUNT_SIZE + 1);
  data.writeUInt16LE(0, ACCOUNT_SIZE + 3);
  return data;
}

function setup({ sigverify = true } = {}) {
  const svm = new LiteSVM().withSigverify(sigverify);
  const owner = Keypair.generate();
  svm.airdrop(owner.publicKey, 2_000_000_000n);
  const rent = (len) => Number(svm.minimumBalanceForRentExemption(BigInt(len)));
  const put = (programId, data) => {
    const address = Keypair.generate().publicKey;
    svm.setAccount(address, { lamports: rent(data.length), data: new Uint8Array(data), owner: programId, executable: false });
    return address;
  };
  const mintSpl = put(SPL, mintData({ supply: 1010n, decimals: 6, authority: owner.publicKey }));
  const mint22 = put(T22, mintData({ supply: 500n, decimals: 9, authority: owner.publicKey }));
  const o = owner.publicKey;
  const accounts = {
    splEmpty: { programId: SPL, mint: mintSpl, address: put(SPL, tokenAccountData({ mint: mintSpl, owner: o, amount: 0n })), amount: 0n, decimals: 6 },
    splFull: { programId: SPL, mint: mintSpl, address: put(SPL, tokenAccountData({ mint: mintSpl, owner: o, amount: 1000n })), amount: 1000n, decimals: 6 },
    t22Empty: { programId: T22, mint: mint22, address: put(T22, tokenAccountData({ mint: mint22, owner: o, amount: 0n, token2022: true })), amount: 0n, decimals: 9 },
    t22Full: { programId: T22, mint: mint22, address: put(T22, tokenAccountData({ mint: mint22, owner: o, amount: 500n, token2022: true })), amount: 500n, decimals: 9 },
    splFrozen: { programId: SPL, mint: mintSpl, address: put(SPL, tokenAccountData({ mint: mintSpl, owner: o, amount: 0n, frozen: true })), amount: 0n, decimals: 6 },
    t22Frozen: { programId: T22, mint: mint22, address: put(T22, tokenAccountData({ mint: mint22, owner: o, amount: 0n, token2022: true, frozen: true })), amount: 0n, decimals: 9 },
    splFrozenFull: { programId: SPL, mint: mintSpl, address: put(SPL, tokenAccountData({ mint: mintSpl, owner: o, amount: 10n, frozen: true })), amount: 10n, decimals: 6 },
  };
  for (const acc of Object.values(accounts)) acc.lamports = Number(svm.getBalance(acc.address));
  return { svm, owner, mintSpl, mint22, accounts };
}

const asItem = (acc) => ({
  action: acc.amount > 0n ? 'burn' : 'close',
  account: { address: acc.address.toBase58(), programId: acc.programId.toBase58(), mint: acc.mint.toBase58(), amount: acc.amount, decimals: acc.decimals, lamports: acc.lamports },
});
const isClosed = (svm, address) => {
  const acc = svm.getAccount(address);
  return acc === null || acc.lamports === 0;
};
const supplyOf = (svm, mint) => MintLayout.decode(Buffer.from(svm.getAccount(mint).data.slice(0, MINT_SIZE))).supply;

test('a signed batch burns, closes and pays the rent back to the wallet', () => {
  const { svm, owner, mintSpl, mint22, accounts } = setup();
  const picked = [accounts.splEmpty, accounts.splFull, accounts.t22Empty, accounts.t22Full];
  const before = svm.getBalance(owner.publicKey);
  const limit = 200_000;
  const price = 1_000;
  const { bytes } = buildBatchTransaction({
    owner: owner.publicKey.toBase58(),
    items: picked.map(asItem),
    recentBlockhash: svm.latestBlockhash(),
    computeUnitLimit: limit,
    computeUnitPrice: price,
  });
  const vtx = VersionedTransaction.deserialize(bytes);
  vtx.sign([owner]);
  const result = svm.sendTransaction(vtx);
  assert.ok(!(result instanceof FailedTransactionMetadata), String(result instanceof FailedTransactionMetadata ? result.meta().prettyLogs() : ''));

  for (const acc of picked) assert.ok(isClosed(svm, acc.address), `nicht geschlossen: ${acc.address.toBase58()}`);
  assert.equal(supplyOf(svm, mintSpl), 10n); // 1.010 − 1.000 verbrannt; die 10 im eingefrorenen Konto bleiben
  assert.equal(supplyOf(svm, mint22), 0n);
  const rentBack = picked.reduce((sum, acc) => sum + acc.lamports, 0);
  // LiteSVM zieht nur die Grundgebühr ab; das echte Netz zusätzlich die Prioritätsgebühr.
  const gained = Number(svm.getBalance(owner.publicKey) - before);
  assert.ok(gained <= rentBack - BASE_FEE_LAMPORTS, `gained ${gained}`);
  assert.ok(gained >= rentBack - BASE_FEE_LAMPORTS - priorityFeeLamports(limit, price), `gained ${gained}`);
  assert.ok(accounts.t22Empty.lamports > accounts.splEmpty.lamports);
});

test('frozen accounts: empty ones can be closed, full ones cannot be burned', () => {
  const { svm, owner, accounts } = setup();
  const send = (picked) => {
    const { bytes } = buildBatchTransaction({
      owner: owner.publicKey.toBase58(),
      items: picked.map(asItem),
      recentBlockhash: svm.latestBlockhash(),
      computeUnitLimit: 200_000,
      computeUnitPrice: 0,
    });
    const vtx = VersionedTransaction.deserialize(bytes);
    vtx.sign([owner]);
    return svm.sendTransaction(vtx);
  };
  assert.ok(!(send([accounts.splFrozen, accounts.t22Frozen]) instanceof FailedTransactionMetadata));
  assert.ok(isClosed(svm, accounts.splFrozen.address));
  assert.ok(isClosed(svm, accounts.t22Frozen.address));
  svm.expireBlockhash();
  assert.ok(send([accounts.splFrozenFull]) instanceof FailedTransactionMetadata);
  assert.equal(isClosed(svm, accounts.splFrozenFull.address), false);
});

test('the token program refuses to close a non-empty account (why we burn first)', () => {
  const { svm, owner, accounts } = setup();
  const o = owner.publicKey.toBase58();
  const { bytes } = buildUnsignedTransaction({
    feePayer: o,
    recentBlockhash: svm.latestBlockhash(),
    instructions: [closeAccountIx({ programId: SPL.toBase58(), account: accounts.splFull.address.toBase58(), destination: o, owner: o })],
  });
  const vtx = VersionedTransaction.deserialize(bytes);
  vtx.sign([owner]);
  const result = svm.sendTransaction(vtx);
  assert.ok(result instanceof FailedTransactionMetadata);
  assert.equal(isClosed(svm, accounts.splFull.address), false);
});

test('a transaction signed by a different key is rejected', () => {
  const { svm, owner, accounts } = setup();
  const { bytes } = buildBatchTransaction({
    owner: owner.publicKey.toBase58(),
    items: [asItem(accounts.splEmpty)],
    recentBlockhash: svm.latestBlockhash(),
    computeUnitLimit: 50_000,
    computeUnitPrice: 0,
  });
  const vtx = VersionedTransaction.deserialize(bytes);
  assert.throws(() => vtx.sign([Keypair.generate()]));
  assert.equal(isClosed(svm, accounts.splEmpty.address), false);
});

// RPC-Ersatz auf LiteSVM: Antworten in der Form der echten JSON-RPC-Schnittstelle
function toRpcError(err) {
  // LiteSVM liefert native Klassen; erkannt an ihrer Form (Index plus innerer Fehler mit Code)
  if (typeof err?.index === 'number' && typeof err?.err === 'function') {
    const inner = err.err();
    return { InstructionError: [err.index, typeof inner?.code === 'number' ? { Custom: inner.code } : String(inner)] };
  }
  return String(err);
}
function svmRpc(svm) {
  const statuses = new Map();
  const meta = (r) => (r instanceof FailedTransactionMetadata ? r.meta() : r.meta?.() ?? r);
  return {
    async getRecentPrioritizationFees() { return []; },
    async simulate(b64) {
      const vtx = VersionedTransaction.deserialize(fromBase64(b64));
      vtx.message.recentBlockhash = svm.latestBlockhash();
      const r = svm.simulateTransaction(vtx);
      const m = meta(r);
      return { err: r instanceof FailedTransactionMetadata ? toRpcError(r.err()) : null, logs: m.logs(), unitsConsumed: Number(m.computeUnitsConsumed()) };
    },
    async getLatestBlockhash() { return { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000_000 }; },
    async getBlockHeight() { return 1; },
    async send(b64) {
      const vtx = VersionedTransaction.deserialize(fromBase64(b64));
      const r = svm.sendTransaction(vtx);
      const signature = encodeBase58(vtx.signatures[0]);
      statuses.set(signature, { confirmationStatus: 'confirmed', err: r instanceof FailedTransactionMetadata ? toRpcError(r.err()) : null });
      return signature;
    },
    async getSignatureStatuses(signatures) { return signatures.map((s) => statuses.get(s) ?? null); },
  };
}

test('the full flow (simulate, isolate, sign, send, confirm) works against the real programs', async () => {
  const { svm, owner, accounts } = setup({ sigverify: false });
  const rpc = svmRpc(svm);
  const items = Object.values(accounts).map(asItem);
  const plan = await prepareBurnPlan({ rpc, owner: owner.publicKey.toBase58(), items });
  assert.equal(plan.failed.length, 1, JSON.stringify(plan.failed.map((f) => f.error)));
  assert.equal(plan.failed[0].item.account.address, accounts.splFrozenFull.address.toBase58());
  assert.match(plan.failed[0].error, /frozen/);

  const signer = {
    mode: 'sign',
    async signTransactions(list) {
      return list.map((bytes) => {
        const vtx = VersionedTransaction.deserialize(bytes);
        vtx.sign([owner]);
        return vtx.serialize();
      });
    },
  };
  const before = svm.getBalance(owner.publicKey);
  const results = await executeBurnPlan({ rpc, signer, owner: owner.publicKey.toBase58(), plan, sleep: async () => {} });
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.status === 'confirmed'), JSON.stringify(results.map((r) => [r.status, r.error])));
  for (const name of ['splEmpty', 'splFull', 't22Empty', 't22Full', 'splFrozen', 't22Frozen']) {
    assert.ok(isClosed(svm, accounts[name].address), name);
  }
  assert.equal(isClosed(svm, accounts.splFrozenFull.address), false);
  const gained = Number(svm.getBalance(owner.publicKey) - before);
  assert.ok(gained > 0 && gained <= plan.reclaimLamports, `gained ${gained}`);
  assert.ok(plan.reclaimLamports - gained <= plan.networkFeeLamports, 'Gebühren höher als geschätzt');
});
