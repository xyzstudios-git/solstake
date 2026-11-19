// Lokale Sol-Burn-Historie. Rückzahlungswerte bleiben als Schätzung gekennzeichnet,
// bis der tatsächliche SOL-Saldoeffekt einer Transaktion vorliegt.
import { decodeBase58, isAddress } from './base58.js';
import { cleanText } from './metadata.js';

const PREFIX = 'solburn:history:v1:';
const STATUSES = new Set(['sent', 'confirmed', 'failed', 'expired', 'unknown']);
const MAX_RECORDS = 20_000;
const MAX_JSON_LENGTH = 8 * 1024 * 1024;
const STORAGE_WARNING = 'History cannot be saved permanently in this browser. New entries remain visible for this session.';
const DATA_WARNING = 'Some saved history could not be read. The displayed totals may be incomplete.';

function validSignature(signature) {
  if (typeof signature !== 'string' || signature.length < 64 || signature.length > 88) return false;
  try {
    return decodeBase58(signature).length === 64;
  } catch {
    return false;
  }
}

const unsignedLamports = (value) => Number.isSafeInteger(value) && value >= 0;
const timestampValid = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;

function normalizeEntry(entry, now) {
  if (!entry || !validSignature(entry.signature) || !STATUSES.has(entry.status)) throw new Error('Invalid transaction for history.');
  const timestamp = entry.timestamp ?? now;
  if (!timestampValid(timestamp) || !unsignedLamports(entry.reclaimLamports) || !unsignedLamports(entry.feeLamports)) {
    throw new Error('Invalid amounts or timestamp in history.');
  }
  const actualNetLamports = entry.actualNetLamports ?? null;
  if (actualNetLamports !== null && !Number.isSafeInteger(actualNetLamports)) throw new Error('Invalid actual SOL balance change.');
  if (!Array.isArray(entry.sources) || entry.sources.length > 100) throw new Error('Invalid recovery sources.');
  const sources = entry.sources.map((source) => {
    if (!source || !['token', 'pump'].includes(source.kind) || !Number.isSafeInteger(source.count) || source.count < 1) {
      throw new Error('Invalid recovery source.');
    }
    return { kind: source.kind, label: cleanText(source.label, 80), count: source.count };
  });
  return {
    signature: entry.signature,
    timestamp,
    status: entry.status,
    reclaimLamports: entry.reclaimLamports,
    feeLamports: entry.feeLamports,
    actualNetLamports,
    sources,
    error: entry.error ? cleanText(entry.error, 300) : null,
  };
}

function mergeEntry(previous, incoming) {
  if (!previous) return incoming;
  if (previous.status === 'confirmed' && incoming.status !== 'confirmed') return previous;
  if (previous.status === 'failed' && previous.actualNetLamports !== null && incoming.status !== 'confirmed') return previous;
  if (previous.actualNetLamports !== null && incoming.actualNetLamports === null && previous.status === incoming.status) {
    return { ...previous, timestamp: Math.min(previous.timestamp, incoming.timestamp) };
  }
  const updated = { ...previous, ...incoming, timestamp: Math.min(previous.timestamp, incoming.timestamp) };
  if (previous.actualNetLamports !== null && incoming.actualNetLamports === null) {
    updated.actualNetLamports = previous.actualNetLamports;
    updated.feeLamports = previous.feeLamports;
  }
  return updated;
}

function mergedEntries(...lists) {
  const entries = new Map();
  for (const list of lists) {
    for (const entry of list) entries.set(entry.signature, mergeEntry(entries.get(entry.signature), entry));
  }
  return [...entries.values()].sort((a, b) => b.timestamp - a.timestamp || a.signature.localeCompare(b.signature));
}

/**
 * Speichert ausschließlich in diesem Browser und getrennt je Wallet.
 * read/upsert liefern { entries, warning }. Speicherfehler erhalten eine Sitzungskopie.
 */
