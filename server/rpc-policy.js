const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const UPSTREAM_TIMEOUT_MS = 45_000;

const isText = (value, max = 100) => typeof value === 'string' && value.length > 0 && value.length <= max;
const isList = (value, max) => Array.isArray(value) && value.length > 0 && value.length <= max && value.every((v) => isText(v));
const optionsOnly = (value, allowed) => value === undefined || (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((k) => allowed.includes(k)));

/** Erlaubte Methoden mit Prüfung ihrer Parameter; alles andere wird nicht weitergereicht. */
export const METHODS = Object.freeze({
  getTokenAccountsByOwner: (p) => isText(p[0]) && TOKEN_PROGRAMS.has(p[1]?.programId) && Object.keys(p[1]).length === 1 && optionsOnly(p[2], ['encoding', 'commitment']),
  getMultipleAccounts: (p) => isList(p[0], 100) && optionsOnly(p[1], ['encoding', 'commitment']),
  getBalance: (p) => isText(p[0]) && optionsOnly(p[1], ['commitment']),
  getMinimumBalanceForRentExemption: (p) => Number.isInteger(p[0]) && p[0] >= 0 && p[0] <= 10 * 1024 * 1024 && optionsOnly(p[1], ['commitment']),
  getLatestBlockhash: (p) => optionsOnly(p[0], ['commitment']),
  getBlockHeight: (p) => optionsOnly(p[0], ['commitment']),
  getRecentPrioritizationFees: (p) => p.length === 0 || (Array.isArray(p[0]) && p[0].length <= 128),
  simulateTransaction: (p) => isText(p[0], 4096) && optionsOnly(p[1], ['encoding', 'sigVerify', 'replaceRecentBlockhash', 'commitment']),
  sendTransaction: (p) => isText(p[0], 4096) && optionsOnly(p[1], ['encoding', 'skipPreflight', 'preflightCommitment', 'maxRetries']),
  getSignatureStatuses: (p) => isList(p[0], 256) && optionsOnly(p[1], ['searchTransactionHistory']),
  getTransaction: (p) => isText(p[0], 88) && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(p[0]) && optionsOnly(p[1], ['encoding', 'commitment', 'maxSupportedTransactionVersion']) && p[1]?.encoding === 'json' && p[1]?.commitment === 'confirmed' && p[1]?.maxSupportedTransactionVersion === 0,
});
export const ALLOWED_METHODS = new Set(Object.keys(METHODS));

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://api.jup.ag",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');
export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CSP,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
});

