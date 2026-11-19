// Der Ablauf: erst alles simulieren (ändert nichts), dann unterschreiben, senden und bestätigen.
import { packItems, buildBatchTransaction, PLACEHOLDER_BLOCKHASH, DEFAULT_MAX_ITEMS } from './batch.js';
import { choosePriorityFee, computeUnitLimitFor, estimateNetworkFee } from './fees.js';
import { MAX_COMPUTE_UNITS } from './instructions.js';
import { readFirstSignature, hasSignature } from './tx.js';
import { checkReturnedTransaction } from './verify.js';
import { toBase64 } from './bytes.js';
import { batchTipLamports } from './tips.js';

// Fehlercodes der Token-Programme (TokenError)
const TOKEN_ERRORS = Object.freeze({
  0: 'This would leave the account without enough SOL for rent.',
  1: 'Insufficient balance. It may have changed recently.',
  3: 'The account and token do not match.',
  4: 'This account does not belong to this wallet.',
  11: 'This account is not empty and cannot be closed.',
  17: 'This account is frozen.',
  18: 'The token decimals do not match.',
});
const TX_ERRORS = Object.freeze({
  InsufficientFundsForFee: 'Not enough SOL in the wallet for the network fee.',
  InvalidAccountForFee: 'This address cannot pay fees. It is not a standard wallet account (it may be a program).',
  BlockhashNotFound: 'The transaction expired. Try again.',
  AccountNotFound: 'An account no longer exists. It may already be closed.',
  AlreadyProcessed: 'This transaction has already been processed.',
});
const EXPIRED_TEXT = 'The transaction expired before confirmation. No changes were made. Try again.';
const MAX_POLLS = 120;

/** Explains a Solana error in plain English. */
export function explainError(err, logs = []) {
  const custom = err?.InstructionError?.[1]?.Custom;
  if (Number.isInteger(custom) && TOKEN_ERRORS[custom]) return TOKEN_ERRORS[custom];
  if (typeof err === 'string' && TX_ERRORS[err]) return TX_ERRORS[err];
  const logLine = [...logs].reverse().find((line) => typeof line === 'string' && /error|failed/i.test(line));
  if (logLine) return `Rejected: ${logLine.replace(/^Program log: /, '')}`;
  return `Rejected: ${typeof err === 'string' ? err : JSON.stringify(err)}`;
}

function walletMessage(error) {
  const text = error instanceof Error ? error.message : String(error);
  if (/reject|denied|cancel|declin|abgelehnt/i.test(text)) return 'Rejected in the wallet. Nothing was sent.';
  return `The wallet reported an error: ${text}`;
}

function sendMessage(error) {
  const data = error?.data;
  if (data?.err) return explainError(data.err, Array.isArray(data.logs) ? data.logs : []);
  return error instanceof Error ? error.message : String(error);
}

// Halbiert eine fehlschlagende Gruppe, bis die schuldigen Posten gefunden sind. Fehler der ganzen
// Transaktion (Gebühr, Zahler) betreffen jeden Posten gleich; da hilft Halbieren nicht.
async function isolate(simulate, items) {
  const result = await simulate(items);
  if (!result.err) return { ok: [{ items, unitsConsumed: result.unitsConsumed }], failed: [] };
  const error = explainError(result.err, result.logs);
  if (items.length === 1 || !result.err?.InstructionError) return { ok: [], failed: items.map((item) => ({ item, error })) };
  const middle = Math.ceil(items.length / 2);
  const left = await isolate(simulate, items.slice(0, middle));
  const right = await isolate(simulate, items.slice(middle));
  return { ok: [...left.ok, ...right.ok], failed: [...left.failed, ...right.failed] };
}

/**
 * Bündelt die Posten, simuliert jede Transaktion und sortiert aus, was scheitern würde.
 * Ändert nichts auf der Chain und braucht keine Signatur.
 */
