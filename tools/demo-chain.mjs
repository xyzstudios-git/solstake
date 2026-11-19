#!/usr/bin/env node
// Lokale Test-Chain für Oberflächentests: LiteSVM mit den echten Token-Programmen hinter einer
// JSON-RPC-Schnittstelle, dazu Solstake selbst, das darauf zeigt. Kein echtes Geld, kein Mainnet.
//
//   node tools/demo-chain.mjs          → Test-Chain auf 127.0.0.1:8899, Solstake auf http://127.0.0.1:8791
//
// Signaturen prüft die Test-Chain nicht (sigverify aus); so kann eine eingeschleuste Test-Wallet
// im Browser „unterschreiben“. Echte Signaturen prüfen die LiteSVM-Tests in tests/.
import http from 'node:http';
import { LiteSVM, FailedTransactionMetadata } from 'litesvm';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { MintLayout, AccountLayout, MINT_SIZE, ACCOUNT_SIZE, TOKEN_PROGRAM_ID as SPL, TOKEN_2022_PROGRAM_ID as T22, ExtensionType, getAccountLen } from '@solana/spl-token';
import { startServer } from '../serve.mjs';
import { encodeBase58 } from '../site/lib/base58.js';
import { fromBase64, toBase64 } from '../site/lib/bytes.js';
import { metadataAddress, METADATA_PROGRAM_ID } from '../site/lib/pda.js';

const CHAIN_PORT = Number(process.env.DEMO_CHAIN_PORT ?? 8899);
const APP_PORT = Number(process.env.DEMO_APP_PORT ?? 8791);

const svm = new LiteSVM().withSigverify(false);
const owner = Keypair.generate();
svm.airdrop(owner.publicKey, 50_000_000n); // 0,05 SOL für Gebühren
const rent = (len) => Number(svm.minimumBalanceForRentExemption(BigInt(len)));
const mints = new Map(); // Mint → { decimals, programId }
const tokenAccounts = []; // Adressen, die wir als Token-Konten angelegt haben

function put(address, programId, data) {
  svm.setAccount(address, { lamports: rent(data.length), data: new Uint8Array(data), owner: programId, executable: false });
}

function borshString(text) {
  const raw = Buffer.from(text, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(raw.length);
  return Buffer.concat([len, raw]);
}

async function createMint({ programId, decimals, supply, name, symbol }) {
  const mint = Keypair.generate().publicKey;
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 1, mintAuthority: owner.publicKey, supply, decimals, isInitialized: true, freezeAuthorityOption: 1, freezeAuthority: owner.publicKey }, data);
  put(mint, programId, data);
  mints.set(mint.toBase58(), { decimals, programId });
  if (name) {
    const meta = Buffer.concat([Buffer.from([4]), owner.publicKey.toBuffer(), mint.toBuffer(), borshString(name), borshString(symbol), borshString(''), Buffer.from([0, 0, 0, 1, 1])]);
    put(new PublicKey(await metadataAddress(mint.toBase58())), new PublicKey(METADATA_PROGRAM_ID), meta);
  }
  return mint;
}

