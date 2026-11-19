// Wallets über den „Wallet Standard“ finden (Phantom, Solflare, Backpack …) und unterschreiben lassen.
// Die privaten Schlüssel verlassen die Wallet nie; Leergut bekommt nur unterschriebene Transaktionen zurück.
import { encodeBase58, isAddress } from './base58.js';

export const SOLANA_MAINNET = 'solana:mainnet';
const CONNECT = 'standard:connect';
const DISCONNECT = 'standard:disconnect';
const EVENTS = 'standard:events';
const SIGN = 'solana:signTransaction';
const SIGN_AND_SEND = 'solana:signAndSendTransaction';

const supportsLegacy = (feature) =>
  !Array.isArray(feature?.supportedTransactionVersions) || feature.supportedTransactionVersions.includes('legacy');

export function isUsableWallet(wallet) {
  if (!wallet || typeof wallet !== 'object') return false;
  const features = wallet.features ?? {};
  const canSign =
    (typeof features[SIGN]?.signTransaction === 'function' && supportsLegacy(features[SIGN])) ||
    (typeof features[SIGN_AND_SEND]?.signAndSendTransaction === 'function' && supportsLegacy(features[SIGN_AND_SEND]));
  return Array.isArray(wallet.chains) && wallet.chains.includes(SOLANA_MAINNET) && typeof features[CONNECT]?.connect === 'function' && canSign;
}

/**
 * Meldet jede passende Wallet, egal ob sie vor oder nach der Seite geladen wurde.
 * @param {EventTarget} win  normalerweise window
 * @param {(wallets: object[]) => void} onChange
 * @returns {() => void} beendet das Zuhören
 */
export function watchWallets(win, onChange) {
  let wallets = [];
  let active = true;
  const notify = () => onChange([...wallets]);
  const register = (...candidates) => {
    if (!active) return () => {};
    // Nur gleiche Objekte zusammenfassen: sonst könnte eine Erweiterung mit falschem Namen die echte verdrängen
    const added = candidates.filter((w) => isUsableWallet(w) && !wallets.includes(w));
    if (added.length > 0) {
      wallets = [...wallets, ...added];
      notify();
    }
    return () => {
      wallets = wallets.filter((w) => !added.includes(w));
      notify();
    };
  };
  const api = Object.freeze({ register });
  const onRegister = (event) => {
    if (typeof event?.detail !== 'function') return;
    try {
      event.detail(api);
    } catch (error) {
      console.error('Solstake: wallet registration failed', error);
    }
  };
  win.addEventListener('wallet-standard:register-wallet', onRegister);
  win.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  notify();
  return () => {
    active = false;
    win.removeEventListener('wallet-standard:register-wallet', onRegister);
  };
}

/** Fragt die Wallet nach Freigabe und liefert das Solana-Konto. */
export async function connectWallet(wallet) {
  const result = await wallet.features[CONNECT].connect();
  const accounts = result?.accounts?.length ? result.accounts : wallet.accounts;
  const account = accounts?.find((a) => a?.chains?.includes?.(SOLANA_MAINNET)) ?? accounts?.[0];
  if (!account || !isAddress(account.address)) throw new Error('The wallet did not share a Solana account.');
  return account;
}

export async function disconnectWallet(wallet) {
  await wallet?.features?.[DISCONNECT]?.disconnect?.();
}

/** Ruft `listener` auf, wenn in der Wallet das Konto gewechselt wird. Gibt eine Abmeldefunktion zurück. */
export function onWalletChange(wallet, listener) {
  const off = wallet?.features?.[EVENTS]?.on?.('change', listener);
  return typeof off === 'function' ? off : () => {};
}

/**
 * Unterschreiben über die Wallet. Bevorzugt „signTransaction“ (eine Freigabe für mehrere
 * Transaktionen); sonst „signAndSendTransaction“ (die Wallet sendet selbst).
 */
export function createSigner(wallet, account) {
  const sign = wallet.features[SIGN];
  if (typeof sign?.signTransaction === 'function' && supportsLegacy(sign)) {
    return {
      mode: 'sign',
      async signTransactions(list) {
        const outputs = await sign.signTransaction(...list.map((transaction) => ({ account, transaction, chain: SOLANA_MAINNET })));
        return outputs.map((output) => {
          if (!(output?.signedTransaction instanceof Uint8Array)) throw new Error('The wallet did not return a transaction.');
          return output.signedTransaction;
        });
      },
    };
  }
  const send = wallet.features[SIGN_AND_SEND];
  if (typeof send?.signAndSendTransaction === 'function' && supportsLegacy(send)) {
    return {
      mode: 'signAndSend',
      async signAndSend(transaction) {
        const [output] = await send.signAndSendTransaction({
          account,
          transaction,
          chain: SOLANA_MAINNET,
          options: { preflightCommitment: 'confirmed' },
        });
        if (!(output?.signature instanceof Uint8Array)) throw new Error('The wallet did not return a signature.');
        return encodeBase58(output.signature);
      },
    };
  }
  throw new Error('This wallet cannot sign transactions.');
}
