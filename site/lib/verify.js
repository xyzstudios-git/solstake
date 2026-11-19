// Prüft, ob die Wallet genau das unterschrieben hat, was Leergut gebaut und simuliert hat.
// Erlaubt sind nur angepasste Rechenbudget-Anweisungen (Gebühr gedeckelt) und Lighthouse-
// Prüfanweisungen, wie Phantom sie anhängt. Alles andere wird nicht gesendet.
import { decompileLegacyMessage } from './tx.js';
import { COMPUTE_BUDGET_PROGRAM_ID, MAX_COMPUTE_UNITS } from './instructions.js';
import { BASE_FEE_LAMPORTS } from './fees.js';

export const LIGHTHOUSE_PROGRAM_ID = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const MAX_EXTRA_FEE_LAMPORTS = 1_000_000; // 0,001 SOL Spielraum für Gebührenanpassungen der Wallet
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000;
const SET_LIMIT = 2;
const SET_PRICE = 3;
const TAMPERED = 'The wallet changed the transaction. It will not be sent for your safety.';

const fail = (reason) => ({ ok: false, reason });

function sameInstruction(a, b) {
  return (
    a.programId === b.programId &&
    a.keys.length === b.keys.length &&
    a.keys.every((k, i) => k.pubkey === b.keys[i].pubkey && k.isSigner === b.keys[i].isSigner && k.isWritable === b.keys[i].isWritable) &&
    a.data.length === b.data.length &&
    a.data.every((byte, i) => byte === b.data[i])
  );
}

// Gebühr so, wie die Laufzeit sie berechnet: Grundgebühr plus Limit mal Preis.
function feeOf(message) {
  const budget = message.instructions.filter((ix) => ix.programId === COMPUTE_BUDGET_PROGRAM_ID);
  const others = message.instructions.length - budget.length;
  let limit = Math.min(MAX_COMPUTE_UNITS, DEFAULT_UNITS_PER_INSTRUCTION * others);
  let price = 0n;
  for (const ix of budget) {
    const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    if (ix.data[0] === SET_LIMIT && ix.data.length === 5) limit = view.getUint32(1, true);
    if (ix.data[0] === SET_PRICE && ix.data.length === 9) price = view.getBigUint64(1, true);
  }
  return BASE_FEE_LAMPORTS * message.header.numRequiredSignatures + Number((BigInt(limit) * price + 999_999n) / 1_000_000n);
}

/**
 * @param {{ signed: Uint8Array, expected: { messageBytes: Uint8Array }, maxExtraFeeLamports?: number }} input
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkReturnedTransaction({ signed, expected, maxExtraFeeLamports = MAX_EXTRA_FEE_LAMPORTS }) {
  try {
    if (!(signed instanceof Uint8Array) || signed.length < 65 || signed[0] !== 1) return fail(TAMPERED);
    const got = decompileLegacyMessage(signed.subarray(65));
    const want = decompileLegacyMessage(expected.messageBytes);
    if (got.header.numRequiredSignatures !== 1 || got.accountKeys[0] !== want.accountKeys[0]) return fail(TAMPERED);
    if (got.recentBlockhash !== want.recentBlockhash) return fail(TAMPERED);
    const core = (list) => list.filter((ix) => ix.programId !== COMPUTE_BUDGET_PROGRAM_ID && ix.programId !== LIGHTHOUSE_PROGRAM_ID);
    const gotCore = core(got.instructions);
    const wantCore = core(want.instructions);
    if (gotCore.length !== wantCore.length || !gotCore.every((ix, i) => sameInstruction(ix, wantCore[i]))) return fail(TAMPERED);
    if (feeOf(got) > feeOf(want) + maxExtraFeeLamports) {
      return fail('The wallet added a much higher network fee. This transaction will not be sent.');
    }
    return { ok: true };
  } catch {
    return fail(TAMPERED);
  }
}
