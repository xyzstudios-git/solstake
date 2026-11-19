// Numbers and addresses for the English interface.
const solFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Nur die Zahl, für Stellen, an denen das Solana-Zeichen die Einheit zeigt. */
export function formatSolNumber(lamports) {
  return solFormat.format(lamports / LAMPORTS_PER_SOL);
}

export function formatSol(lamports) {
  return `${formatSolNumber(lamports)} SOL`;
}

/** Exakt aus BigInt, ohne Rundungsfehler; zeigt höchstens `maxFraction` Nachkommastellen. */
export function formatTokenAmount(amount, decimals, maxFraction = 6) {
  if (amount === 0n) return '0';
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const fraction = decimals > 0 ? (amount % base).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '') : '';
  if (whole === 0n && fraction === '') return `< 0.${'0'.repeat(maxFraction - 1)}1`;
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${wholeText}.${fraction}` : wholeText;
}

export function shortAddress(address) {
  return typeof address === 'string' && address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : String(address ?? '');
}

export function formatUsd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  if (value > 0 && value < 0.01) return '<$0.01';
  return usdFormat.format(value);
}

/** Zwei Buchstaben als Platzhalter-Symbol, wie die Monogramme in Apples Kontakten. */
export function monogram(text) {
  const letters = Array.from(String(text ?? '')).filter((ch) => /[\p{L}\p{N}]/u.test(ch));
  return letters.length > 0 ? letters.slice(0, 2).join('').toUpperCase() : '?';
}

/** Ungefährer Dollarwert eines Bestands; null ohne Kurs. */
export function tokenValueUsd(amount, decimals, usdPrice) {
  if (typeof usdPrice !== 'number' || !Number.isFinite(usdPrice)) return null;
  return (Number(amount) / 10 ** decimals) * usdPrice;
}
