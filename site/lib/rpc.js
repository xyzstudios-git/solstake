// JSON-RPC-Zugang zu Solana. Standard ist der lokale Proxy /rpc (siehe serve.mjs):
// öffentliche RPCs lehnen Kontoabfragen aus dem Browser ab, und Schlüssel bleiben so auf dem Server.
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from './instructions.js';

export const DEFAULT_RPC_URL = '/rpc';

export class RpcError extends Error {
  constructor(message, { method, code, status, data } = {}) {
    super(message);
    this.name = 'RpcError';
    this.method = method;
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

function httpMessage(status) {
  if (status === 429) return 'Too many requests to the Solana RPC. Wait a moment and try again.';
  if (status === 401 || status === 403) return 'The Solana RPC blocked the request. Check your RPC provider.';
  if (status >= 500) return 'The Solana RPC is having trouble. Try again shortly.';
  return `The Solana RPC returned HTTP ${status}.`;
}

function unexpected(method) {
  return new RpcError(`Unexpected response to ${method}.`, { method });
}

/**
 * @param {{ url?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
export function createRpc({ url = DEFAULT_RPC_URL, fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 30_000 } = {}) {
  let nextId = 0;

  async function call(method, params) {
    nextId += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new RpcError(httpMessage(response.status), { method, status: response.status });
      let body;
      try {
        body = await response.json();
      } catch {
        throw new RpcError(`Unreadable response to ${method}.`, { method });
      }
      if (body?.error) {
        throw new RpcError(`${method}: ${body.error.message ?? 'Error'}`, { method, code: body.error.code, data: body.error.data });
      }
      if (!body || !('result' in body)) throw unexpected(method);
      return body.result;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (error?.name === 'AbortError') throw new RpcError(`Request timed out for ${method}: the Solana RPC is not responding.`, { method });
      throw new RpcError(`Solana RPC is unreachable (${method}). Check your connection.`, { method });
    } finally {
      clearTimeout(timer);
    }
  }

  const list = (value, method) => {
    if (!Array.isArray(value)) throw unexpected(method);
    return value;
  };

  return {
    call,

    /** Alle Token-Konten der Adresse aus beiden Token-Programmen. */
    async getTokenAccounts(owner) {
      const method = 'getTokenAccountsByOwner';
      const results = await Promise.all(
        [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
          call(method, [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
        ),
      );
      return results.flatMap((result) => list(result?.value, method));
    },

    async getMultipleAccounts(addresses, encoding = 'base64') {
      const result = await call('getMultipleAccounts', [addresses, { encoding, commitment: 'confirmed' }]);
      return list(result?.value, 'getMultipleAccounts');
    },

    async getBalance(address) {
      const result = await call('getBalance', [address, { commitment: 'confirmed' }]);
      if (!Number.isSafeInteger(result?.value)) throw unexpected('getBalance');
      return result.value;
    },

    async getMinimumBalanceForRentExemption(size) {
      if (!Number.isInteger(size) || size < 0 || size > 10 * 1024 * 1024) throw new RangeError('Invalid account size');
      const method = 'getMinimumBalanceForRentExemption';
      const result = await call(method, [size, { commitment: 'confirmed' }]);
      if (!Number.isSafeInteger(result) || result < 0) throw unexpected(method);
      return result;
    },

    async getLatestBlockhash() {
      const result = await call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const value = result?.value;
      if (typeof value?.blockhash !== 'string' || !Number.isSafeInteger(value?.lastValidBlockHeight)) throw unexpected('getLatestBlockhash');
      return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
    },

    async getBlockHeight() {
      const result = await call('getBlockHeight', [{ commitment: 'confirmed' }]);
      if (!Number.isSafeInteger(result)) throw unexpected('getBlockHeight');
      return result;
    },

    async getRecentPrioritizationFees() {
      return list(await call('getRecentPrioritizationFees', [[]]), 'getRecentPrioritizationFees');
    },

    /** Simuliert ohne Signatur mit frischem Blockhash; ändert nichts auf der Chain. */
    async simulate(base64) {
      const result = await call('simulateTransaction', [
        base64,
        { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' },
      ]);
      const value = result?.value;
      if (!value || typeof value !== 'object') throw unexpected('simulateTransaction');
      return {
        err: value.err ?? null,
        logs: Array.isArray(value.logs) ? value.logs : [],
        unitsConsumed: Number.isFinite(value.unitsConsumed) ? value.unitsConsumed : 0,
      };
    },

    async send(base64, { skipPreflight = false } = {}) {
      const signature = await call('sendTransaction', [
        base64,
        { encoding: 'base64', skipPreflight, preflightCommitment: 'confirmed' },
      ]);
      if (typeof signature !== 'string') throw unexpected('sendTransaction');
      return signature;
    },

    async getSignatureStatuses(signatures, { searchTransactionHistory = false } = {}) {
      const result = await call('getSignatureStatuses', [signatures, { searchTransactionHistory }]);
      return list(result?.value, 'getSignatureStatuses');
    },

    async getTransaction(signature) {
      return call('getTransaction', [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
    },
  };
}
