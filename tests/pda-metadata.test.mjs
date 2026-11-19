import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PublicKey, Keypair } from '@solana/web3.js';
import { isOnCurve, findProgramAddress, metadataAddress, METADATA_PROGRAM_ID } from '../site/lib/pda.js';
import {
  parseMetaplexMetadata,
  tokenMetadataFromParsedMint,
  cleanText,
  fetchTokenNames,
} from '../site/lib/metadata.js';
import { fetchUsdPrices } from '../site/lib/prices.js';
import { toBase64 } from '../site/lib/bytes.js';
import { TOKEN, TOKEN_2022, randomAddress } from './support/fixtures.mjs';

test('isOnCurve agrees with web3.js on random bytes and real keys', () => {
  for (let i = 0; i < 300; i++) {
    const bytes = new Uint8Array(randomBytes(32));
    assert.equal(isOnCurve(bytes), PublicKey.isOnCurve(bytes), Buffer.from(bytes).toString('hex'));
  }
  for (let i = 0; i < 30; i++) assert.equal(isOnCurve(Keypair.generate().publicKey.toBytes()), true);
});

test('isOnCurve handles edge encodings like web3.js', () => {
  const tooBig = new Uint8Array(32).fill(0xff);
  tooBig[31] = 0x7f;
  const negativeZero = new Uint8Array(32);
  negativeZero[0] = 1;
  negativeZero[31] = 0x80;
  const one = new Uint8Array(32);
  one[0] = 1;
  for (const bytes of [tooBig, negativeZero, one]) assert.equal(isOnCurve(bytes), PublicKey.isOnCurve(bytes));
  assert.equal(isOnCurve(new Uint8Array(31)), false);
});

test('findProgramAddress and metadataAddress match web3.js', async () => {
  const program = new PublicKey(METADATA_PROGRAM_ID);
  for (let i = 0; i < 20; i++) {
    const mint = Keypair.generate().publicKey;
    const [ref, refBump] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), program.toBuffer(), mint.toBuffer()],
      program,
    );
    const [own, bump] = await findProgramAddress(
      [new TextEncoder().encode('metadata'), program.toBytes(), mint.toBytes()],
      METADATA_PROGRAM_ID,
    );
    assert.equal(own, ref.toBase58());
    assert.equal(bump, refBump);
    assert.equal(await metadataAddress(mint.toBase58()), ref.toBase58());
  }
  await assert.rejects(findProgramAddress([new Uint8Array(33)], METADATA_PROGRAM_ID), /Seed/);
});

