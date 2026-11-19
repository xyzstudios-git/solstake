import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { encodeBase58, decodeBase58, isAddress, addressBytes } from '../site/lib/base58.js';
import { encodeCompactU16, concatBytes, u64LE, u32LE, toBase64, fromBase64 } from '../site/lib/bytes.js';

test('base58 encodes and decodes keys exactly like web3.js', () => {
  for (let i = 0; i < 50; i++) {
    const key = Keypair.generate().publicKey;
    assert.equal(encodeBase58(key.toBytes()), key.toBase58());
    assert.deepEqual(decodeBase58(key.toBase58()), key.toBytes());
  }
});

test('base58 keeps leading zero bytes as leading ones', () => {
  const zeros = new Uint8Array(32);
  assert.equal(encodeBase58(zeros), '11111111111111111111111111111111');
  assert.deepEqual(decodeBase58('11111111111111111111111111111111'), zeros);
  assert.equal(encodeBase58(Uint8Array.of(0, 0, 1)), '112');
  assert.equal(encodeBase58(new Uint8Array(0)), '');
  assert.deepEqual(decodeBase58(''), new Uint8Array(0));
});

test('base58 rejects characters outside the alphabet', () => {
  assert.throws(() => decodeBase58('0OIl'), /base58/);
  assert.throws(() => decodeBase58(42), TypeError);
});

test('isAddress accepts only 32-byte keys', () => {
  assert.equal(isAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), true);
  assert.equal(isAddress('abc'), false);
  assert.equal(isAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA0'), false);
  assert.equal(isAddress(''), false);
  assert.equal(isAddress(null), false);
  assert.throws(() => addressBytes('abc'), /address/);
});

test('compact-u16 matches the Solana wire format', () => {
  const cases = [
    [0, [0]], [1, [1]], [127, [0x7f]], [128, [0x80, 0x01]], [255, [0xff, 0x01]],
    [16383, [0xff, 0x7f]], [16384, [0x80, 0x80, 0x01]], [65535, [0xff, 0xff, 0x03]],
  ];
  for (const [n, bytes] of cases) assert.deepEqual(encodeCompactU16(n), bytes, `n=${n}`);
  assert.throws(() => encodeCompactU16(-1), RangeError);
  assert.throws(() => encodeCompactU16(65536), RangeError);
  assert.throws(() => encodeCompactU16(1.5), RangeError);
});

test('u64LE and u32LE write little-endian and check ranges', () => {
  assert.deepEqual([...u64LE(1n)], [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...u64LE(0xffffffffffffffffn)], Array(8).fill(255));
  assert.throws(() => u64LE(-1n), RangeError);
  assert.throws(() => u64LE(1n << 64n), RangeError);
  assert.throws(() => u64LE(5), TypeError);
  assert.deepEqual([...u32LE(1_400_000)], [0xc0, 0x5c, 0x15, 0x00]);
  assert.throws(() => u32LE(2 ** 32), RangeError);
  assert.throws(() => u32LE(-1), RangeError);
});

test('concatBytes joins parts without touching them', () => {
  const a = Uint8Array.of(1, 2);
  const b = Uint8Array.of(3);
  assert.deepEqual(concatBytes([a, b, new Uint8Array(0)]), Uint8Array.of(1, 2, 3));
  assert.deepEqual(a, Uint8Array.of(1, 2));
});

test('base64 round trip matches Buffer', () => {
  const bytes = Uint8Array.from({ length: 1232 }, (_, i) => (i * 7) & 255);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
});
