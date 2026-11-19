// Pump-/PumpSwap-IDLs, Stand 639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22:
// https://github.com/pump-fun/pump-public-docs/tree/639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22/idl
// Claims gehen direkt an den Besitzer. Offene Incentive-Ansprüche verhindern das Schließen.
import { addressBytes, encodeBase58, isAddress } from './base58.js';
import { concatBytes, fromBase64, toBase64, u32LE, u64LE } from './bytes.js';
import { findProgramAddress } from './pda.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, closeAccountIx } from './instructions.js';
import { WSOL_MINT } from './accounts.js';

export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_SWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const ACCUMULATOR_DISCRIMINATOR = [86, 255, 112, 14, 102, 53, 154, 250];
const CLAIM_CASHBACK = [37, 58, 35, 126, 190, 53, 228, 197];
const CLOSE_ACCUMULATOR = [249, 69, 164, 218, 150, 103, 84, 138];
const TEXT = new TextEncoder();
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const rewardPlans = new WeakMap();
const PROGRAMS = [
  { id: PUMP_PROGRAM_ID, title: 'Pump.fun' },
  { id: PUMP_SWAP_PROGRAM_ID, title: 'PumpSwap' },
];

function meta(pubkey, isWritable = false, isSigner = false) {
  addressBytes(pubkey);
  return { pubkey, isSigner, isWritable };
}

function instruction(programId, keys, data) {
  return { programId, keys, data: Uint8Array.from(data) };
}

function copyInstructions(instructions) {
  return instructions.map((ix) => ({ programId: ix.programId, keys: ix.keys.map((key) => ({ ...key })), data: Uint8Array.from(ix.data) }));
}

function rawAccount(account, programId) {
  if (!account || account.owner !== programId || account.executable === true) throw new Error('The account program does not match.');
  if (!Number.isSafeInteger(account.lamports) || account.lamports < 0) throw new Error('Invalid SOL balance.');
  if (!Array.isArray(account.data) || account.data[1] !== 'base64' || typeof account.data[0] !== 'string') throw new Error('Unknown account format.');
  const bytes = fromBase64(account.data[0]);
  if (toBase64(bytes) !== account.data[0]) throw new Error('Invalid account data.');
  return bytes;
}

