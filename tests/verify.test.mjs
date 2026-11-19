// Die Wallet muss genau das unterschreiben, was simuliert wurde. Erlaubt sind nur angepasste
// Rechenbudget-Anweisungen (gedeckelt) und Lighthouse-Prüfanweisungen, wie Phantom sie anhängt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Message, Keypair } from '@solana/web3.js';
import { buildUnsignedTransaction, decompileLegacyMessage } from '../site/lib/tx.js';
import { buildBatchTransaction } from '../site/lib/batch.js';
import { setComputeUnitLimitIx, setComputeUnitPriceIx, TOKEN_PROGRAM_ID } from '../site/lib/instructions.js';
import { checkReturnedTransaction, LIGHTHOUSE_PROGRAM_ID } from '../site/lib/verify.js';
import { concatBytes, u64LE } from '../site/lib/bytes.js';
import { randomAddress } from './support/fixtures.mjs';

const owner = randomAddress();
const blockhash = randomAddress();
const items = [
  { action: 'close', account: { address: randomAddress(), programId: TOKEN_PROGRAM_ID, mint: randomAddress(), amount: 0n, decimals: 6, lamports: 2039280 } },
  { action: 'burn', account: { address: randomAddress(), programId: TOKEN_PROGRAM_ID, mint: randomAddress(), amount: 77n, decimals: 6, lamports: 2039280 } },
];
const expected = buildBatchTransaction({ owner, items, recentBlockhash: blockhash, computeUnitLimit: 20_000, computeUnitPrice: 10_000 });
const ours = expected.message.instructions; // kompiliert
const signedCopy = (bytes) => {
  const copy = bytes.slice();
  copy.fill(7, 1, 65);
  return copy;
};
const rebuild = (instructions, { feePayer = owner, recentBlockhash = blockhash } = {}) =>
  signedCopy(buildUnsignedTransaction({ feePayer, recentBlockhash, instructions }).bytes);
// Die eigenen Anweisungen ohne Rechenbudget, als unkompilierte Liste
const ownInstructions = () => decompileLegacyMessage(expected.messageBytes).instructions.slice(2);

test('decompileLegacyMessage reads what web3.js reads', () => {
  const ref = Message.from(Buffer.from(expected.messageBytes));
  const own = decompileLegacyMessage(expected.messageBytes);
  assert.deepEqual(own.header, ref.header);
  assert.deepEqual(own.accountKeys, ref.accountKeys.map((k) => k.toBase58()));
  assert.equal(own.recentBlockhash, ref.recentBlockhash);
  assert.equal(own.instructions.length, ours.length);
  own.instructions.forEach((ix, i) => {
    assert.equal(ix.programId, ref.accountKeys[ref.instructions[i].programIdIndex].toBase58());
    assert.deepEqual([...ix.data], [...Buffer.from(require58(ref.instructions[i].data))]);
  });
  assert.throws(() => decompileLegacyMessage(Uint8Array.of(0x80, 1, 2)), /version/);
  assert.throws(() => decompileLegacyMessage(expected.messageBytes.slice(0, 40)), /short|incomplete/);
});

// web3.js speichert kompilierte Anweisungsdaten als Base58
function require58(text) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const ch of text) n = n * 58n + BigInt(ALPHABET.indexOf(ch));
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const ch of text) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return bytes;
}

test('accepts the unchanged transaction', () => {
  assert.deepEqual(checkReturnedTransaction({ signed: signedCopy(expected.bytes), expected }), { ok: true });
});

test('rejects a transaction with an extra SOL transfer', () => {
  const transfer = {
    programId: '11111111111111111111111111111111',
    keys: [{ pubkey: owner, isSigner: true, isWritable: true }, { pubkey: randomAddress(), isSigner: false, isWritable: true }],
    data: concatBytes([Uint8Array.of(2, 0, 0, 0), u64LE(1_000_000_000n)]),
  };
  const result = checkReturnedTransaction({ signed: rebuild([setComputeUnitLimitIx(20_000), setComputeUnitPriceIx(10_000), ...ownInstructions(), transfer]), expected });
  assert.equal(result.ok, false);
  assert.match(result.reason, /changed/);
});

test('rejects swapped token instructions, other payers, other blockhashes and extra signers', () => {
  const swapped = ownInstructions().reverse();
  assert.equal(checkReturnedTransaction({ signed: rebuild([setComputeUnitLimitIx(20_000), setComputeUnitPriceIx(10_000), ...swapped]), expected }).ok, false);
  const otherPayer = rebuild([setComputeUnitLimitIx(20_000), ...ownInstructions()], { feePayer: randomAddress() });
  assert.equal(checkReturnedTransaction({ signed: otherPayer, expected }).ok, false);
  const otherHash = rebuild([setComputeUnitLimitIx(20_000), ...ownInstructions()], { recentBlockhash: randomAddress() });
  assert.equal(checkReturnedTransaction({ signed: otherHash, expected }).ok, false);
  const extraSigner = ownInstructions().map((ix, i) => (i === 0 ? { ...ix, keys: [...ix.keys, { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: true, isWritable: false }] } : ix));
  assert.equal(checkReturnedTransaction({ signed: rebuild(extraSigner), expected }).ok, false);
  assert.equal(checkReturnedTransaction({ signed: Uint8Array.of(1, 2, 3), expected }).ok, false);
});

test('tolerates Lighthouse checks and a modestly higher priority fee from the wallet', () => {
  const lighthouse = { programId: LIGHTHOUSE_PROGRAM_ID, keys: [{ pubkey: owner, isSigner: false, isWritable: false }], data: Uint8Array.of(9, 1, 2) };
  const tolerated = rebuild([setComputeUnitLimitIx(30_000), setComputeUnitPriceIx(200_000), ...ownInstructions(), lighthouse]);
  assert.deepEqual(checkReturnedTransaction({ signed: tolerated, expected }), { ok: true });
});

test('rejects a priority fee far above the plan', () => {
  const greedy = rebuild([setComputeUnitLimitIx(1_400_000), setComputeUnitPriceIx(5_000_000), ...ownInstructions()]);
  const result = checkReturnedTransaction({ signed: greedy, expected });
  assert.equal(result.ok, false);
  assert.match(result.reason, /fee/i);
});
