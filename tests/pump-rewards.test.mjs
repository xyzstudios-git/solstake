import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { AccountLayout, createInitializeAccount3Instruction, createCloseAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { scanPumpRewards, pumpRewardInstructions, pumpAccumulatorAddress, pumpTemporaryAddress, associatedTokenAddress, PUMP_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID } from '../site/lib/pump-rewards.js';
import { TOKEN_PROGRAM_ID } from '../site/lib/instructions.js';
import { WSOL_MINT } from '../site/lib/accounts.js';
import { toBase64 } from '../site/lib/bytes.js';

const owner = Keypair.generate().publicKey.toBase58();
const otherOwner = Keypair.generate().publicKey.toBase58();
const RESERVE = 1_346_200;
const TOKEN_RESERVE = 1_488_440;

function accumulator({ programId = PUMP_PROGRAM_ID, user = owner, lamports = RESERVE, size = 137, needsClaim = false, unclaimed = 0n, volume = 0n, stableEarned = 0n, stableClaimed = 0n } = {}) {
  const data = new Uint8Array(size);
  data.set([86, 255, 112, 14, 102, 53, 154, 250]);
  data.set(new PublicKey(user).toBytes(), 8);
  data[40] = Number(needsClaim);
  const view = new DataView(data.buffer);
  view.setBigUint64(41, unclaimed, true);
  view.setBigUint64(57, volume, true);
  if (programId === PUMP_PROGRAM_ID && size >= 106) {
    view.setBigUint64(90, stableEarned, true);
    view.setBigUint64(98, stableClaimed, true);
  }
  return { owner: programId, lamports, executable: false, data: [toBase64(data), 'base64'] };
}

function wsol(user, amount, { lamports = TOKEN_RESERVE + Number(amount), closeAuthority = PublicKey.default } = {}) {
  const data = Buffer.alloc(165);
  AccountLayout.encode({ mint: new PublicKey(WSOL_MINT), owner: new PublicKey(user), amount,
    delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 1, isNative: BigInt(TOKEN_RESERVE),
    delegatedAmount: 0n, closeAuthorityOption: closeAuthority.equals(PublicKey.default) ? 0 : 1, closeAuthority }, data);
  return { owner: TOKEN_PROGRAM_ID, lamports, executable: false, data: [data.toString('base64'), 'base64'] };
}

async function setup(raw = [null, null, null, null]) {
  const calls = [];
  const rpc = {
    async getMultipleAccounts(addresses) { calls.push(addresses); return addresses.length === 1 ? [null] : raw; },
    async getTokenAccounts() { return []; },
    async getMinimumBalanceForRentExemption(size) { return size === 165 ? TOKEN_RESERVE : RESERVE; },
  };
  return { rpc, raw, calls, result: await scanPumpRewards({ rpc, owner }) };
}

function normalize(ix) {
  return { programId: ix.programId.toBase58(), keys: ix.keys.map((key) => ({ pubkey: key.pubkey.toBase58(), isWritable: key.isWritable, isSigner: key.isSigner })), data: new Uint8Array(ix.data) };
}

test('Pump PDAs match the official Solana derivation for both programs and wrapped SOL', async () => {
  for (const programId of [PUMP_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID]) {
    const expected = PublicKey.findProgramAddressSync([Buffer.from('user_volume_accumulator'), new PublicKey(owner).toBuffer()], new PublicKey(programId))[0].toBase58();
    assert.equal(await pumpAccumulatorAddress(owner, programId), expected);
  }
  assert.equal(await associatedTokenAddress(owner), getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), new PublicKey(owner)).toBase58());
  await assert.rejects(() => pumpAccumulatorAddress(owner, otherOwner), /Unknown Pump/);
});

test('missing reward accounts return a clean empty result', async () => {
  const { result, calls } = await setup();
  assert.deepEqual(result, { accounts: [], warnings: [], reservedAddresses: [] });
  assert.equal(calls[0].length, 4);
});

test('native accumulator close returns its entire balance, including cashback', async () => {
  const { result } = await setup([accumulator({ lamports: RESERVE + 200_000 }), null, null, null]);
  const [account] = result.accounts;
  assert.equal(account.action, 'claim-pump');
  assert.equal(account.lamports, RESERVE + 200_000);
  assert.equal(account.cashbackLamports, 200_000);
  assert.equal(account.rentLamports, RESERVE);
  assert.equal(account.closesAccumulator, true);
  const instructions = pumpRewardInstructions({ owner, account });
  assert.equal(instructions.length, 1);
  assert.deepEqual([...instructions[0].data], [249, 69, 164, 218, 150, 103, 84, 138]);
  assert.deepEqual(instructions[0].keys.slice(0, 2), [
    { pubkey: owner, isSigner: true, isWritable: true },
    { pubkey: account.address, isSigner: false, isWritable: true },
  ]);
  assert.equal(Object.isFrozen(account), true);
});