function readAccumulator(account, programId, owner) {
  const bytes = rawAccount(account, programId);
  // 90 Byte ist das frühere Cashback-Layout. Pump erweitert es um zwei Stable-Cashback-Zähler.
  if (bytes.length < 90 || bytes.length > 4096) throw new Error('Unknown reward account length.');
  if (!ACCUMULATOR_DISCRIMINATOR.every((value, index) => bytes[index] === value)) throw new Error('Unknown reward account type.');
  if (encodeBase58(bytes.subarray(8, 40)) !== owner) throw new Error('This reward account belongs to a different wallet.');
  if (bytes[40] > 1 || bytes[73] > 1) throw new Error('Invalid reward status.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const unclaimed = view.getBigUint64(41, true);
  const currentVolume = view.getBigUint64(57, true);
  const hasStableFields = programId === PUMP_PROGRAM_ID && bytes.length >= 106;
  const stableEarned = hasStableFields ? view.getBigUint64(90, true) : 0n;
  const stableClaimed = hasStableFields ? view.getBigUint64(98, true) : 0n;
  const knownLength = hasStableFields ? 106 : 90;
  const unknownFields = bytes.subarray(knownLength).some((value) => value !== 0);
  const incentivesPending = bytes[40] === 1 || unclaimed > 0n || currentVolume > 0n;
  const stablePending = stableEarned > stableClaimed;
  return { length: bytes.length, incentivesPending, stablePending, unknownFields };
}

function readWsol(account, owner) {
  const bytes = rawAccount(account, TOKEN_PROGRAM_ID);
  if (bytes.length !== 165 || encodeBase58(bytes.subarray(0, 32)) !== WSOL_MINT || encodeBase58(bytes.subarray(32, 64)) !== owner) {
    throw new Error('The wrapped SOL account does not match its owner.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[108] !== 1 || view.getUint32(109, true) !== 1) throw new Error('This wrapped SOL account cannot be used.');
  const amount = view.getBigUint64(64, true);
  const reserve = view.getBigUint64(113, true);
  if (amount > MAX_SAFE || reserve > MAX_SAFE || BigInt(account.lamports) < amount + reserve) throw new Error('Invalid wrapped SOL balance.');
  // Für Empfängerkonten ist nur die Wallet selbst als Close Authority zulässig.
  const authorityOption = view.getUint32(129, true);
  if (authorityOption > 1 || (authorityOption === 1 && encodeBase58(bytes.subarray(133, 165)) !== owner)) throw new Error('A different address has permission to close the wrapped SOL account.');
  return Number(amount);
}

export async function pumpAccumulatorAddress(owner, programId) {
  if (!PROGRAMS.some((program) => program.id === programId)) throw new Error('Unknown Pump program.');
  const [address] = await findProgramAddress([TEXT.encode('user_volume_accumulator'), addressBytes(owner)], programId);
  return address;
}

export async function associatedTokenAddress(owner, mint = WSOL_MINT, programId = TOKEN_PROGRAM_ID) {
  const [address] = await findProgramAddress([addressBytes(owner), addressBytes(programId), addressBytes(mint)], ASSOCIATED_TOKEN_PROGRAM_ID);
  return address;
}

export async function pumpTemporaryAddress(owner, seed = 'solburn-pump-unwrap-v1') {
  const bytes = concatBytes([addressBytes(owner), TEXT.encode(seed), addressBytes(TOKEN_PROGRAM_ID)]);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return { address: encodeBase58(new Uint8Array(digest)), seed };
}

function createTemporaryWsol(owner, temporary, rent) {
  const seed = TEXT.encode(temporary.seed);
  // SystemProgram CreateAccountWithSeed and SPL InitializeAccount3.
  return [
    instruction(SYSTEM_PROGRAM_ID, [meta(owner, true, true), meta(temporary.address, true)],
      concatBytes([u32LE(3), addressBytes(owner), u64LE(BigInt(seed.length)), seed, u64LE(BigInt(rent)), u64LE(165n), addressBytes(TOKEN_PROGRAM_ID)])),
    instruction(TOKEN_PROGRAM_ID, [meta(temporary.address, true), meta(WSOL_MINT)],
      concatBytes([Uint8Array.of(18), addressBytes(owner)])),
  ];
}

async function hasOtherTokenRewards(rpc, address) {
  const entries = await rpc.getTokenAccounts(address);
  if (!Array.isArray(entries)) throw new Error('Additional token rewards could not be checked.');
  return entries.some((entry) => {
    const account = entry?.account;
    const info = account?.data?.parsed?.info;
    if (!account || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].includes(account.owner) || account.data?.parsed?.type !== 'account'
      || info?.owner !== address || !isAddress(info.mint) || !/^\d{1,20}$/.test(info.tokenAmount?.amount ?? '')) {
      throw new Error('Unknown balance in the reward account.');
    }
    return info.mint !== WSOL_MINT && BigInt(info.tokenAmount.amount) > 0n;
  });
}

async function minimumBalance(rpc, size) {
  const value = typeof rpc.getMinimumBalanceForRentExemption === 'function'
    ? await rpc.getMinimumBalanceForRentExemption(size)
    : await rpc.call('getMinimumBalanceForRentExemption', [size, { commitment: 'confirmed' }]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('The current account rent reserve could not be read.');
  return value;
}

function registerReward({ owner, program, address, instructions, cashbackLamports, rentLamports, upfrontLamports, reservedAddresses, closesAccumulator }) {
  const lamports = cashbackLamports + rentLamports;
  if (!Number.isSafeInteger(lamports)) throw new Error('The Pump recovery amount is too large.');
  const account = Object.freeze({
    kind: 'pump-reward', action: 'claim-pump', address, programId: program.id, owner, title: program.title,
    lamports, amount: 0n, decimals: 9, mint: null, status: 'pump-reward', reason: '',
    cashbackLamports, rentLamports, upfrontLamports, closesAccumulator,
    reservedAddresses: Object.freeze([...reservedAddresses]),
    description: closesAccumulator
      ? (cashbackLamports > 0 ? 'Cashback and recovered account rent' : 'Recovered account rent · close reward account')
      : 'Cashback · reward account stays open for pending claims',
  });
  rewardPlans.set(account, { owner, instructions: copyInstructions(instructions) });
  return account;
}

/** Prüft beide festen Pump-PDAs. Fehler werden sichtbar gemeldet und blockieren andere Konten nicht. */
export async function scanPumpRewards({ rpc, owner }) {
  if (!isAddress(owner)) throw new Error('Invalid wallet address.');
  const accounts = [];
  const warnings = [];
  const programAccounts = await Promise.all(PROGRAMS.map(async (program) => ({ ...program, address: await pumpAccumulatorAddress(owner, program.id) })));
  const sourceWsol = await associatedTokenAddress(programAccounts[1].address);
  let temporary = await pumpTemporaryAddress(owner);
  const raw = await rpc.getMultipleAccounts([...programAccounts.map((program) => program.address), sourceWsol, temporary.address]);
  if (!Array.isArray(raw) || raw.length !== 4) throw new Error('Pump rewards could not be read completely.');

  for (const [index, program] of programAccounts.entries()) {
    const account = raw[index];
    if (account === null) continue;
    try {
      const parsed = readAccumulator(account, program.id, owner);
      const reserve = await minimumBalance(rpc, parsed.length);
      if (account.lamports < reserve) throw new Error('The reward account balance is below its rent reserve.');
      const native = program.id === PUMP_PROGRAM_ID;
      const cashbackLamports = native ? account.lamports - reserve : raw[2] === null ? 0 : readWsol(raw[2], program.address);
      const otherTokenRewards = await hasOtherTokenRewards(rpc, program.address);
      const closesAccumulator = !parsed.incentivesPending && !parsed.stablePending && !parsed.unknownFields && !otherTokenRewards;
      if (!closesAccumulator) {
        warnings.push(
          parsed.stablePending || otherTokenRewards
            ? program.title + ': Token cashback is still pending. The reward account stays open.'
            : parsed.unknownFields
              ? program.title + ': The reward account has additional fields and stays open.'
              : program.title + ': Token incentives or trading volume are still pending. The reward account stays open.',
        );
      }
      const rentLamports = closesAccumulator ? (native ? reserve : account.lamports) : 0;
      if (cashbackLamports + rentLamports === 0) continue;
      const [eventAuthority] = await findProgramAddress([TEXT.encode('__event_authority')], program.id);
      const instructions = [];
      const reservedAddresses = [];
      let upfrontLamports = 0;
      if (native && cashbackLamports > 0 && !closesAccumulator) {
        instructions.push(instruction(program.id, [meta(owner, true), meta(program.address, true), meta(SYSTEM_PROGRAM_ID), meta(eventAuthority), meta(program.id)], CLAIM_CASHBACK));
      }
      if (!native && cashbackLamports > 0) {
        // Use a new seeded account so an existing private WSOL balance is never touched.
        let occupied = raw[3] !== null;
        for (let attempt = 1; occupied && attempt <= 4; attempt += 1) {
          temporary = await pumpTemporaryAddress(owner, 'solburn-pump-unwrap-v1-' + attempt);
          const next = await rpc.getMultipleAccounts([temporary.address]);
          if (!Array.isArray(next) || next.length !== 1) throw new Error('The temporary reward account could not be checked.');
          occupied = next[0] !== null;
        }
        if (occupied) throw new Error('Temporary reward accounts are occupied. Check again later.');
        upfrontLamports = await minimumBalance(rpc, 165);
        instructions.push(...createTemporaryWsol(owner, temporary, upfrontLamports));
        reservedAddresses.push(temporary.address);
        instructions.push(instruction(program.id, [
          meta(owner, true), meta(program.address, true), meta(WSOL_MINT), meta(TOKEN_PROGRAM_ID),
          meta(sourceWsol, true), meta(temporary.address, true), meta(SYSTEM_PROGRAM_ID), meta(eventAuthority), meta(program.id),
        ], CLAIM_CASHBACK));
        instructions.push(closeAccountIx({ programId: TOKEN_PROGRAM_ID, account: temporary.address, destination: owner, owner }));
      }
      if (closesAccumulator) {
        instructions.push(instruction(program.id, [meta(owner, true, true), meta(program.address, true), meta(eventAuthority), meta(program.id)], CLOSE_ACCUMULATOR));
      }
      accounts.push(registerReward({ owner, program, address: program.address, instructions, cashbackLamports, rentLamports, upfrontLamports, reservedAddresses, closesAccumulator }));
    } catch (error) {
      warnings.push(program.title + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  return { accounts, warnings, reservedAddresses: [...new Set(accounts.flatMap((account) => account.reservedAddresses))] };
}

/** Liefert ausschließlich vom validierten Scan erzeugte Pläne für dieselbe Wallet. */
export function pumpRewardInstructions({ owner, account }) {
  const plan = rewardPlans.get(account);
  if (!plan || plan.owner !== owner || account.owner !== owner) throw new Error('Scan Pump rewards again for this wallet.');
  return copyInstructions(plan.instructions);
}

/** Refresh only reviewed rewards; changes to instructions or a lower quote need fresh approval. */
export async function refreshPumpRewardItems({ rpc, owner, items }) {
  const selected = items.filter((item) => item.action === 'claim-pump');
  if (!selected.length) return { items, skipped: [], requiresReview: false, warnings: [] };
  // Validate the original identity before catching RPC errors: forged plans must still fail.
  const instructions = new Map(selected.map((item) => [item, pumpRewardInstructions({ owner, account: item.account })]));
  let fresh;
  try {
    fresh = await scanPumpRewards({ rpc, owner });
  } catch (error) {
    const reason = `Pump rewards could not be checked. ${error instanceof Error ? error.message : String(error)}`;
    return {
      items: items.filter((item) => item.action !== 'claim-pump'),
      skipped: selected.map((item) => ({ item, error: reason })),
      requiresReview: true,
      warnings: [reason],
    };
  }
  const byAddress = new Map(fresh.accounts.map((account) => [account.address, account]));
  const refreshed = [];
  const skipped = [];
  let requiresReview = false;
  for (const item of items) {
    if (item.action !== 'claim-pump') {
      refreshed.push(item);
      continue;
    }
    const account = byAddress.get(item.account.address);
    if (!account) {
      const reason = fresh.warnings.filter((warning) => warning.startsWith(item.account.title + ':')).join(' ')
        || `${item.account.title}: This reward is not currently available and was excluded from this review.`;
      skipped.push({ item, error: reason });
      requiresReview = true;
      continue;
    }
    const nextInstructions = pumpRewardInstructions({ owner, account });
    if (account.lamports < item.account.lamports || JSON.stringify(nextInstructions) !== JSON.stringify(instructions.get(item))) {
      requiresReview = true;
    }
    refreshed.push({ action: item.action, account });
  }
  return { items: refreshed, skipped, requiresReview, warnings: fresh.warnings };
}
