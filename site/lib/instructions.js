// Die wenigen Anweisungen, die Leergut braucht: verbrennen, Konto schließen, Rechenbudget.
import { addressBytes } from './base58.js';
import { concatBytes, u32LE, u64LE } from './bytes.js';

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
export const TOKEN_PROGRAMS = Object.freeze([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);
export const MAX_COMPUTE_UNITS = 1_400_000;

const BURN_CHECKED = 15; // SPL Token und Token-2022
const CLOSE_ACCOUNT = 9;
const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;
const U64_MAX = (1n << 64n) - 1n;

function tokenProgram(programId) {
  if (!TOKEN_PROGRAMS.includes(programId)) throw new Error(`Unknown token program: ${String(programId).slice(0, 60)}`);
  return programId;
}

function meta(pubkey, isSigner, isWritable) {
  addressBytes(pubkey);
  return { pubkey, isSigner, isWritable };
}

/** Schließt ein leeres Token-Konto; die Miete geht an `destination`. */
export function closeAccountIx({ programId, account, destination, owner }) {
  return {
    programId: tokenProgram(programId),
    keys: [meta(account, false, true), meta(destination, false, true), meta(owner, true, false)],
    data: Uint8Array.of(CLOSE_ACCOUNT),
  };
}

/** Verbrennt `amount` Einheiten; `decimals` muss zum Mint passen, sonst lehnt das Programm ab. */
export function burnCheckedIx({ programId, account, mint, owner, amount, decimals }) {
  tokenProgram(programId);
  if (typeof amount !== 'bigint' || amount <= 0n || amount > U64_MAX) throw new Error('Invalid burn amount');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Invalid token decimals');
  return {
    programId,
    keys: [meta(account, false, true), meta(mint, false, true), meta(owner, true, false)],
    data: concatBytes([Uint8Array.of(BURN_CHECKED), u64LE(amount), Uint8Array.of(decimals)]),
  };
}

export function setComputeUnitLimitIx(units) {
  if (!Number.isInteger(units) || units < 1 || units > MAX_COMPUTE_UNITS) {
    throw new RangeError(`Compute unit limit out of range: ${units}`);
  }
  return { programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: concatBytes([Uint8Array.of(SET_COMPUTE_UNIT_LIMIT), u32LE(units)]) };
}

export function setComputeUnitPriceIx(microLamports) {
  if (!Number.isSafeInteger(microLamports) || microLamports < 0) {
    throw new RangeError(`Priority fee out of range: ${microLamports}`);
  }
  return {
    programId: COMPUTE_BUDGET_PROGRAM_ID,
    keys: [],
    data: concatBytes([Uint8Array.of(SET_COMPUTE_UNIT_PRICE), u64LE(BigInt(microLamports))]),
  };
}
