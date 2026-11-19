// Gleiche bekannte Sol-Burn-Signaturen mit der Blockchain ab. Keine neuen Transaktionen.
import { reconcileHistoryEntry } from './history.js';

const nextSignature = new Map();

export async function syncHistory({ store, rpc, owner, onUpdate = () => {}, limit = 20 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error('Invalid history sync limit.');
  const saved = store.read(owner);
  const candidates = saved.entries.filter((entry) => ['sent', 'unknown', 'expired'].includes(entry.status)
    || (['confirmed', 'failed'].includes(entry.status) && entry.actualNetLamports === null));
  if (candidates.length === 0) { nextSignature.delete(owner); return saved.warning; }
  // Rotate the bounded RPC window so unavailable newer transactions cannot starve older ones.
  const start = Math.max(0, candidates.findIndex((entry) => entry.signature === nextSignature.get(owner)));
  const selected = [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, limit);
  const statuses = await rpc.getSignatureStatuses(selected.map((entry) => entry.signature), { searchTransactionHistory: true });
  if (!Array.isArray(statuses) || statuses.length !== selected.length) throw new Error('Transaction statuses could not be read completely.');
  nextSignature.set(owner, candidates[(start + selected.length) % candidates.length].signature);
  const warnings = saved.warning ? [saved.warning] : [];
  for (const [index, original] of selected.entries()) {
    const status = statuses[index];
    if (!status) continue;
    const confirmed = status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';
    if (!status.err && !confirmed) continue;
    // Read again so a second tab cannot replace a newer terminal status with stale data.
    const entry = store.read(owner).entries.find((item) => item.signature === original.signature);
    if (!entry) continue;
    try {
      const transaction = await rpc.getTransaction(entry.signature);
      const next = transaction ? reconcileHistoryEntry(entry, transaction, owner)
        : { ...entry, status: status.err ? 'failed' : 'confirmed', error: status.err ? 'The transaction failed on the network.' : null };
      const result = store.upsert(owner, next);
      if (result.warning) warnings.push(result.warning);
      onUpdate();
    } catch {
      warnings.push('Some transaction details could not be updated. Saved values remain visible.');
    }
  }
  if (candidates.length > limit) warnings.push('Use “Refresh” to check more saved transactions.');
  return [...new Set(warnings)].join(' ') || null;
}
