import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, Transaction, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import {
  createCloseAccountInstruction,
  createBurnCheckedInstruction,
  TOKEN_PROGRAM_ID as SPL,
  TOKEN_2022_PROGRAM_ID as T22,
} from '@solana/spl-token';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  closeAccountIx,
  burnCheckedIx,
  setComputeUnitLimitIx,
  setComputeUnitPriceIx,
} from '../site/lib/instructions.js';
import { buildUnsignedTransaction, PACKET_DATA_SIZE, readFirstSignature } from '../site/lib/tx.js';
import { encodeBase58 } from '../site/lib/base58.js';

const key = () => Keypair.generate().publicKey;
const refPlain = (ix) => ({
  programId: ix.programId.toBase58(),
  keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: [...ix.data],
});
const ownPlain = (ix) => ({ programId: ix.programId, keys: ix.keys, data: [...ix.data] });

test('program ids match the official libraries', () => {
  assert.equal(TOKEN_PROGRAM_ID, SPL.toBase58());
  assert.equal(TOKEN_2022_PROGRAM_ID, T22.toBase58());
  assert.equal(COMPUTE_BUDGET_PROGRAM_ID, ComputeBudgetProgram.programId.toBase58());
});

for (const [name, programId] of [['SPL Token', SPL], ['Token-2022', T22]]) {
  test(`closeAccount matches spl-token (${name})`, () => {
    const [account, owner] = [key(), key()];
    const ref = createCloseAccountInstruction(account, owner, owner, [], programId);
    const own = closeAccountIx({
      programId: programId.toBase58(),
      account: account.toBase58(),
      destination: owner.toBase58(),
      owner: owner.toBase58(),
    });
    assert.deepEqual(ownPlain(own), refPlain(ref));
  });

  test(`burnChecked matches spl-token (${name})`, () => {
    const [account, mint, owner] = [key(), key(), key()];
    const amount = 123456789012345678n;
    const ref = createBurnCheckedInstruction(account, mint, owner, amount, 9, [], programId);
    const own = burnCheckedIx({
      programId: programId.toBase58(),
      account: account.toBase58(),
      mint: mint.toBase58(),
      owner: owner.toBase58(),
      amount,
      decimals: 9,
    });
    assert.deepEqual(ownPlain(own), refPlain(ref));
  });
}

test('compute budget instructions match web3.js', () => {
  assert.deepEqual(ownPlain(setComputeUnitLimitIx(250_000)), refPlain(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 })));
  assert.deepEqual(ownPlain(setComputeUnitPriceIx(12_345)), refPlain(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 12_345 })));
});

test('instruction builders reject unknown programs and bad values', () => {
  const k = key().toBase58();
  assert.throws(() => closeAccountIx({ programId: k, account: k, destination: k, owner: k }), /token program/);
  const base = { programId: TOKEN_PROGRAM_ID, account: k, mint: k, owner: k, decimals: 6 };
  assert.throws(() => burnCheckedIx({ ...base, amount: 0n }), /amount/);
  assert.throws(() => burnCheckedIx({ ...base, amount: 5 }), /amount/);
  assert.throws(() => burnCheckedIx({ ...base, amount: 1n, decimals: 256 }), /decimals/);
  assert.throws(() => closeAccountIx({ programId: TOKEN_PROGRAM_ID, account: 'xyz', destination: k, owner: k }), /address/);
  assert.throws(() => setComputeUnitLimitIx(0), RangeError);
  assert.throws(() => setComputeUnitLimitIx(1_400_001), RangeError);
  assert.throws(() => setComputeUnitPriceIx(-1), RangeError);
});

function scenario() {
  const owner = key();
  const blockhash = key().toBase58();
  const [acc1, acc2, acc3, mint2] = [key(), key(), key(), key()];
  const o = owner.toBase58();
  const own = [
    setComputeUnitLimitIx(200_000),
    setComputeUnitPriceIx(5_000),
    closeAccountIx({ programId: TOKEN_PROGRAM_ID, account: acc1.toBase58(), destination: o, owner: o }),
    burnCheckedIx({ programId: TOKEN_2022_PROGRAM_ID, account: acc2.toBase58(), mint: mint2.toBase58(), owner: o, amount: 42n, decimals: 6 }),
    closeAccountIx({ programId: TOKEN_2022_PROGRAM_ID, account: acc2.toBase58(), destination: o, owner: o }),
    closeAccountIx({ programId: TOKEN_PROGRAM_ID, account: acc3.toBase58(), destination: o, owner: o }),
  ];
  const ref = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 }),
    createCloseAccountInstruction(acc1, owner, owner, [], SPL),
    createBurnCheckedInstruction(acc2, mint2, owner, 42n, 6, [], T22),
    createCloseAccountInstruction(acc2, owner, owner, [], T22),
    createCloseAccountInstruction(acc3, owner, owner, [], SPL),
  ];
  return { owner, blockhash, own, ref };
}