export function createHistoryStore(options = {}) {
  const now = options.now ?? (() => Date.now());
  let storage;
  try {
    storage = Object.hasOwn(options, 'storage') ? options.storage : globalThis.localStorage;
  } catch {
    storage = null;
  }
  const memory = new Map();
  const writeWarnings = new Set();

  function readStored(owner) {
    if (!isAddress(owner)) throw new Error('Invalid wallet address for history.');
    if (!storage) return { entries: [], warning: STORAGE_WARNING, writable: false };
    let raw;
    try {
      raw = storage.getItem(PREFIX + owner);
    } catch {
      return { entries: [], warning: STORAGE_WARNING, writable: false };
    }
    if (raw === null) return { entries: [], warning: null, writable: true };
    try {
      if (typeof raw !== 'string' || raw.length > MAX_JSON_LENGTH) throw new Error('History is too large.');
      const parsed = JSON.parse(raw);
      if (parsed?.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > MAX_RECORDS) throw new Error('Unknown history format.');
      const entries = [];
      let warning = null;
      for (const entry of parsed.entries) {
        try {
          entries.push(normalizeEntry(entry, now()));
        } catch {
          warning = DATA_WARNING;
        }
      }
      return { entries: mergedEntries(entries), warning, writable: warning === null };
    } catch {
      return { entries: [], warning: DATA_WARNING, writable: false };
    }
  }

  function read(owner) {
    const stored = readStored(owner);
    const entries = mergedEntries(stored.entries, memory.get(owner) ?? []);
    memory.set(owner, entries);
    return { entries, warning: stored.warning ?? (writeWarnings.has(owner) ? STORAGE_WARNING : null) };
  }

  function upsert(owner, entry) {
    let incoming;
    try {
      if (!isAddress(owner)) throw new Error('Invalid wallet address.');
      incoming = normalizeEntry(entry, now());
    } catch {
      const previous = isAddress(owner) ? read(owner).entries : [];
      return { entries: previous, warning: 'This transaction could not be recorded in local history.' };
    }
    const stored = readStored(owner);
    const entries = mergedEntries(stored.entries, memory.get(owner) ?? [], [incoming]);
    memory.set(owner, entries);
    let warning = stored.warning;
    if (stored.writable) {
      try {
        if (entries.length > MAX_RECORDS) throw new Error('History is too large.');
        const json = JSON.stringify({ version: 1, entries });
        if (json.length > MAX_JSON_LENGTH) throw new Error('History is too large.');
        storage.setItem(PREFIX + owner, json);
        writeWarnings.delete(owner);
      } catch {
        warning = STORAGE_WARNING;
        writeWarnings.add(owner);
      }
    }
    return { entries, warning };
  }

  return { read, upsert };
}

function dayStart(timestamp) {
  const day = new Date(timestamp);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function previousDays(timestamp, days) {
  const day = new Date(dayStart(timestamp));
  day.setDate(day.getDate() - days);
  return day.getTime();
}

/** Bestätigt nur den direkten Saldoeffekt einer eigenen, selbst bezahlten Transaktion. */
export function reconcileHistoryEntry(entry, transaction, owner) {
  if (!isAddress(owner)) throw new Error('Invalid wallet address for transaction verification.');
  const normalized = normalizeEntry(entry, Date.now());
  const keys = transaction?.transaction?.message?.accountKeys;
  const meta = transaction?.meta;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 256 || !meta || !Object.hasOwn(meta, 'err')) {
    throw new Error('Transaction details are incomplete.');
  }
  const address = (key) => typeof key === 'string' ? key : key?.pubkey;
  if (address(keys[0]) !== owner || keys.filter((key) => address(key) === owner).length !== 1) {
    throw new Error('This wallet did not pay for the transaction.');
  }
  if (transaction.transaction.signatures?.[0] !== normalized.signature) throw new Error('The transaction signature does not match.');
  if (!Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)
    || meta.preBalances.length !== meta.postBalances.length || meta.preBalances.length < keys.length
    || !unsignedLamports(meta.preBalances[0]) || !unsignedLamports(meta.postBalances[0]) || !unsignedLamports(meta.fee)) {
    throw new Error('The transaction SOL balances are invalid.');
  }
  const net = BigInt(meta.postBalances[0]) - BigInt(meta.preBalances[0]);
  const gross = net + BigInt(meta.fee);
  if (gross > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The recovery amount is too large to display safely.');
  const failed = meta.err !== null;
  return {
    ...normalized,
    status: failed ? 'failed' : 'confirmed',
    reclaimLamports: failed ? 0 : Math.max(0, Number(gross)),
    feeLamports: meta.fee,
    actualNetLamports: Number(net),
    error: failed ? cleanText(typeof meta.err === 'string' ? meta.err : JSON.stringify(meta.err), 300) : null,
  };
}

