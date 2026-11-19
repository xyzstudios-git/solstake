import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { watchWallets, isUsableWallet, connectWallet, createSigner, SOLANA_MAINNET } from '../site/lib/wallet.js';
import { formatSol, formatSolNumber, formatTokenAmount, shortAddress, formatUsd, monogram, tokenValueUsd } from '../site/lib/format.js';
import { encodeBase58 } from '../site/lib/base58.js';

function fakeWallet(name, { chains = [SOLANA_MAINNET], sign = true, signAndSend = false } = {}) {
  const key = Keypair.generate().publicKey;
  const account = { address: key.toBase58(), publicKey: key.toBytes(), chains, features: [...(sign ? ['solana:signTransaction'] : []), ...(signAndSend ? ['solana:signAndSendTransaction'] : [])] };
  const seen = [];
  const features = {
    'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
    'standard:disconnect': { version: '1.0.0', disconnect: async () => {} },
    'standard:events': { version: '1.0.0', on: () => () => {} },
  };
  if (sign) {
    features['solana:signTransaction'] = {
      version: '1.0.0',
      supportedTransactionVersions: ['legacy', 0],
      signTransaction: async (...inputs) => {
        seen.push(...inputs);
        return inputs.map((i) => ({ signedTransaction: Uint8Array.of(...i.transaction, 7) }));
      },
    };
  }
  if (signAndSend) {
    features['solana:signAndSendTransaction'] = {
      version: '1.0.0',
      supportedTransactionVersions: ['legacy'],
      signAndSendTransaction: async (...inputs) => {
        seen.push(...inputs);
        return inputs.map(() => ({ signature: new Uint8Array(64).fill(1) }));
      },
    };
  }
  const wallet = { version: '1.0.0', name, icon: 'data:image/svg+xml;base64,AAAA', chains, accounts: [], features, seen, account };
  features['standard:connect'].connect = async () => { wallet.accounts = [account]; return { accounts: wallet.accounts }; };
  return wallet;
}

test('finds wallets that registered before and after the app', () => {
  const win = new EventTarget();
  const early = fakeWallet('Früh');
  win.addEventListener('wallet-standard:app-ready', (event) => event.detail.register(early));
  const seen = [];
  const stop = watchWallets(win, (list) => seen.push(list.map((w) => w.name)));
  assert.deepEqual(seen.at(-1), ['Früh']);

  const late = fakeWallet('Spät');
  win.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: (api) => api.register(late) }));
  assert.deepEqual(seen.at(-1), ['Früh', 'Spät']);

  win.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: (api) => api.register(late) }));
  assert.deepEqual(seen.at(-1), ['Früh', 'Spät']);

  const ethOnly = fakeWallet('Nur Ethereum', { chains: ['eip155:1'] });
  win.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: (api) => api.register(ethOnly) }));
  assert.deepEqual(seen.at(-1), ['Früh', 'Spät']);

  stop();
  win.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: (api) => api.register(fakeWallet('Danach')) }));
  assert.deepEqual(seen.at(-1), ['Früh', 'Spät']);
});

test('keeps two different wallets even if they share a name', () => {
  const win = new EventTarget();
  const seen = [];
  watchWallets(win, (list) => seen.push(list.length));
  for (const w of [fakeWallet('Phantom'), fakeWallet('Phantom')]) {
    win.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: (api) => api.register(w) }));
  }
  assert.equal(seen.at(-1), 2);
});

test('isUsableWallet needs mainnet, connect and a signing feature', () => {
  assert.equal(isUsableWallet(fakeWallet('a')), true);
  assert.equal(isUsableWallet(fakeWallet('b', { sign: false, signAndSend: true })), true);
  assert.equal(isUsableWallet(fakeWallet('c', { sign: false })), false);
  assert.equal(isUsableWallet({}), false);
  assert.equal(isUsableWallet(null), false);
});

test('connectWallet returns the first account; createSigner uses signTransaction', async () => {
  const wallet = fakeWallet('Phantom');
  const account = await connectWallet(wallet);
  assert.equal(account.address, wallet.account.address);
  const signer = createSigner(wallet, account);
  assert.equal(signer.mode, 'sign');
  const out = await signer.signTransactions([Uint8Array.of(1, 2), Uint8Array.of(3)]);
  assert.deepEqual(out, [Uint8Array.of(1, 2, 7), Uint8Array.of(3, 7)]);
  assert.deepEqual(wallet.seen.map((i) => i.chain), [SOLANA_MAINNET, SOLANA_MAINNET]);
  assert.equal(wallet.seen[0].account, account);
});

test('createSigner falls back to signAndSendTransaction', async () => {
  const wallet = fakeWallet('Nur Senden', { sign: false, signAndSend: true });
  const account = await connectWallet(wallet);
  const signer = createSigner(wallet, account);
  assert.equal(signer.mode, 'signAndSend');
  assert.equal(await signer.signAndSend(Uint8Array.of(1)), encodeBase58(new Uint8Array(64).fill(1)));
  assert.equal(wallet.seen[0].chain, SOLANA_MAINNET);
});

