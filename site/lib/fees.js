// Netzwerkgebühren: Grundgebühr je Signatur plus Prioritätsgebühr je Recheneinheit.
import { MAX_COMPUTE_UNITS } from './instructions.js';

export const BASE_FEE_LAMPORTS = 5000;
export const MIN_PRIORITY = 10_000; // Mikro-Lamports je Recheneinheit
export const MAX_PRIORITY = 1_000_000;
const MIN_COMPUTE_UNITS = 5_000;
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;

/** 75. Perzentil der jüngsten Prioritätsgebühren, begrenzt auf [MIN_PRIORITY, MAX_PRIORITY]. */
export function choosePriorityFee(samples, { percentile = 0.75, min = MIN_PRIORITY, max = MAX_PRIORITY } = {}) {
  const values = (Array.isArray(samples) ? samples : [])
    .filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (values.length === 0) return min;
  const pick = values[Math.max(0, Math.ceil(percentile * values.length) - 1)];
  return Math.min(max, Math.max(min, Math.round(pick)));
}

/** Rechenbudget aus der Simulation: 20 % Reserve plus 1.000 Einheiten. */
export function computeUnitLimitFor(unitsConsumed) {
  const units = Number.isFinite(unitsConsumed) && unitsConsumed > 0 ? unitsConsumed : 0;
  return Math.min(MAX_COMPUTE_UNITS, Math.max(MIN_COMPUTE_UNITS, Math.ceil(units * 1.2) + 1_000));
}

/** Wie die Laufzeit rechnet: aufgerundet auf ganze Lamports. */
export function priorityFeeLamports(computeUnitLimit, computeUnitPrice) {
  const microLamports = BigInt(computeUnitLimit) * BigInt(computeUnitPrice);
  return Number((microLamports + MICRO_LAMPORTS_PER_LAMPORT - 1n) / MICRO_LAMPORTS_PER_LAMPORT);
}

export function estimateNetworkFee(batches) {
  return batches.reduce(
    (sum, b) => sum + BASE_FEE_LAMPORTS + priorityFeeLamports(b.computeUnitLimit, b.computeUnitPrice),
    0,
  );
}
