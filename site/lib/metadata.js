// Token-Namen aus der Chain lesen: Token-2022-Erweiterung oder Metaplex-Metadaten.
import { fromBase64 } from './bytes.js';
import { metadataAddress } from './pda.js';
import { TOKEN_2022_PROGRAM_ID } from './instructions.js';

const METADATA_KEY_V1 = 4;
const NAME_OFFSET = 1 + 32 + 32; // Schlüssel, Update-Berechtigter, Mint
const MAX_FIELD_BYTES = 200;
const ACCOUNTS_PER_CALL = 100;
const decoder = new TextDecoder('utf-8', { fatal: false });
// Steuerzeichen, Richtungswechsel und unsichtbare Zeichen: damit lassen sich Namen fälschen.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufe00-\ufe0f\ufeff\uffa0\u{e0000}-\u{e007f}]/gu;

/** Bereinigt Text aus der Chain für die Anzeige und kürzt auf `max` Zeichen. */
export function cleanText(value, max = 40) {
  if (typeof value !== 'string') return '';
  const text = value.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

function readString(view, bytes, offset) {
  if (offset + 4 > bytes.length) return null;
  const length = view.getUint32(offset, true);
  const end = offset + 4 + length;
  if (length > MAX_FIELD_BYTES || end > bytes.length) return null;
  return { value: decoder.decode(bytes.subarray(offset + 4, end)), next: end };
}

/** Liest Name, Symbol und URI aus einem Metaplex-Metadatenkonto; null bei allem anderen. */
export function parseMetaplexMetadata(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < NAME_OFFSET || bytes[0] !== METADATA_KEY_V1) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const name = readString(view, bytes, NAME_OFFSET);
  const symbol = name && readString(view, bytes, name.next);
  const uri = symbol && readString(view, bytes, symbol.next);
  if (!uri) return null;
  return { name: cleanText(name.value, 40), symbol: cleanText(symbol.value, 12), uri: cleanText(uri.value, MAX_FIELD_BYTES) };
}

/** Name und Symbol aus der Token-2022-Erweiterung „tokenMetadata“ eines Mints (jsonParsed). */
export function tokenMetadataFromParsedMint(entry) {
  const list = entry?.data?.parsed?.info?.extensions;
  if (!Array.isArray(list)) return null;
  const state = list.find((ext) => ext?.extension === 'tokenMetadata')?.state;
  const name = cleanText(state?.name, 40);
  const symbol = cleanText(state?.symbol, 12);
  return name || symbol ? { name, symbol } : null;
}

function chunk(list, size) {
  return Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
}

function decodeAccountData(info) {
  const data = info?.data;
  if (!Array.isArray(data) || data[1] !== 'base64' || typeof data[0] !== 'string') return null;
  try {
    return fromBase64(data[0]);
  } catch {
    return null;
  }
}

async function loadAccounts(rpc, addresses, encoding, onWarning) {
  try {
    const result = await rpc.getMultipleAccounts(addresses, encoding);
    return Array.isArray(result) ? result : [];
  } catch (error) {
    onWarning(error);
    return [];
  }
}

/**
 * Sucht Namen für die Mints der Konten. Fehlende Namen sind kein Fehler; `onWarning` erfährt davon.
 * @returns {Promise<Map<string, {name: string, symbol: string}>>}
 */
export async function fetchTokenNames({ rpc, accounts, onWarning = () => {} }) {
  const names = new Map();
  const mints = [...new Set(accounts.map((acc) => acc.mint))];
  const token2022Mints = [...new Set(accounts.filter((acc) => acc.programId === TOKEN_2022_PROGRAM_ID).map((acc) => acc.mint))];

  for (const part of chunk(token2022Mints, ACCOUNTS_PER_CALL)) {
    const infos = await loadAccounts(rpc, part, 'jsonParsed', onWarning);
    infos.forEach((info, i) => {
      const meta = tokenMetadataFromParsedMint(info);
      if (meta) names.set(part[i], meta);
    });
  }

  const rest = mints.filter((mint) => !names.has(mint));
  const pdas = await Promise.all(rest.map((mint) => metadataAddress(mint).catch(() => null)));
  const pairs = rest.map((mint, i) => [mint, pdas[i]]).filter(([, pda]) => pda);
  for (const part of chunk(pairs, ACCOUNTS_PER_CALL)) {
    const infos = await loadAccounts(rpc, part.map(([, pda]) => pda), 'base64', onWarning);
    infos.forEach((info, i) => {
      const meta = parseMetaplexMetadata(decodeAccountData(info));
      if (meta && (meta.name || meta.symbol)) names.set(part[i][0], { name: meta.name, symbol: meta.symbol });
    });
  }
  return names;
}
