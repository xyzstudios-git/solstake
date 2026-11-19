// Token-Konten einordnen: Was darf geschlossen, was verbrannt werden, was bleibt unberührt?
import { isAddress } from './base58.js';
import { TOKEN_PROGRAMS, TOKEN_2022_PROGRAM_ID } from './instructions.js';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Bekannte Tokens mit echtem Wert: Bestände werden nie verbrannt (leere Konten dürfen zu). */
export const PROTECTED_MINTS = Object.freeze({
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUP',
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 'mSOL',
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 'JitoSOL',
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: 'bSOL',
  jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v: 'JupSOL',
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': 'PYUSD',
});
const PROTECTED_NAMES = new Map([
  ...Object.values(PROTECTED_MINTS).map((symbol) => [symbol.toUpperCase(), symbol]),
  ['USD COIN', 'USDC'],
  ['TETHER', 'USDT'],
  ['TETHER USD', 'USDT'],
  ['JUPITER', 'JUP'],
  ['PAYPAL USD', 'PYUSD'],
]);

/** Gibt das Symbol zurück, dessen Namen ein fremdes Token nachahmt (z. B. ein falsches „USDC“), sonst null. */
export function impersonates(meta, mint) {
  if (!meta || PROTECTED_MINTS[mint]) return null;
  for (const text of [meta.symbol, meta.name]) {
    const key = String(text ?? '').normalize('NFKC').trim().toUpperCase();
    if (PROTECTED_NAMES.has(key)) return PROTECTED_NAMES.get(key);
  }
  return null;
}

export const STATUS = Object.freeze({
  EMPTY: 'empty',
  HOLDING: 'holding',
  NFT: 'nft',
  WSOL: 'wsol',
  PROTECTED: 'protected',
  FROZEN: 'frozen',
  FOREIGN_CLOSE: 'foreign-close-authority',
  WITHHELD: 'withheld-fees',
  CONFIDENTIAL: 'confidential',
  UNKNOWN: 'unknown',
});

const REASONS = Object.freeze({
  [STATUS.NFT]: 'NFT burning is not supported yet.',
  [STATUS.WSOL]: 'Wrapped SOL is never burned.',
  [STATUS.PROTECTED]: 'Protected token. Consider selling instead of burning.',
  [STATUS.FROZEN]: 'Frozen. Only the token issuer can unfreeze it.',
  [STATUS.FOREIGN_CLOSE]: 'Only a different address can close this account.',
  [STATUS.WITHHELD]: 'This account still holds withheld transfer fees.',
  [STATUS.CONFIDENTIAL]: 'Confidential balances are not supported.',
  [STATUS.UNKNOWN]: 'Unknown account format.',
});

const U64_MAX = (1n << 64n) - 1n;

function parseAmount(text) {
  if (typeof text !== 'string' || !/^\d{1,20}$/.test(text)) return null;
  const value = BigInt(text);
  return value <= U64_MAX ? value : null;
}

function findExtension(info, name) {
  const list = Array.isArray(info.extensions) ? info.extensions : [];
  return list.find((ext) => ext?.extension === name) ?? null;
}

function hasWithheldFees(info) {
  const withheld = findExtension(info, 'transferFeeAmount')?.state?.withheldAmount;
  if (typeof withheld === 'number') return withheld > 0;
  if (typeof withheld === 'string') return /^\d+$/.test(withheld) && BigInt(withheld) > 0n;
  return false;
}

function statusOf(info, amount, decimals, owner) {
  if (info.state !== 'initialized' && info.state !== 'frozen') return STATUS.UNKNOWN;
  if (info.closeAuthority && info.closeAuthority !== owner) return STATUS.FOREIGN_CLOSE;
  if (hasWithheldFees(info)) return STATUS.WITHHELD;
  if (findExtension(info, 'confidentialTransferAccount')) return STATUS.CONFIDENTIAL;
  // Leere Konten lassen sich auch eingefroren schließen (CloseAccount prüft das Einfrieren nicht,
  // gegen die echten Programme in LiteSVM getestet). Verbrennen geht eingefroren dagegen nicht.
  if (amount === 0n) return STATUS.EMPTY;
  if (PROTECTED_MINTS[info.mint]) return STATUS.PROTECTED;
  if (info.state === 'frozen') return STATUS.FROZEN;
  if (info.isNative === true || info.mint === WSOL_MINT) return STATUS.WSOL;
  if (decimals === 0 && amount === 1n) return STATUS.NFT;
  return STATUS.HOLDING;
}

function unknown(address) {
  return { address: typeof address === 'string' ? address : '', status: STATUS.UNKNOWN, action: null, reason: REASONS[STATUS.UNKNOWN] };
}

/**
 * Ordnet einen Eintrag aus getTokenAccountsByOwner (jsonParsed) ein.
 * action: 'close' (leer), 'burn' (verbrennen, dann schließen) oder null (nicht anfassen).
 */
export function classifyTokenAccount(entry, owner) {
  const address = entry?.pubkey;
  const account = entry?.account;
  const parsed = account?.data?.parsed;
  const info = parsed?.info;
  const programId = account?.owner;
  if (!isAddress(address) || parsed?.type !== 'account' || !info || !TOKEN_PROGRAMS.includes(programId)) return unknown(address);
  if (info.owner !== owner || !isAddress(info.mint)) return unknown(address);
  const amount = parseAmount(info.tokenAmount?.amount);
  const decimals = info.tokenAmount?.decimals;
  const validNumbers = amount !== null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255;
  if (!validNumbers || !Number.isSafeInteger(account.lamports) || account.lamports < 0) return unknown(address);

  const status = statusOf(info, amount, decimals, owner);
  const action = status === STATUS.EMPTY ? 'close' : status === STATUS.HOLDING ? 'burn' : null;
  return {
    address,
    programId,
    mint: info.mint,
    lamports: account.lamports,
    amount,
    decimals,
    isToken2022: programId === TOKEN_2022_PROGRAM_ID,
    status,
    action,
    reason: action ? '' : REASONS[status],
  };
}

export function classifyAll(entries, owner) {
  return entries.map((entry) => classifyTokenAccount(entry, owner));
}
