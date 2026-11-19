// Base58 mit dem Bitcoin-Alphabet, wie Solana es für Adressen und Signaturen nutzt.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((char, i) => [char, i]));
const MAX_ADDRESS_LENGTH = 44;

export function encodeBase58(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '1'.repeat(zeros);
  for (let k = digits.length - 1; k >= 0; k -= 1) out += ALPHABET[digits[k]];
  return out;
}

export function decodeBase58(text) {
  if (typeof text !== 'string') throw new TypeError('base58: expected a string');
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros += 1;
  const bytes = [];
  for (let i = zeros; i < text.length; i += 1) {
    const value = INDEX.get(text[i]);
    if (value === undefined) throw new Error(`base58: invalid character "${text[i]}"`);
    let carry = value;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let k = 0; k < bytes.length; k += 1) out[out.length - 1 - k] = bytes[k];
  return out;
}

function tryDecode(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_ADDRESS_LENGTH) return null;
  try {
    return decodeBase58(text);
  } catch {
    return null;
  }
}

/** true, wenn der Text eine Solana-Adresse (32 Byte) ist. */
export function isAddress(text) {
  return tryDecode(text)?.length === 32;
}

/** Die 32 Bytes einer Adresse; wirft bei allem anderen. */
export function addressBytes(text) {
  const bytes = tryDecode(text);
  if (bytes?.length !== 32) throw new Error(`Invalid address: ${String(text).slice(0, 60)}`);
  return bytes;
}