test('AMM accumulator rent is claimable even without a cashback token account', async () => {
  const { result } = await setup([null, accumulator({ programId: PUMP_SWAP_PROGRAM_ID }), null, null]);
  assert.equal(result.accounts[0].lamports, RESERVE);
  assert.equal(result.accounts[0].title, 'PumpSwap');
  assert.equal(pumpRewardInstructions({ owner, account: result.accounts[0] })[0].programId, PUMP_SWAP_PROGRAM_ID);
});

for (const state of [{ needsClaim: true }, { unclaimed: 1n }, { volume: 1n }, { stableEarned: 2n, stableClaimed: 1n }]) {
  test(`pending claims preserve the native accumulator (${Object.keys(state).join(', ')})`, async () => {
    const { result } = await setup([accumulator({ ...state, lamports: RESERVE + 10_000 }), null, null, null]);
    const [account] = result.accounts;
    assert.equal(account.closesAccumulator, false);
    assert.equal(account.lamports, 10_000);
    assert.equal(account.rentLamports, 0);
    assert.equal(result.warnings.length, 1);
    assert.deepEqual([...pumpRewardInstructions({ owner, account })[0].data], [37, 58, 35, 126, 190, 53, 228, 197]);
  });
}

test('pending incentives with no cashback give a warning and no executable item', async () => {
  const { result } = await setup([accumulator({ needsClaim: true }), null, null, null]);
  assert.equal(result.accounts.length, 0);
  assert.match(result.warnings[0], /pending/);
});

test('wrong program, user, discriminator, malformed data and underfunded accounts never produce a plan', async () => {
  const mutations = [
    (entry) => { entry.owner = otherOwner; },
    (entry) => { entry.data[0] = toBase64(new Uint8Array(137)); },
    (entry) => { entry.data = ['%%%', 'base64']; },
    (entry) => { entry.data = [entry.data[0], 'jsonParsed']; },
    (entry) => { entry.lamports = Number.MAX_SAFE_INTEGER + 1; },
    (entry) => { entry.lamports = RESERVE - 1; },
    (entry) => { entry.executable = true; },
  ];
  for (const mutate of mutations) {
    const entry = accumulator();
    mutate(entry);
    const { result } = await setup([entry, null, null, null]);
    assert.equal(result.accounts.length, 0);
    assert.equal(result.warnings.length, 1);
  }
  const { result } = await setup([accumulator({ user: otherOwner }), null, null, null]);
  assert.equal(result.accounts.length, 0);
  assert.match(result.warnings[0], /different wallet/);
});

test('unknown extension bytes preserve the accumulator while allowing its native cashback', async () => {
  const entry = accumulator({ lamports: RESERVE + 1000 });
  const bytes = Buffer.from(entry.data[0], 'base64');
  bytes[120] = 1;
  entry.data[0] = bytes.toString('base64');
  const { result } = await setup([entry, null, null, null]);
  assert.equal(result.accounts[0].closesAccumulator, false);
  assert.equal(result.accounts[0].lamports, 1000);
  assert.equal(result.warnings.length, 1);
});

test('plans cannot be forged, reused with another wallet, or mutated through returned instructions', async () => {
  const { result } = await setup([accumulator(), null, null, null]);
  const [account] = result.accounts;
  assert.throws(() => pumpRewardInstructions({ owner, account: { ...account } }), /Scan Pump rewards again/);
  assert.throws(() => pumpRewardInstructions({ owner: otherOwner, account }), /Scan Pump rewards again/);
  const instructions = pumpRewardInstructions({ owner, account });
  instructions[0].data[0] = 0;
  instructions[0].keys[0].pubkey = otherOwner;
  const fresh = pumpRewardInstructions({ owner, account });
  assert.equal(fresh[0].data[0], 249);
  assert.equal(fresh[0].keys[0].pubkey, owner);
});

