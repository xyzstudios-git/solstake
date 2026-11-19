#!/usr/bin/env node
// Prüft Leerguts Anweisungen gegen die echten Mainnet-Programme, nur per Simulation
// (sigVerify aus, nichts wird gesendet, nichts ändert sich).
//
//   node tools/mainnet-sim-check.mjs [BESITZER] [ZAHLER]
//
// BESITZER: Adresse mit Token-Konten. ZAHLER: beliebiges gedecktes System-Konto als Gebührenzahler;
// so lassen sich auch Adressen prüfen, die selbst keine Gebühren zahlen können.
import { createRpc } from '../site/lib/rpc.js';
import { classifyAll } from '../site/lib/accounts.js';
import { closeAccountIx, burnCheckedIx, setComputeUnitLimitIx, setComputeUnitPriceIx } from '../site/lib/instructions.js';
import { buildUnsignedTransaction } from '../site/lib/tx.js';
import { toBase64 } from '../site/lib/bytes.js';
import { isAddress } from '../site/lib/base58.js';

const owner = process.argv[2];
const feePayer = process.argv[3];
const RPC_URL = process.env.SOLSTAKE_RPC_URL ?? process.env.SOLFUND_RPC_URL ?? process.env.LEERGUT_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const PLACEHOLDER = '11111111111111111111111111111111';

if (!isAddress(owner) || !isAddress(feePayer)) {
  process.stderr.write('Usage: npm run simulate:mainnet -- <OWNER_ADDRESS> <FEE_PAYER_ADDRESS>\nBoth must be valid public Solana addresses. No transaction will be sent.\n');
  process.exit(2);
}

const rpc = createRpc({ url: RPC_URL });
const out = (line) => process.stdout.write(`${line}\n`);

function instructionsFor(acc) {
  const close = closeAccountIx({ programId: acc.programId, account: acc.address, destination: feePayer, owner });
  if (acc.action === 'close') return [close];
  return [burnCheckedIx({ programId: acc.programId, account: acc.address, mint: acc.mint, owner, amount: acc.amount, decimals: acc.decimals }), close];
}

async function simulate(label, accounts) {
  const instructions = [setComputeUnitLimitIx(1_400_000), setComputeUnitPriceIx(10_000), ...accounts.flatMap(instructionsFor)];
  const { bytes, size } = buildUnsignedTransaction({ feePayer, recentBlockhash: PLACEHOLDER, instructions });
  const result = await rpc.simulate(toBase64(bytes));
  const verdict = result.err ? `ERROR ${JSON.stringify(result.err)}` : 'ok';
  out(`${label}: ${accounts.length} accounts, ${size} bytes, ${result.unitsConsumed} CU → ${verdict}`);
  if (result.err) for (const line of result.logs.slice(-4)) out(`    ${line}`);
  return !result.err;
}

const entries = await rpc.getTokenAccounts(owner);
const accounts = classifyAll(entries, owner);
const closable = accounts.filter((acc) => acc.action === 'close');
const burnable = accounts.filter((acc) => acc.action === 'burn');
out(`Owner ${owner}: ${accounts.length} token accounts, ${closable.length} empty, ${burnable.length} holding tokens.`);

let allOk = true;
for (const acc of [...closable, ...burnable]) {
  const kind = `${acc.action === 'close' ? 'close' : 'burn+close'} ${acc.isToken2022 ? 'Token-2022' : 'SPL'}`;
  allOk = (await simulate(`Individual ${kind} ${acc.address.slice(0, 6)}…`, [acc])) && allOk;
}
if (closable.length + burnable.length > 1) {
  allOk = (await simulate('All in one transaction', [...closable, ...burnable])) && allOk;
}
out(allOk ? 'Result: all simulations succeeded.' : 'Result: at least one simulation failed.');
process.exit(allOk ? 0 : 1);