test('connectWallet fails clearly without accounts', async () => {
  const wallet = fakeWallet('Leer');
  wallet.features['standard:connect'].connect = async () => ({ accounts: [] });
  await assert.rejects(connectWallet(wallet), /account/);
});

test('formats SOL, exact token amounts, addresses and USD for English readers', () => {
  assert.equal(formatSol(2039280), '0.002039 SOL');
  assert.equal(formatSol(1_019_640_000), '1.01964 SOL');
  assert.equal(formatSol(0), '0.00 SOL');
  assert.equal(formatSolNumber(2039280), '0.002039');
  assert.equal(formatSolNumber(12_305_000), '0.012305');
  assert.equal(formatTokenAmount(123456789n, 6), '123.456789');
  assert.equal(formatTokenAmount(1_000_000_000_000n, 6), '1,000,000');
  assert.equal(formatTokenAmount(5n, 9), '< 0.000001');
  assert.equal(formatTokenAmount(0n, 6), '0');
  assert.equal(formatTokenAmount(18446744073709551615n, 0), '18,446,744,073,709,551,615');
  assert.equal(shortAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), 'Toke…Q5DA');
  assert.equal(formatUsd(0.0213), '$0.02');
  assert.equal(formatUsd(1234.5), '$1,234.50');
  assert.equal(formatUsd(0.0004), '<$0.01');
  assert.equal(formatUsd(null), '');
  assert.equal(monogram('Bonk'), 'BO');
  assert.equal(monogram('  $wif'), 'WI');
  assert.equal(monogram(''), '?');
  assert.equal(tokenValueUsd(1_500_000n, 6, 2), 3);
  assert.equal(tokenValueUsd(1n, 6, undefined), null);
});


test('signing uses the methods authorized for this account, not just advertised by the wallet', async () => {
  const wallet = fakeWallet('Restricted methods', { sign: true, signAndSend: true });
  wallet.account.features = ['solana:signAndSendTransaction'];
  const account = await connectWallet(wallet);
  const signer = createSigner(wallet, account);
  assert.equal(signer.mode, 'signAndSend');
  await signer.signAndSend(Uint8Array.of(1));
  assert.equal(wallet.seen.length, 1);
});

test('an explicit empty connection result cannot reuse previously authorized accounts', async () => {
  const wallet = fakeWallet('Revoked connection');
  wallet.accounts = [wallet.account];
  wallet.features['standard:connect'].connect = async () => ({ accounts: [] });
  await assert.rejects(connectWallet(wallet), /account/i);
});

test('accounts without signing permission cannot create a signer', async () => {
  const wallet = fakeWallet('Watch only');
  wallet.account.features = [];
  assert.throws(() => createSigner(wallet, wallet.account), /authoriz|reconnect/i);
  await assert.rejects(connectWallet(wallet), /authoriz|reconnect/i);
  assert.equal(wallet.seen.length, 0);
});

test('a renewed authorization for the same address uses the current account object', async () => {
  const wallet = fakeWallet('Renewed authorization');
  const account = await connectWallet(wallet);
  const signer = createSigner(wallet, account);
  const current = { ...account };
  wallet.accounts = [current];
  wallet.features['solana:signTransaction'].signTransaction = async (...inputs) => {
    assert.ok(inputs.every((input) => input.account === current), 'the provider requires its current authorized account object');
    return inputs.map((input) => ({ signedTransaction: input.transaction }));
  };
  assert.deepEqual(await signer.signTransactions([Uint8Array.of(1)]), [Uint8Array.of(1)]);
});

test('revoked accounts and changed owners stop before any wallet request', async () => {
  const wallet = fakeWallet('Removed account');
  const account = await connectWallet(wallet);
  const signer = createSigner(wallet, account);
  wallet.accounts = [];
  await assert.rejects(signer.signTransactions([Uint8Array.of(1)]), /authoriz|reconnect/i);
  wallet.accounts = [fakeWallet('Other owner').account];
  await assert.rejects(signer.signTransactions([Uint8Array.of(1)]), /authoriz|reconnect/i);
  assert.equal(wallet.seen.length, 0);
});

test('account method revocation also stops sign-and-send before it can broadcast', async () => {
  const wallet = fakeWallet('Permission removed', { sign: false, signAndSend: true });
  const account = await connectWallet(wallet);
  const signer = createSigner(wallet, account);
  wallet.accounts = [{ ...account, features: [] }];
  await assert.rejects(signer.signAndSend(Uint8Array.of(1)), /authoriz|reconnect/i);
  assert.equal(wallet.seen.length, 0);
});

test('a provider authorization error never retries, reconnects or changes the signing method automatically', async () => {
  const wallet = fakeWallet('Unauthorized', { sign: true, signAndSend: true });
  const account = await connectWallet(wallet);
  const error = Object.assign(new Error('The requested method and/or account has not been authorized by the user.'), { code: 4100 });
  let calls = 0;
  wallet.features['standard:connect'].connect = async () => { throw new Error('Unexpected automatic reconnect'); };
  wallet.features['solana:signTransaction'].signTransaction = async () => { calls++; throw error; };
  await assert.rejects(createSigner(wallet, account).signTransactions([Uint8Array.of(1)]), (received) => received === error);
  assert.equal(calls, 1);
  assert.equal(wallet.seen.length, 0);
});