// In einer Legacy-Nachricht gelten Signer- und Schreibrechte je Konto für alle Anweisungen.
function mergedFlags(feePayer, instructions) {
  const flags = new Map([[feePayer, { s: true, w: true }]]);
  for (const ix of instructions) {
    for (const k of ix.keys) {
      const id = k.pubkey.toBase58();
      const prev = flags.get(id) ?? { s: false, w: false };
      flags.set(id, { s: prev.s || k.isSigner, w: prev.w || k.isWritable });
    }
  }
  return flags;
}

test('web3.js decodes our transaction to exactly the intended instructions', () => {
  const { owner, blockhash, own, ref } = scenario();
  const { bytes, size } = buildUnsignedTransaction({ feePayer: owner.toBase58(), recentBlockhash: blockhash, instructions: own });
  assert.equal(size, bytes.length);
  assert.ok(size <= PACKET_DATA_SIZE);

  const decoded = Transaction.from(bytes);
  assert.equal(decoded.feePayer.toBase58(), owner.toBase58());
  assert.equal(decoded.recentBlockhash, blockhash);
  const flags = mergedFlags(owner.toBase58(), ref);
  const expected = ref.map((ix) => ({
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => {
      const f = flags.get(k.pubkey.toBase58());
      return { pubkey: k.pubkey.toBase58(), isSigner: f.s, isWritable: f.w };
    }),
    data: [...ix.data],
  }));
  assert.deepEqual(decoded.instructions.map(refPlain), expected);
});

test('message header, key set and size equal what web3.js compiles', () => {
  const { owner, blockhash, own, ref } = scenario();
  const ours = buildUnsignedTransaction({ feePayer: owner.toBase58(), recentBlockhash: blockhash, instructions: own });
  const refTx = new Transaction({ feePayer: owner, recentBlockhash: blockhash }).add(...ref);
  const refMsg = refTx.compileMessage();
  assert.deepEqual(ours.message.header, refMsg.header);
  assert.deepEqual(new Set(ours.message.accountKeys), new Set(refMsg.accountKeys.map((k) => k.toBase58())));
  assert.equal(ours.bytes.length, refTx.serialize({ requireAllSignatures: false, verifySignatures: false }).length);
  for (const [i, k] of ours.message.accountKeys.entries()) {
    const j = refMsg.accountKeys.findIndex((r) => r.toBase58() === k);
    assert.equal(i < ours.message.header.numRequiredSignatures, refMsg.isAccountSigner(j), `signer ${k}`);
  }
});

test('wire format: one empty signature slot, then a message web3.js re-serializes identically', () => {
  const { owner, blockhash, own } = scenario();
  const { bytes, messageBytes } = buildUnsignedTransaction({ feePayer: owner.toBase58(), recentBlockhash: blockhash, instructions: own });
  assert.equal(bytes[0], 1);
  assert.deepEqual(bytes.slice(1, 65), new Uint8Array(64));
  assert.deepEqual(bytes.slice(65), messageBytes);
  const vtx = VersionedTransaction.deserialize(bytes);
  assert.deepEqual(new Uint8Array(vtx.message.serialize()), messageBytes);
});

test('readFirstSignature returns the fee payer signature in base58', () => {
  const signer = Keypair.generate();
  const { blockhash, own } = scenario();
  const rebased = own.map((ix) => ({
    ...ix,
    keys: ix.keys.map((k) => (k.isSigner ? { ...k, pubkey: signer.publicKey.toBase58() } : k)),
  }));
  const { bytes } = buildUnsignedTransaction({ feePayer: signer.publicKey.toBase58(), recentBlockhash: blockhash, instructions: rebased });
  const vtx = VersionedTransaction.deserialize(bytes);
  vtx.sign([signer]);
  const signed = vtx.serialize();
  assert.equal(readFirstSignature(signed), encodeBase58(vtx.signatures[0]));
  assert.throws(() => readFirstSignature(Uint8Array.of(0)), /signature/);
});

test('building a transaction without instructions fails', () => {
  assert.throws(() => buildUnsignedTransaction({ feePayer: key().toBase58(), recentBlockhash: key().toBase58(), instructions: [] }), /instructions/);
});