test('AMM cashback uses an isolated temporary account and never touches an existing user WSOL account', async () => {
  const ammAddress = await pumpAccumulatorAddress(owner, PUMP_SWAP_PROGRAM_ID);
  const { result } = await setup([null, accumulator({ programId: PUMP_SWAP_PROGRAM_ID }), wsol(ammAddress, 90_000n), null]);
  const [account] = result.accounts;
  const temporary = await pumpTemporaryAddress(owner);
  const userAta = await associatedTokenAddress(owner);
  const instructions = pumpRewardInstructions({ owner, account });
  assert.equal(account.lamports, RESERVE + 90_000);
  assert.equal(account.upfrontLamports, TOKEN_RESERVE);
  assert.deepEqual(account.reservedAddresses, [temporary.address]);
  assert.equal(instructions.length, 5);
  assert.deepEqual(instructions[0], normalize(SystemProgram.createAccountWithSeed({
    fromPubkey: new PublicKey(owner), basePubkey: new PublicKey(owner),
    newAccountPubkey: new PublicKey(temporary.address), seed: temporary.seed,
    lamports: TOKEN_RESERVE, space: 165, programId: new PublicKey(TOKEN_PROGRAM_ID),
  })));
  assert.deepEqual(instructions[1], normalize(createInitializeAccount3Instruction(new PublicKey(temporary.address), new PublicKey(WSOL_MINT), new PublicKey(owner))));
  assert.equal(instructions[2].programId, PUMP_SWAP_PROGRAM_ID);
  assert.equal(instructions[2].keys[5].pubkey, temporary.address);
  assert.deepEqual(instructions[3], normalize(createCloseAccountInstruction(new PublicKey(temporary.address), new PublicKey(owner), new PublicKey(owner))));
  assert.ok(!instructions.some((ix) => ix.keys.some((key) => key.pubkey === userAta)));
  assert.ok(!instructions.some((ix) => ix.programId === TOKEN_PROGRAM_ID && ix.data[0] === 45));
});

test('occupied temporary accounts are preserved and a fresh seed is selected', async () => {
  const ammAddress = await pumpAccumulatorAddress(owner, PUMP_SWAP_PROGRAM_ID);
  const { result, calls } = await setup([null, accumulator({ programId: PUMP_SWAP_PROGRAM_ID }), wsol(ammAddress, 10_000n), wsol(otherOwner, 5_000_000n)]);
  const alternate = await pumpTemporaryAddress(owner, 'solburn-pump-unwrap-v1-1');
  assert.deepEqual(result.accounts[0].reservedAddresses, [alternate.address]);
  assert.deepEqual(calls[1], [alternate.address]);
});

test('an unsafe AMM source never produces a cashback transaction', async () => {
  const { result } = await setup([null, accumulator({ programId: PUMP_SWAP_PROGRAM_ID }), wsol(otherOwner, 10_000n), null]);
  assert.equal(result.accounts.length, 0);
  assert.equal(result.warnings.length, 1);
});

test('RPC failures and incomplete responses propagate without fabricating zero rewards', async () => {
  await assert.rejects(() => scanPumpRewards({ owner, rpc: { async getMultipleAccounts() { throw new Error('RPC offline'); } } }), /RPC offline/);
  await assert.rejects(() => scanPumpRewards({ owner, rpc: { async getMultipleAccounts() { return []; } } }), /completely/);
  await assert.rejects(() => scanPumpRewards({ owner: 'bad', rpc: {} }), /wallet address/);
});

test('instruction account order and flags match the pinned official Pump IDLs', async () => {
  for (const [programId, rawAccounts] of [
    [PUMP_PROGRAM_ID, [accumulator(), null, null, null]],
    [PUMP_SWAP_PROGRAM_ID, [null, accumulator({ programId: PUMP_SWAP_PROGRAM_ID }), null, null]],
  ]) {
    // Captured from both official IDLs at commit 639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22.
    const spec = { discriminator: [249, 69, 164, 218, 150, 103, 84, 138], accounts: [{ writable: true, signer: true }, { writable: true }, {}, {}] };
    const { result } = await setup(rawAccounts);
    const ix = pumpRewardInstructions({ owner, account: result.accounts[0] })[0];
    assert.equal(ix.programId, programId);
    assert.deepEqual([...ix.data], spec.discriminator);
    assert.deepEqual(ix.keys.map((key) => [key.isWritable, key.isSigner]), spec.accounts.map((key) => [key.writable ?? false, key.signer ?? false]));
  }
});

