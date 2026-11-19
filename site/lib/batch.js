// Posten (schließen oder verbrennen) zu Transaktionen bündeln, die unter 1.232 Byte bleiben.
import {
  closeAccountIx,
  burnCheckedIx,
  setComputeUnitLimitIx,
  setComputeUnitPriceIx,
  MAX_COMPUTE_UNITS,
  transferSolIx,
} from './instructions.js';
import { buildUnsignedTransaction, PACKET_DATA_SIZE } from './tx.js';
import { toBase64 } from './bytes.js';
import { pumpRewardInstructions } from './pump-rewards.js';
import { TIP_RECIPIENT, batchTipLamports } from './tips.js';

/** Platzhalter beim Messen und Simulieren; die RPC ersetzt ihn (replaceRecentBlockhash). */
export const PLACEHOLDER_BLOCKHASH = '11111111111111111111111111111111';
export const DEFAULT_MAX_ITEMS = 20;

/**
 * Anweisungen für einen Posten. „close“ nur für leere Konten; „burn“ verbrennt den ganzen Bestand
 * und schließt danach. Die Miete geht immer an den Besitzer.
 */
export function instructionsForItem({ owner, item }) {
  const { account, action } = item;
  if (action === 'claim-pump') return pumpRewardInstructions({ owner, account });
  const close = closeAccountIx({ programId: account.programId, account: account.address, destination: owner, owner });
  if (action === 'close') {
    if (account.amount !== 0n) throw new Error('Only empty accounts can be closed directly');
    return [close];
  }
  if (action === 'burn') {
    const burn = burnCheckedIx({
      programId: account.programId,
      account: account.address,
      mint: account.mint,
      owner,
      amount: account.amount,
      decimals: account.decimals,
    });
    return [burn, close];
  }
  throw new Error(`Unknown action: ${String(action)}`);
}

export function buildBatchTransaction({ owner, items, recentBlockhash, computeUnitLimit, computeUnitPrice, withTip = false }) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('No items for this transaction');
  const tipLamports = batchTipLamports({ owner, items, withTip });
  const instructions = [
    setComputeUnitLimitIx(computeUnitLimit),
    setComputeUnitPriceIx(computeUnitPrice),
    ...items.flatMap((item) => instructionsForItem({ owner, item })),
    ...(tipLamports > 0 ? [transferSolIx({ from: owner, to: TIP_RECIPIENT, lamports: tipLamports })] : []),
  ];
  const tx = buildUnsignedTransaction({ feePayer: owner, recentBlockhash, instructions });
  return { ...tx, base64: toBase64(tx.bytes) };
}

/** Größe in Byte; hängt nicht vom Blockhash und den Budgetwerten ab (feste Breite). */
export function measureBatch({ owner, items, withTip = false }) {
  return buildBatchTransaction({ owner, items, recentBlockhash: PLACEHOLDER_BLOCKHASH, computeUnitLimit: MAX_COMPUTE_UNITS, computeUnitPrice: 1, withTip }).size;
}

/** Füllt der Reihe nach jede Transaktion so weit, wie Größe und Höchstzahl es erlauben. */
export function packItems({ owner, items, maxItemsPerTx = DEFAULT_MAX_ITEMS, sizeLimit = PACKET_DATA_SIZE, withTip = false }) {
  batchTipLamports({ owner, items, withTip });
  const batches = [];
  let current = [];
  for (const item of items) {
    const candidate = [...current, item];
    if (candidate.length <= maxItemsPerTx && measureBatch({ owner, items: candidate, withTip }) <= sizeLimit) {
      current = candidate;
      continue;
    }
    if (current.length === 0) throw new Error('An item exceeds the transaction size limit');
    batches.push(current);
    current = [item];
    if (measureBatch({ owner, items: current, withTip }) > sizeLimit) throw new Error('An item exceeds the transaction size limit');
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