// Metaplex-Metadaten im Borsh-Format, wie sie on-chain liegen
function borshString(text, padTo) {
  const raw = new TextEncoder().encode(text);
  const len = padTo ?? raw.length;
  const out = new Uint8Array(4 + len);
  new DataView(out.buffer).setUint32(0, len, true);
  out.set(raw, 4);
  return out;
}
function metadataBytes({ name, symbol, uri, pad = true, key = 4 }) {
  const parts = [
    Uint8Array.of(key),
    new Uint8Array(32),
    new Uint8Array(32),
    borshString(name, pad ? 32 : undefined),
    borshString(symbol, pad ? 10 : undefined),
    borshString(uri, pad ? 200 : undefined),
    Uint8Array.of(0, 0, 0, 1, 1),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

test('parseMetaplexMetadata reads padded and unpadded strings', () => {
  assert.deepEqual(parseMetaplexMetadata(metadataBytes({ name: 'Bonk', symbol: 'BONK', uri: 'https://x' })), {
    name: 'Bonk',
    symbol: 'BONK',
    uri: 'https://x',
  });
  assert.deepEqual(parseMetaplexMetadata(metadataBytes({ name: 'Dog Wif Hat', symbol: 'WIF', uri: '', pad: false })), {
    name: 'Dog Wif Hat',
    symbol: 'WIF',
    uri: '',
  });
});

test('parseMetaplexMetadata rejects foreign or broken data', () => {
  assert.equal(parseMetaplexMetadata(metadataBytes({ name: 'A', symbol: 'B', uri: '', key: 6 })), null);
  assert.equal(parseMetaplexMetadata(metadataBytes({ name: 'A', symbol: 'B', uri: '' }).slice(0, 70)), null);
  const huge = metadataBytes({ name: 'A', symbol: 'B', uri: '' });
  new DataView(huge.buffer).setUint32(65, 5000, true);
  assert.equal(parseMetaplexMetadata(huge), null);
  assert.equal(parseMetaplexMetadata(new Uint8Array(0)), null);
});

test('cleanText strips control and direction characters and shortens', () => {
  assert.equal(cleanText('  Bonk\u0000\u0000  '), 'Bonk');
  assert.equal(cleanText('Fake‮USDC'), 'FakeUSDC');
  assert.equal(cleanText('a​b⁦c'), 'abc');
  assert.equal(cleanText('<img src=x>'), '<img src=x>');
  assert.equal(cleanText('x'.repeat(60), 10), 'xxxxxxxxx…');
  assert.equal(cleanText(undefined), '');
  assert.equal(cleanText('US­DC'), 'USDC');
  assert.equal(cleanText('a؜bㅤc️d'), 'abcd');
  assert.equal(cleanText('x\u{E0041}\u{E0042}y'), 'xy');
  assert.equal(cleanText('ᅟᅠﾠz͏᠎'), 'z');
});

test('tokenMetadataFromParsedMint reads the Token-2022 metadata extension', () => {
  const entry = {
    data: {
      parsed: {
        type: 'mint',
        info: { extensions: [{ extension: 'metadataPointer' }, { extension: 'tokenMetadata', state: { name: 'Pump Coin', symbol: 'PUMP', uri: 'x' } }] },
      },
    },
  };
  assert.deepEqual(tokenMetadataFromParsedMint(entry), { name: 'Pump Coin', symbol: 'PUMP' });
  assert.equal(tokenMetadataFromParsedMint({ data: { parsed: { info: {} } } }), null);
  assert.equal(tokenMetadataFromParsedMint(null), null);
});

test('fetchTokenNames combines Token-2022 extensions and Metaplex metadata', async () => {
  const splMint = randomAddress();
  const t22Mint = randomAddress();
  const unknownMint = randomAddress();
  const pda = await metadataAddress(splMint);
  const calls = [];
  const rpc = {
    async getMultipleAccounts(addresses, encoding) {
      calls.push({ addresses, encoding });
      return addresses.map((a) => {
        if (encoding === 'jsonParsed' && a === t22Mint) {
          return { data: { parsed: { info: { extensions: [{ extension: 'tokenMetadata', state: { name: 'Neu', symbol: 'NEU' } }] } } } };
        }
        if (encoding === 'base64' && a === pda) {
          return { data: [toBase64(metadataBytes({ name: 'Alt', symbol: 'ALT', uri: '' })), 'base64'] };
        }
        return null;
      });
    },
  };
  const accounts = [
    { mint: splMint, programId: TOKEN },
    { mint: t22Mint, programId: TOKEN_2022 },
    { mint: unknownMint, programId: TOKEN },
    { mint: splMint, programId: TOKEN },
  ];
  const names = await fetchTokenNames({ rpc, accounts });
  assert.deepEqual(names.get(splMint), { name: 'Alt', symbol: 'ALT' });
  assert.deepEqual(names.get(t22Mint), { name: 'Neu', symbol: 'NEU' });
  assert.equal(names.has(unknownMint), false);
  assert.equal(calls.filter((c) => c.encoding === 'jsonParsed').length, 1);
});

test('fetchTokenNames survives RPC failures', async () => {
  const rpc = { getMultipleAccounts: async () => { throw new Error('down'); } };
  const names = await fetchTokenNames({ rpc, accounts: [{ mint: randomAddress(), programId: TOKEN }] });
  assert.equal(names.size, 0);
});

test('fetchUsdPrices asks Jupiter in chunks of 50 and ignores bad values', async () => {
  const mints = Array.from({ length: 120 }, () => randomAddress());
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const ids = new URL(url).searchParams.get('ids').split(',');
    const body = Object.fromEntries(ids.map((id, i) => [id, { usdPrice: i === 0 ? 'kaputt' : 0.5 }]));
    return { ok: true, json: async () => body };
  };
  const prices = await fetchUsdPrices({ mints, fetchImpl });
  assert.equal(urls.length, 3);
  assert.ok(urls.every((u) => u.startsWith('https://api.jup.ag/price/v3?ids=')));
  assert.equal(prices.size, 117);
  assert.equal(prices.get(mints[1]), 0.5);
});

test('fetchUsdPrices returns what it has when Jupiter fails', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const prices = await fetchUsdPrices({ mints: [randomAddress()], fetchImpl });
  assert.equal(prices.size, 0);
  const prices2 = await fetchUsdPrices({ mints: [], fetchImpl });
  assert.equal(prices2.size, 0);
});