export async function prepareBurnPlan({ rpc, owner, items, maxItemsPerTx = DEFAULT_MAX_ITEMS, withTip = false }) {
  batchTipLamports({ owner, items, withTip });
  if (items.length === 0) return { batches: [], failed: [], computeUnitPrice: 0, reclaimLamports: 0, networkFeeLamports: 0, withTip, tipLamports: 0 };
  // Ohne Gebührenstatistik nehmen wir die Mindest-Prioritätsgebühr; das Verbrennen klappt trotzdem.
  const recent = await rpc.getRecentPrioritizationFees().catch(() => []);
  const computeUnitPrice = choosePriorityFee(recent.map((entry) => entry?.prioritizationFee));
  const simulate = async (group) => {
    const { base64 } = buildBatchTransaction({
      owner,
      items: group,
      recentBlockhash: PLACEHOLDER_BLOCKHASH,
      computeUnitLimit: MAX_COMPUTE_UNITS,
      computeUnitPrice,
      withTip,
    });
    return rpc.simulate(base64);
  };

  const ok = [];
  const failed = [];
  const sources = new Set();
  const reserved = new Set(items.flatMap((item) => item.account.reservedAddresses ?? []));
  for (const item of items) {
    if (sources.has(item.account.address) || reserved.has(item.account.address)) {
      throw new Error('An account is used by multiple actions. Reload your selection.');
    }
    sources.add(item.account.address);
  }
  for (const group of packItems({ owner, items, maxItemsPerTx, withTip })) {
    const outcome = await isolate(simulate, group);
    ok.push(...outcome.ok);
    failed.push(...outcome.failed);
  }
  const batches = ok.map((batch) => ({ ...batch, computeUnitLimit: computeUnitLimitFor(batch.unitsConsumed) }));
  return {
    batches,
    failed,
    computeUnitPrice,
    withTip,
    tipLamports: batches.reduce((sum, batch) => sum + batchTipLamports({ owner, items: batch.items, withTip }), 0),
    reclaimLamports: batches.reduce((sum, b) => sum + b.items.reduce((s, item) => s + item.account.lamports, 0), 0),
    networkFeeLamports: estimateNetworkFee(batches.map((b) => ({ computeUnitLimit: b.computeUnitLimit, computeUnitPrice }))),
  };
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function chunk(list, size) {
  return Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
}

const resultFor = (entry, status, extra = {}) => ({ index: entry.index, items: entry.batch.items, signature: null, error: null, ...extra, status });

async function submitSigned({ rpc, signer, txs }) {
  const signed = await signer.signTransactions(txs.map((tx) => tx.bytes));
  if (!Array.isArray(signed) || signed.length !== txs.length) throw new Error('The wallet did not return all transactions.');
  const out = [];
  for (const [i, bytes] of signed.entries()) {
    if (!(bytes instanceof Uint8Array) || !hasSignature(bytes)) {
      out.push({ status: 'failed', error: 'The wallet did not sign this transaction.' });
      continue;
    }
    // Gesendet wird nur, was dem simulierten Plan entspricht
    const check = checkReturnedTransaction({ signed: bytes, expected: txs[i] });
    if (!check.ok) {
      out.push({ status: 'failed', error: check.reason });
      continue;
    }
    const signature = readFirstSignature(bytes);
    const base64 = toBase64(bytes);
    try {
      await rpc.send(base64);
      out.push({ status: 'sent', signature, base64 });
    } catch (error) {
      out.push({ status: 'failed', signature, error: sendMessage(error) });
    }
  }
  return out;
}

// Wallets ohne „signTransaction“ senden selbst, je Transaktion eine Freigabe.
// Nach der ersten Ablehnung wird nichts mehr vorgelegt; schon Gesendetes wird weiter bestätigt.
async function submitViaWallet({ signer, txs }) {
  const out = [];
  for (const tx of txs) {
    if (out.some((entry) => entry.status === 'rejected')) {
      out.push({ status: 'rejected', error: 'Not executed because the wallet rejected an earlier request.' });
      continue;
    }
    try {
      out.push({ status: 'sent', signature: await signer.signAndSend(tx.bytes) });
    } catch (error) {
      out.push({ status: 'rejected', error: walletMessage(error) });
    }
  }
  return out;
}

async function confirm({ rpc, pending, lastValidBlockHeight, sleep, pollMs, resendEvery }) {
  const final = new Map();
  const settle = (list, statuses) => {
    list.forEach((p, i) => {
      const s = statuses[i];
      if (s?.err) final.set(p.signature, { status: 'failed', error: explainError(s.err) });
      else if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) final.set(p.signature, { status: 'confirmed' });
    });
  };
  const open = () => pending.filter((p) => !final.has(p.signature));
  const poll = async (list) => settle(list, await rpc.getSignatureStatuses(list.map((p) => p.signature)).catch(() => []));

  for (let tick = 1; open().length > 0 && tick <= MAX_POLLS; tick += 1) {
    await sleep(pollMs);
    await poll(open());
    if (open().length === 0) break;
    const height = await rpc.getBlockHeight().catch(() => null);
    if (height !== null && height > lastValidBlockHeight) {
      await poll(open()); // letzte Kontrolle, falls sie knapp vorher gelandet ist
      for (const p of open()) final.set(p.signature, { status: 'expired', error: EXPIRED_TEXT });
      break;
    }
    if (tick % resendEvery === 0) {
      for (const p of open()) if (p.base64) await rpc.send(p.base64, { skipPreflight: true }).catch(() => null);
    }
  }
  for (const p of open()) final.set(p.signature, { status: 'unknown', error: 'Transaction status is unknown. Check the explorer.' });
  return final;
}

