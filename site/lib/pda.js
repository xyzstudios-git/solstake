// Programmadressen (PDAs) ableiten, z. B. die Metaplex-Metadaten eines Tokens.
// Eine PDA ist ein SHA-256-Hash, der NICHT auf der Ed25519-Kurve liegen darf.
import { addressBytes, encodeBase58 } from './base58.js';
import { concatBytes } from './bytes.js';

export const METADATA_PROGRAM_ID = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

const MARKER = new TextEncoder().encode('ProgramDerivedAddress');
const METADATA_SEED = new TextEncoder().encode('metadata');
const MAX_SEED_LENGTH = 32;
const MAX_SEEDS = 16;

// Ed25519-Feld: p = 2^255 - 19, Kurve -x² + y² = 1 + d·x²·y²
const P = 2n ** 255n - 19n;
const mod = (value) => {
  const r = value % P;
  return r >= 0n ? r : r + P;
};
function modPow(base, exponent) {
  let result = 1n;
  let b = mod(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}
const D = mod(-121665n * modPow(121666n, P - 2n));
const SQRT_M1 = modPow(2n, (P - 1n) / 4n);
const EXP_P_5_8 = (P - 5n) / 8n;

function littleEndianToBigInt(bytes) {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

/**
 * Prüft wie RFC 8032 (und web3.js), ob 32 Byte ein gültiger Kurvenpunkt sind.
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isOnCurve(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return false;
  const last = bytes[31];
  const normed = Uint8Array.from(bytes);
  normed[31] = last & 0x7f;
  const y = littleEndianToBigInt(normed);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const v3 = mod(v * v * v);
  const v7 = mod(v3 * v3 * v);
  const x = mod(u * v3 * modPow(mod(u * v7), EXP_P_5_8));
  const vx2 = mod(v * x * x);
  let root;
  if (vx2 === u) root = x;
  else if (vx2 === mod(-u)) root = mod(x * SQRT_M1);
  else return false;
  return !(root === 0n && (last & 0x80) !== 0);
}

async function sha256(bytes) {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

/** Leitet die Adresse für genau diese Seeds ab; null, wenn sie auf der Kurve läge. */
export async function createProgramAddress(seeds, programId) {
  if (seeds.length > MAX_SEEDS) throw new Error('Too many seeds');
  if (seeds.some((seed) => seed.length > MAX_SEED_LENGTH)) throw new Error('Seed is too long');
  const hash = await sha256(concatBytes([...seeds, addressBytes(programId), MARKER]));
  return isOnCurve(hash) ? null : encodeBase58(hash);
}

/**
 * Sucht wie web3.js von Bump 255 abwärts die erste gültige Programmadresse.
 * @returns {Promise<[string, number]>}
 */
export async function findProgramAddress(seeds, programId) {
  for (let bump = 255; bump > 0; bump -= 1) {
    const address = await createProgramAddress([...seeds, Uint8Array.of(bump)], programId);
    if (address) return [address, bump];
  }
  throw new Error('No valid program address found');
}

/** Adresse des Metaplex-Metadatenkontos zu einem Mint. */
export async function metadataAddress(mint) {
  const program = addressBytes(METADATA_PROGRAM_ID);
  const [address] = await findProgramAddress([METADATA_SEED, program, addressBytes(mint)], METADATA_PROGRAM_ID);
  return address;
}
