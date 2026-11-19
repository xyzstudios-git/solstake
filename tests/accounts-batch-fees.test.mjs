import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transaction } from '@solana/web3.js';
import { classifyTokenAccount, classifyAll, STATUS, PROTECTED_MINTS, impersonates } from '../site/lib/accounts.js';
import { packItems, buildBatchTransaction, measureBatch, instructionsForItem, PLACEHOLDER_BLOCKHASH } from '../site/lib/batch.js';
import { choosePriorityFee, computeUnitLimitFor, priorityFeeLamports, estimateNetworkFee, BASE_FEE_LAMPORTS } from '../site/lib/fees.js';
import { PACKET_DATA_SIZE } from '../site/lib/tx.js';
import { TOKEN, TOKEN_2022, WSOL, randomAddress, tokenEntry } from './support/fixtures.mjs';

const owner = randomAddress();
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test('classifies empty, held, frozen and protected accounts', () => {
  const cases = [
    [tokenEntry({ owner }), STATUS.EMPTY, 'close'],
    [tokenEntry({ owner, amount: '1500000' }), STATUS.HOLDING, 'burn'],
    [tokenEntry({ owner, amount: '5', state: 'frozen' }), STATUS.FROZEN, null],
    [tokenEntry({ owner, state: 'frozen' }), STATUS.EMPTY, 'close'],
    [tokenEntry({ owner, state: 'uninitialized' }), STATUS.UNKNOWN, null],
    [tokenEntry({ owner, closeAuthority: randomAddress() }), STATUS.FOREIGN_CLOSE, null],
    [tokenEntry({ owner, closeAuthority: owner }), STATUS.EMPTY, 'close'],
    [tokenEntry({ owner, amount: '1', decimals: 0 }), STATUS.NFT, null],
    [tokenEntry({ owner, mint: WSOL, isNative: true }), STATUS.EMPTY, 'close'],
    [tokenEntry({ owner, mint: WSOL, isNative: true, amount: '5000' }), STATUS.WSOL, null],
  ];
  for (const [entry, status, action] of cases) {
    const acc = classifyTokenAccount(entry, owner);
    assert.equal(acc.status, status, JSON.stringify(entry.account.data.parsed.info));
    assert.equal(acc.action, action);
    if (!action) assert.ok(acc.reason.length > 0);
  }
});

test('reads Token-2022 extensions that block closing', () => {
  const withheld = tokenEntry({
    owner,
    programId: TOKEN_2022,
    extensions: [{ extension: 'immutableOwner' }, { extension: 'transferFeeAmount', state: { withheldAmount: 12 } }],
  });
  const fine = tokenEntry({
    owner,
    programId: TOKEN_2022,
    lamports: 1574800,
    extensions: [{ extension: 'immutableOwner' }, { extension: 'transferFeeAmount', state: { withheldAmount: 0 } }],
  });
  const confidential = tokenEntry({ owner, programId: TOKEN_2022, extensions: [{ extension: 'confidentialTransferAccount', state: {} }] });
  assert.equal(classifyTokenAccount(withheld, owner).status, STATUS.WITHHELD);
  const ok = classifyTokenAccount(fine, owner);
  assert.equal(ok.status, STATUS.EMPTY);
  assert.equal(ok.programId, TOKEN_2022);
  assert.equal(ok.lamports, 1574800);
  assert.equal(classifyTokenAccount(confidential, owner).status, STATUS.CONFIDENTIAL);
});

test('protects well-known valuable tokens from burning but still closes their empty accounts', () => {
  const held = classifyTokenAccount(tokenEntry({ owner, mint: USDC_MINT, amount: '5000000' }), owner);
  assert.equal(held.status, STATUS.PROTECTED);
  assert.equal(held.action, null);
  assert.match(held.reason, /selling/);
  assert.equal(classifyTokenAccount(tokenEntry({ owner, mint: USDC_MINT }), owner).action, 'close');
  assert.ok(Object.keys(PROTECTED_MINTS).length >= 8);
});

test('flags tokens that borrow the name of a protected token', () => {
  assert.equal(impersonates({ name: 'USD Coin', symbol: 'USDC' }, randomAddress()), 'USDC');
  assert.equal(impersonates({ name: 'Fake', symbol: 'usdc' }, randomAddress()), 'USDC');
  assert.equal(impersonates({ name: 'Jupiter', symbol: 'JUP' }, randomAddress()), 'JUP');
  assert.equal(impersonates({ name: 'USD Coin', symbol: 'USDC' }, USDC_MINT), null);
  assert.equal(impersonates({ name: 'Bonk', symbol: 'BONK' }, randomAddress()), null);
  assert.equal(impersonates(undefined, randomAddress()), null);
});

test('treats foreign or malformed entries as unknown', () => {
  assert.equal(classifyTokenAccount(tokenEntry({ owner: randomAddress() }), owner).status, STATUS.UNKNOWN);
  assert.equal(classifyTokenAccount({ pubkey: randomAddress(), account: {} }, owner).status, STATUS.UNKNOWN);
  assert.equal(classifyTokenAccount(null, owner).status, STATUS.UNKNOWN);
  const badProgram = tokenEntry({ owner });
  badProgram.account.owner = randomAddress();
  assert.equal(classifyTokenAccount(badProgram, owner).status, STATUS.UNKNOWN);
  const badAmount = tokenEntry({ owner, amount: '-3' });
  assert.equal(classifyTokenAccount(badAmount, owner).status, STATUS.UNKNOWN);
});