/**
 * Kennzahlen und Chart beziehen sich auf den gewählten Zeitraum.
 * totalClaimedLamports nutzt bestätigte Brutto-Rückzahlungen, zunächst die Plan-Schätzung.
 * netLamports nutzt tatsächliche Saldoeffekte, sonst die bestätigte Plan-Schätzung.
 * Bekannte tatsächliche Kosten fehlgeschlagener Transaktionen gehen in Netto/Gebühren ein.
 */
export function summarizeHistory(entries, { range = 'all', now = Date.now() } = {}) {
  if (!['7d', '30d', 'all'].includes(range) || !timestampValid(now)) throw new Error('Invalid date range.');
  const normalized = mergedEntries(entries.map((entry) => normalizeEntry(entry, now)));
  const start = range === 'all' ? 0 : previousDays(now, range === '7d' ? 6 : 29);
  const selected = normalized.filter((entry) => entry.timestamp >= start && entry.timestamp <= now);
  const confirmed = selected.filter((entry) => entry.status === 'confirmed');
  const paid = selected.filter((entry) => entry.status === 'confirmed' || (entry.status === 'failed' && entry.actualNetLamports !== null));
  const totalClaimedLamports = confirmed.reduce((sum, entry) => sum + BigInt(entry.reclaimLamports), 0n);
  const totalFeeLamports = paid.reduce((sum, entry) => sum + BigInt(entry.feeLamports), 0n);
  const netLamports = paid.reduce((sum, entry) => sum + BigInt(entry.actualNetLamports ?? entry.reclaimLamports - entry.feeLamports), 0n);
  if ([totalClaimedLamports, totalFeeLamports, netLamports].some((value) => value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))) {
    throw new Error('The history total is too large to display safely.');
  }
  const daily = new Map();
  for (const entry of confirmed) {
    const day = dayStart(entry.timestamp);
    daily.set(day, (daily.get(day) ?? 0) + entry.reclaimLamports);
  }
  const today = dayStart(now);
  const firstDay = range === 'all' ? (confirmed.length ? dayStart(confirmed.at(-1).timestamp) : today) : start;
  const days = range === 'all' ? [...new Set([...daily.keys(), today])].sort((a, b) => a - b) : [];
  if (range !== 'all') {
    for (let day = firstDay; day <= today;) {
      days.push(day);
      const next = new Date(day);
      next.setDate(next.getDate() + 1);
      day = next.getTime();
    }
  }
  let cumulative = 0;
  const chartPoints = [{ timestamp: firstDay, lamports: 0 }];
  for (const day of days) {
    cumulative += daily.get(day) ?? 0;
    const end = new Date(day);
    end.setDate(end.getDate() + 1);
    chartPoints.push({ timestamp: Math.min(now, end.getTime() - 1), lamports: cumulative });
  }
  return {
    totalClaimedLamports: Number(totalClaimedLamports),
    confirmedCount: confirmed.length,
    pendingCount: selected.filter((entry) => entry.status === 'sent' || entry.status === 'unknown').length,
    failedCount: selected.filter((entry) => entry.status === 'failed' || entry.status === 'expired').length,
    totalFeeLamports: Number(totalFeeLamports),
    netLamports: Number(netLamports),
    netIsEstimated: confirmed.some((entry) => entry.actualNetLamports === null),
    claimedIsEstimated: confirmed.some((entry) => entry.actualNetLamports === null),
    chartPoints,
    entries: selected,
  };
}