async function runRound({ rpc, signer, owner, plan, round, onProgress, sleep, pollMs, resendEvery }) {
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
  const txs = round.map(({ batch }) =>
    buildBatchTransaction({
      owner,
      items: batch.items,
      recentBlockhash: blockhash,
      computeUnitLimit: batch.computeUnitLimit,
      computeUnitPrice: plan.computeUnitPrice,
      withTip: plan.withTip ?? false,
    }),
  );
  onProgress({ type: 'signing', indexes: round.map((entry) => entry.index) });
  let submitted;
  try {
    submitted = signer.mode === 'signAndSend' ? await submitViaWallet({ signer, txs }) : await submitSigned({ rpc, signer, txs });
  } catch (error) {
    const message = walletMessage(error);
    round.forEach((entry) => onProgress({ type: 'rejected', index: entry.index, error: message }));
    return round.map((entry) => resultFor(entry, 'rejected', { error: message }));
  }

  const pending = [];
  const results = round.map((entry, i) => {
    const s = submitted[i];
    if (s.status === 'sent') {
      pending.push({ ...s, index: entry.index });
      onProgress({ type: 'sent', index: entry.index, signature: s.signature });
      return null;
    }
    if (s.status === 'rejected') {
      onProgress({ type: 'rejected', index: entry.index, error: s.error });
      return resultFor(entry, 'rejected', { error: s.error });
    }
    onProgress({ type: 'failed', index: entry.index, signature: s.signature ?? null, error: s.error });
    return resultFor(entry, 'failed', { signature: s.signature ?? null, error: s.error });
  });

  const final = await confirm({ rpc, pending, lastValidBlockHeight, sleep, pollMs, resendEvery });
  return round.map((entry, i) => {
    if (results[i]) return results[i];
    const { signature } = submitted[i];
    const outcome = final.get(signature);
    onProgress({ type: outcome.status, index: entry.index, signature, error: outcome.error ?? null });
    return resultFor(entry, outcome.status, { signature, error: outcome.error ?? null });
  });
}

/**
 * Lässt die Transaktionen rundenweise unterschreiben (eine Wallet-Freigabe je Runde),
 * sendet sie und wartet auf die Bestätigung. Lehnt die Wallet ab, bleibt der Rest unangetastet.
 */
export async function executeBurnPlan({
  rpc,
  signer,
  owner,
  plan,
  onProgress = () => {},
  roundSize = 8,
  sleep = defaultSleep,
  pollMs = 1500,
  resendEvery = 2,
}) {
  const entries = plan.batches.map((batch, index) => ({ batch, index }));
  const rounds = chunk(entries, roundSize);
  const results = [];
  for (const [r, round] of rounds.entries()) {
    const outcome = await runRound({ rpc, signer, owner, plan, round, onProgress, sleep, pollMs, resendEvery });
    results.push(...outcome);
    if (outcome.some((res) => res.status === 'rejected')) {
      for (const later of rounds.slice(r + 1).flat()) {
        results.push(resultFor(later, 'rejected', { error: 'Not executed because the wallet rejected an earlier request.' }));
      }
      break;
    }
  }
  return results;
}