function createTokenAccount({ mint, amount, frozen = false }) {
  const { programId } = mints.get(mint.toBase58());
  const base = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({ mint, owner: owner.publicKey, amount, delegateOption: 0, delegate: PublicKey.default, state: frozen ? 2 : 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, base);
  let data = base;
  if (programId.equals(T22)) {
    data = Buffer.alloc(getAccountLen([ExtensionType.ImmutableOwner]));
    base.copy(data);
    data[ACCOUNT_SIZE] = 2;
    data.writeUInt16LE(ExtensionType.ImmutableOwner, ACCOUNT_SIZE + 1);
  }
  const address = Keypair.generate().publicKey;
  put(address, programId, data);
  tokenAccounts.push(address);
}

// Testbestand: leere Konten, Bestände, eingefroren, NFT
const bonk = await createMint({ programId: SPL, decimals: 5, supply: 10_000_000_000n, name: 'Demo Bonk', symbol: 'DBONK' });
const cat = await createMint({ programId: SPL, decimals: 6, supply: 5_000_000n, name: 'Katzengold', symbol: 'KGOLD' });
const pump = await createMint({ programId: T22, decimals: 6, supply: 42_000_000n });
const nft = await createMint({ programId: SPL, decimals: 0, supply: 1n, name: 'Demo NFT #1', symbol: 'DNFT' });
for (let i = 0; i < 3; i += 1) createTokenAccount({ mint: await createMint({ programId: SPL, decimals: 6, supply: 0n, name: `Altlast ${i + 1}`, symbol: `ALT${i + 1}` }), amount: 0n });
createTokenAccount({ mint: await createMint({ programId: T22, decimals: 9, supply: 0n }), amount: 0n });
createTokenAccount({ mint: bonk, amount: 9_000_000_000n });
createTokenAccount({ mint: cat, amount: 4_000_000n });
createTokenAccount({ mint: pump, amount: 42_000_000n });
createTokenAccount({ mint: cat, amount: 1_000_000n, frozen: true });
createTokenAccount({ mint: nft, amount: 1n });

function parsedTokenAccount(address) {
  const acc = svm.getAccount(address);
  if (!acc || acc.lamports === 0) return null;
  const info = AccountLayout.decode(Buffer.from(acc.data.slice(0, ACCOUNT_SIZE)));
  const { decimals, programId } = mints.get(info.mint.toBase58());
  const isT22 = programId.equals(T22);
  const amount = info.amount.toString();
  return {
    pubkey: address.toBase58(),
    account: {
      lamports: acc.lamports,
      owner: programId.toBase58(),
      executable: false,
      rentEpoch: 0,
      space: acc.data.length,
      data: {
        program: isT22 ? 'spl-token-2022' : 'spl-token',
        space: acc.data.length,
        parsed: {
          type: 'account',
          info: {
            isNative: false,
            mint: info.mint.toBase58(),
            owner: info.owner.toBase58(),
            state: info.state === 2 ? 'frozen' : 'initialized',
            tokenAmount: { amount, decimals, uiAmount: Number(amount) / 10 ** decimals, uiAmountString: String(Number(amount) / 10 ** decimals) },
            ...(isT22 ? { extensions: [{ extension: 'immutableOwner' }] } : {}),
          },
        },
      },
    },
  };
}

function rpcError(err) {
  if (typeof err?.index === 'number' && typeof err?.err === 'function') {
    const inner = err.err();
    return { InstructionError: [err.index, typeof inner?.code === 'number' ? { Custom: inner.code } : String(inner)] };
  }
  return String(err);
}

const statuses = new Map();
const context = () => ({ slot: 1 });
const methods = {
  getTokenAccountsByOwner([address, { programId }]) {
    const value = address === owner.publicKey.toBase58() ? tokenAccounts.map(parsedTokenAccount).filter((e) => e && e.account.owner === programId) : [];
    return { context: context(), value };
  },
  getBalance([address]) {
    return { context: context(), value: Number(svm.getBalance(new PublicKey(address)) ?? 0n) };
  },
  getMultipleAccounts([addresses, { encoding }]) {
    return {
      context: context(),
      value: addresses.map((a) => {
        const acc = svm.getAccount(new PublicKey(a));
        if (!acc || encoding !== 'base64') return null;
        return { lamports: acc.lamports, owner: acc.owner.toBase58(), executable: acc.executable, rentEpoch: 0, space: acc.data.length, data: [toBase64(acc.data), 'base64'] };
      }),
    };
  },
  getRecentPrioritizationFees: () => [],
  getLatestBlockhash: () => ({ context: context(), value: { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000_000 } }),
  getBlockHeight: () => 1,
  simulateTransaction([base64]) {
    const vtx = VersionedTransaction.deserialize(fromBase64(base64));
    vtx.message.recentBlockhash = svm.latestBlockhash();
    const r = svm.simulateTransaction(vtx);
    const meta = r instanceof FailedTransactionMetadata ? r.meta() : r.meta();
    return { context: context(), value: { err: r instanceof FailedTransactionMetadata ? rpcError(r.err()) : null, logs: meta.logs(), unitsConsumed: Number(meta.computeUnitsConsumed()) } };
  },
  sendTransaction([base64]) {
    const vtx = VersionedTransaction.deserialize(fromBase64(base64));
    const r = svm.sendTransaction(vtx);
    const signature = encodeBase58(vtx.signatures[0]);
    statuses.set(signature, { slot: 1, confirmations: 1, confirmationStatus: 'confirmed', err: r instanceof FailedTransactionMetadata ? rpcError(r.err()) : null });
    svm.expireBlockhash(); // nächste Transaktion bekommt einen frischen Blockhash, wie im echten Netz
    return signature;
  },
  getSignatureStatuses([signatures]) {
    return { context: context(), value: signatures.map((s) => statuses.get(s) ?? null) };
  },
};

const chain = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let reply;
    try {
      const { id, method, params } = JSON.parse(body);
      reply = methods[method] ? { jsonrpc: '2.0', id, result: methods[method](params) } : { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
    } catch (error) {
      reply = { jsonrpc: '2.0', id: null, error: { code: -32603, message: String(error?.message ?? error) } };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
});
await new Promise((resolve) => chain.listen(CHAIN_PORT, '127.0.0.1', resolve));
const app = await startServer({ port: APP_PORT, upstreamUrl: `http://127.0.0.1:${CHAIN_PORT}`, quiet: true });
process.stdout.write(`Test chain: http://127.0.0.1:${CHAIN_PORT}\nSolstake on the test chain: ${app.url}\nTest wallet: ${owner.publicKey.toBase58()}\n`);
