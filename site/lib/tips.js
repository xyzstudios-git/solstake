import { isAddress } from './base58.js';

export const TIP_RECIPIENT = 'Eytg5SVVcLR2npxstQLjtLgns8MZ4TTdRCBsGmjFydo4';
export const TIP_BASIS_POINTS = 2_000;
const BASIS_POINTS = 10_000n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** An optional, fixed 20% of gross recovered lamports, rounded down per batch. */
export function calculateTip({ owner, reclaimLamports, enabled = false }) {
  if (!isAddress(owner)) throw new Error('Invalid wallet address for the optional tip.');
  if (typeof enabled !== 'boolean') throw new TypeError('The optional tip choice must be a boolean.');
  if (!Number.isSafeInteger(reclaimLamports) || reclaimLamports < 0) throw new RangeError('Invalid recovered lamport amount.');
  if (!enabled || owner === TIP_RECIPIENT) return 0;
  return Number(BigInt(reclaimLamports) * BigInt(TIP_BASIS_POINTS) / BASIS_POINTS);
}

/** Validate the whole batch before calculating its one optional transfer. */
export function batchTipLamports({ owner, items, withTip = false }) {
  if (!Array.isArray(items)) throw new TypeError('Invalid items for the optional tip.');
  let total = 0n;
  for (const item of items) {
    const lamports = item?.account?.lamports;
    if (!Number.isSafeInteger(lamports) || lamports < 0) throw new RangeError('Invalid recovered lamport amount.');
    total += BigInt(lamports);
    if (total > MAX_SAFE) throw new RangeError('The recovered lamport total is too large to calculate safely.');
  }
  return calculateTip({ owner, reclaimLamports: Number(total), enabled: withTip });
}
