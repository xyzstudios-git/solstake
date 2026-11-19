import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Connection, PublicKey } from '@solana/web3.js';

// The legacy SDK is retained for independent instruction/transaction comparisons.
// Its jayson override must preserve the browser RPC client interface it imports.
test('the legacy SDK RPC transport works with the pinned jayson override', async () => {
  const requests = [];
  const connection = new Connection('https://rpc.example.test/', {
    commitment: 'confirmed',
    fetch: async (url, options) => {
      assert.equal(url, 'https://rpc.example.test/');
      const request = JSON.parse(options.body);
      requests.push(request);
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: request.id,
        result: { context: { slot: 1 }, value: 1_234 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(await connection.getBalance(PublicKey.default), 1_234);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'getBalance');
  assert.deepEqual(requests[0].params, [PublicKey.default.toBase58(), { commitment: 'confirmed' }]);
});