test('temporary WSOL creation and closure execute in LiteSVM without touching private WSOL', async () => {
  const { LiteSVM, FailedTransactionMetadata } = await import('litesvm');
  const { Transaction, TransactionInstruction } = await import('@solana/web3.js');
  const svm = new LiteSVM();
  const wallet = Keypair.generate();
  const user = wallet.publicKey.toBase58();
  svm.airdrop(wallet.publicKey, 100_000_000n);
  const temp = await pumpTemporaryAddress(user);
  const amm = await pumpAccumulatorAddress(user, PUMP_SWAP_PROGRAM_ID);
  const wrapped = wsol(amm, 90_000n);
  const nativeReserve = Number(svm.minimumBalanceForRentExemption(165n));
  const rpc = {
    async getMultipleAccounts() { return [null, accumulator({ programId: PUMP_SWAP_PROGRAM_ID, user }), wrapped, null]; },
    async getTokenAccounts() { return []; },
    async getMinimumBalanceForRentExemption(size) { return size === 165 ? nativeReserve : RESERVE; },
  };
  const { accounts } = await scanPumpRewards({ rpc, owner: user });
  const plan = pumpRewardInstructions({ owner: user, account: accounts[0] });
  const asWeb3 = (ix) => new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.keys.map((key) => ({ ...key, pubkey: new PublicKey(key.pubkey) })), data: Buffer.from(ix.data) });
  // The Pump program is checked against its IDL. Execute its WSOL transport with a native deposit here.
  const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: svm.latestBlockhash() }).add(
    asWeb3(plan[0]), asWeb3(plan[1]),
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(temp.address), lamports: 90_000 }),
    asWeb3(plan[3]),
  );
  tx.sign(wallet);
  const before = svm.getBalance(wallet.publicKey);
  const outcome = svm.sendTransaction(tx);
  assert.equal(outcome instanceof FailedTransactionMetadata, false, outcome.toString());
  const closed = svm.getAccount(new PublicKey(temp.address));
  assert.ok(closed === null || closed.lamports === 0);
  assert.equal(before - svm.getBalance(wallet.publicKey), 5000n);
});

test('mixed cleanup plans include Pump instructions and count the recovery once', async () => {
  const { prepareBurnPlan } = await import('../site/lib/flow.js');
  const { VersionedTransaction } = await import('@solana/web3.js');
  const { result, rpc } = await setup([accumulator({ lamports: RESERVE + 10_000 }), null, null, null]);
  const reward = result.accounts[0];
  const normal = { address: otherOwner, programId: TOKEN_PROGRAM_ID, lamports: TOKEN_RESERVE, amount: 0n };
  const simulations = [];
  rpc.getRecentPrioritizationFees = async () => [];
  rpc.simulate = async (base64) => { simulations.push(base64); return { err: null, unitsConsumed: 15000 }; };
  const plan = await prepareBurnPlan({ rpc, owner, items: [{ action: 'close', account: normal }, { action: 'claim-pump', account: reward }] });
  assert.equal(plan.failed.length, 0);
  assert.equal(plan.reclaimLamports, TOKEN_RESERVE + RESERVE + 10_000);
  assert.equal(plan.batches.length, 1);
  const tx = VersionedTransaction.deserialize(Buffer.from(simulations[0], 'base64'));
  const programIds = tx.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex].toBase58());
  assert.ok(programIds.includes(PUMP_PROGRAM_ID));
  assert.ok(programIds.includes(TOKEN_PROGRAM_ID));
  const conflict = { ...reward, reservedAddresses: [normal.address] };
  await assert.rejects(() => prepareBurnPlan({ rpc, owner, items: [{ action: 'close', account: normal }, { action: 'claim-pump', account: conflict }] }), /multiple actions/);
});


const refreshRewardItems = async (options) => (await import('../site/lib/pump-rewards.js')).refreshPumpRewardItems(options);
const ordinaryItem = () => ({ action: 'close', account: { address: otherOwner, lamports: TOKEN_RESERVE, amount: 0n } });
const rewardItem = (account) => ({ action: 'claim-pump', account });

test('a selection without Pump rewards does not need any reward RPC', async () => {
  const items = [ordinaryItem()];
  const fresh = await refreshRewardItems({ rpc: {}, owner, items });
  assert.deepEqual(fresh.items, items);
  assert.equal(fresh.requiresReview, false);
  assert.deepEqual(fresh.skipped, []);
});

test('growing rewards with unchanged instructions preserve the reviewed quote and tip base', async () => {
  const { result, raw, rpc } = await setup([accumulator({ needsClaim: true, lamports: RESERVE + 100_000 }), null, null, null]);
  const quoted = result.accounts[0];
  const items = [ordinaryItem(), rewardItem(quoted)];
  raw[0].lamports += 20_000;
  const fresh = await refreshRewardItems({ rpc, owner, items });
  assert.equal(fresh.requiresReview, false);
  assert.equal(fresh.items[0], items[0]);
  assert.equal(fresh.items[1].account.lamports, 120_000);
  assert.equal(quoted.lamports, 100_000, 'the already authorized quote is never mutated');
  assert.deepEqual(pumpRewardInstructions({ owner, account: fresh.items[1].account }), pumpRewardInstructions({ owner, account: quoted }));
});

