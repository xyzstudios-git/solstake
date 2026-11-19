// Kleine Byte-Helfer für das Solana-Leitungsformat.
const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = 0xffffffff;

/** Solanas „compact-u16“: 7 Bit je Byte, höchstes Bit heißt „es folgt noch eins“. */
export function encodeCompactU16(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`compact-u16 out of range: ${value}`);
  }
  const out = [];
  let rest = value;
  for (;;) {
    const low = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(low);
      return out;
    }
    out.push(low | 0x80);
  }
}

export function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function u64LE(value) {
  if (typeof value !== 'bigint') throw new TypeError('u64: expected a BigInt');
  if (value < 0n || value > U64_MAX) throw new RangeError(`u64 out of range: ${value}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

export function u32LE(value) {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) throw new RangeError(`u32 out of range: ${value}`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

export function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function fromBase64(text) {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