test('classifyAll keeps the amount as an exact bigint', () => {
  const [acc] = classifyAll([tokenEntry({ owner, amount: '18446744073709551615', decimals: 9 })], owner);
  assert.equal(acc.amount, 18446744073709551615n);
  assert.equal(acc.decimals, 9);
});

function makeItems(count) {
  return Array.from({ length: count }, (_, i) => {
    const burn = i % 2 === 1;
    return {
      action: burn ? 'burn' : 'close',
      account: {
        address: randomAddress(),
        programId: i % 3 === 0 ? TOKEN_2022 : TOKEN,
        mint: randomAddress(),
        amount: burn ? 1000n + BigInt(i) : 0n,
        decimals: 6,
        lamports: 2039280,
      },
    };
  });
}

test('instructionsForItem burns the whole balance, then closes to the owner', () => {
  const [close, burn] = makeItems(2);
  const closeIxs = instructionsForItem({ owner, item: close });
  assert.equal(closeIxs.length, 1);
  assert.deepEqual([...closeIxs[0].data], [9]);
  assert.equal(closeIxs[0].keys[1].pubkey, owner);
  const burnIxs = instructionsForItem({ owner, item: burn });
  assert.equal(burnIxs.length, 2);
  assert.equal(burnIxs[0].data[0], 15);
  assert.equal(new DataView(burnIxs[0].data.buffer).getBigUint64(1, true), burn.account.amount);
  assert.equal(burnIxs[1].data[0], 9);
  assert.throws(() => instructionsForItem({ owner, item: { ...burn, account: { ...burn.account, amount: 0n } } }), /amount/);
  assert.throws(() => instructionsForItem({ owner, item: { ...close, account: { ...close.account, amount: 7n } } }), /empty/);
  assert.throws(() => instructionsForItem({ owner, item: { ...close, action: 'transfer' } }), /action/);
});

test('packItems fills transactions up to the size limit and keeps order', () => {
  const items = makeItems(90);
  const batches = packItems({ owner, items, maxItemsPerTx: 30 });
  assert.deepEqual(batches.flat(), items);
  for (const [i, batch] of batches.entries()) {
    assert.ok(batch.length <= 30);
    assert.ok(measureBatch({ owner, items: batch }) <= PACKET_DATA_SIZE);
    if (i < batches.length - 1) {
      const grown = [...batch, batches[i + 1][0]];
      assert.ok(grown.length > 30 || measureBatch({ owner, items: grown }) > PACKET_DATA_SIZE);
    }
  }
  assert.ok(batches.length >= 4);
  assert.deepEqual(packItems({ owner, items: [], maxItemsPerTx: 10 }), []);
});

test('packItems respects a small item cap', () => {
  const batches = packItems({ owner, items: makeItems(7), maxItemsPerTx: 3 });
  assert.deepEqual(batches.map((b) => b.length), [3, 3, 1]);
});

test('buildBatchTransaction starts with compute budget instructions', () => {
  const items = makeItems(4);
  const blockhash = randomAddress();
  const { bytes, base64, size } = buildBatchTransaction({ owner, items, recentBlockhash: blockhash, computeUnitLimit: 80_000, computeUnitPrice: 25_000 });
  assert.equal(size, bytes.length);
  assert.equal(Buffer.from(base64, 'base64').length, size);
  const tx = Transaction.from(bytes);
  assert.equal(tx.recentBlockhash, blockhash);
  assert.equal(tx.feePayer.toBase58(), owner);
  assert.equal(tx.instructions[0].data[0], 2);
  assert.equal(tx.instructions[1].data[0], 3);
  assert.equal(tx.instructions.length, 2 + 1 + 2 + 1 + 2);
  assert.equal(PLACEHOLDER_BLOCKHASH.length > 30, true);
  assert.throws(() => buildBatchTransaction({ owner, items: [], recentBlockhash: blockhash, computeUnitLimit: 1, computeUnitPrice: 0 }), /items/);
});

test('choosePriorityFee uses the 75th percentile of recent fees within limits', () => {
  assert.equal(choosePriorityFee([]), 10_000);
  assert.equal(choosePriorityFee([0, 0, 0]), 10_000);
  assert.equal(choosePriorityFee([100_000, 200_000, 300_000, 400_000]), 300_000);
  assert.equal(choosePriorityFee([50_000_000]), 1_000_000);
  assert.equal(choosePriorityFee([1, 2, 'x', NaN, -5, 20_000]), 20_000);
});

test('compute unit limit and fee math', () => {
  assert.equal(computeUnitLimitFor(10_000), 13_000);
  assert.equal(computeUnitLimitFor(0), 5_000);
  assert.equal(computeUnitLimitFor(5_000_000), 1_400_000);
  assert.equal(priorityFeeLamports(100_000, 10_000), 1_000);
  assert.equal(priorityFeeLamports(1, 1), 1);
  assert.equal(priorityFeeLamports(100_000, 0), 0);
  assert.equal(
    estimateNetworkFee([{ computeUnitLimit: 100_000, computeUnitPrice: 10_000 }, { computeUnitLimit: 50_000, computeUnitPrice: 10_000 }]),
    2 * BASE_FEE_LAMPORTS + 1_000 + 500,
  );
});
