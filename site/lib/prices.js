// Dollarkurse von Jupiter (frei, ohne Schlüssel). Nur eine Warnhilfe: Fehlt ein Kurs, heißt das nichts.
import { isAddress } from './base58.js';

export const PRICE_URL = 'https://api.jup.ag/price/v3';
const IDS_PER_CALL = 50;

function chunk(list, size) {
  return Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
}

/**
 * @returns {Promise<Map<string, number>>} Mint → Dollarkurs je ganzem Token
 */
export async function fetchUsdPrices({ mints, fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 8000, onWarning = () => {} }) {
  const prices = new Map();
  const unique = [...new Set(mints)].filter(isAddress);
  for (const part of chunk(unique, IDS_PER_CALL)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${PRICE_URL}?ids=${part.join(',')}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Price request: HTTP ${response.status}`);
      const body = await response.json();
      for (const mint of part) {
        const price = body?.[mint]?.usdPrice;
        if (typeof price === 'number' && Number.isFinite(price) && price >= 0) prices.set(mint, price);
      }
    } catch (error) {
      onWarning(error);
    } finally {
      clearTimeout(timer);
    }
  }
  return prices;
}