test('disappearing Pump rewards refresh the selection without blocking ordinary accounts', async () => {
  const { result, raw, rpc } = await setup([accumulator({ lamports: RESERVE + 1000 }), null, null, null]);
  const ordinary = ordinaryItem();
  raw[0] = null;
  const fresh = await refreshRewardItems({ rpc, owner, items: [ordinary, rewardItem(result.accounts[0])] });
  assert.equal(fresh.requiresReview, true);
  assert.deepEqual(fresh.items, [ordinary]);
  assert.equal(fresh.skipped.length, 1);
  assert.equal(fresh.skipped[0].item.account, result.accounts[0]);
  assert.match(fresh.skipped[0].error, /not.*available|no longer|not.*claimable/i);
});

test('lower rewards require a new quote even when the instructions remain identical', async () => {
  const { result, raw, rpc } = await setup([accumulator({ needsClaim: true, lamports: RESERVE + 1000 }), null, null, null]);
  raw[0].lamports -= 100;
  const fresh = await refreshRewardItems({ rpc, owner, items: [rewardItem(result.accounts[0])] });
  assert.equal(fresh.requiresReview, true);
  assert.equal(fresh.items[0].account.lamports, 900);
});

test('new incentive protection requires review even if the quoted total is unchanged', async () => {
  const { result, raw, rpc } = await setup([accumulator({ lamports: RESERVE + 1000 }), null, null, null]);
  raw[0] = accumulator({ needsClaim: true, lamports: 2 * RESERVE + 1000 });
  const fresh = await refreshRewardItems({ rpc, owner, items: [rewardItem(result.accounts[0])] });
  assert.equal(fresh.requiresReview, true);
  assert.equal(fresh.items[0].account.lamports, result.accounts[0].lamports);
  assert.equal(fresh.items[0].account.closesAccumulator, false);
});

test('a changed temporary WSOL destination requires a new review', async () => {
  const accumulatorAddress = await pumpAccumulatorAddress(owner, PUMP_SWAP_PROGRAM_ID);
  const { result, raw, rpc } = await setup([null, accumulator({ programId: PUMP_SWAP_PROGRAM_ID }), wsol(accumulatorAddress, 1000n), null]);
  raw[3] = { owner: TOKEN_PROGRAM_ID, lamports: TOKEN_RESERVE };
  const fresh = await refreshRewardItems({ rpc, owner, items: [rewardItem(result.accounts[0])] });
  assert.equal(fresh.requiresReview, true);
  assert.notDeepEqual(fresh.items[0].account.reservedAddresses, result.accounts[0].reservedAddresses);
});

test('verification errors remain visible while non-Pump claims remain available', async () => {
  const { result, rpc } = await setup([accumulator({ lamports: RESERVE + 1000 }), null, null, null]);
  const ordinary = ordinaryItem();
  rpc.getTokenAccounts = async () => { throw new Error('Synthetic reward verification failure'); };
  const fresh = await refreshRewardItems({ rpc, owner, items: [ordinary, rewardItem(result.accounts[0])] });
  assert.equal(fresh.requiresReview, true);
  assert.deepEqual(fresh.items, [ordinary]);
  assert.match(fresh.skipped[0].error, /Synthetic reward verification failure/);
  rpc.getMultipleAccounts = async () => { throw new Error('Synthetic RPC unavailable'); };
  const offline = await refreshRewardItems({ rpc, owner, items: [ordinary, rewardItem(result.accounts[0])] });
  assert.deepEqual(offline.items, [ordinary]);
  assert.match(offline.skipped[0].error, /Synthetic RPC unavailable/);
});

test('new unselected reward accounts are never added by the refresh', async () => {
  const { result, raw, rpc } = await setup([accumulator({ lamports: RESERVE + 1000 }), null, null, null]);
  raw[1] = accumulator({ programId: PUMP_SWAP_PROGRAM_ID });
  const fresh = await refreshRewardItems({ rpc, owner, items: [rewardItem(result.accounts[0])] });
  assert.equal(fresh.items.length, 1);
  assert.equal(fresh.items[0].account.address, result.accounts[0].address);
});

test('reward refresh rejects fabricated or wrong-owner plans before reading RPC', async () => {
  const { result } = await setup([accumulator({ lamports: RESERVE + 1000 }), null, null, null]);
  await assert.rejects(refreshRewardItems({ rpc: {}, owner, items: [rewardItem({ ...result.accounts[0] })] }), /Scan Pump rewards/);
  await assert.rejects(refreshRewardItems({ rpc: {}, owner: otherOwner, items: [rewardItem(result.accounts[0])] }), /Scan Pump rewards/);
});
