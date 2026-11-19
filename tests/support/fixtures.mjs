// Gemeinsame Testdaten: Token-Konten in der Form, die getTokenAccountsByOwner (jsonParsed) liefert.
import { Keypair } from '@solana/web3.js';

export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const WSOL = 'So11111111111111111111111111111111111111112';

export const randomAddress = () => Keypair.generate().publicKey.toBase58();

export function tokenEntry({
  pubkey = randomAddress(),
  owner,
  mint = randomAddress(),
  amount = '0',
  decimals = 6,
  state = 'initialized',
  programId = TOKEN,
  lamports = 2039280,
  isNative = false,
  closeAuthority,
  extensions,
}) {
  const info = {
    isNative,
    mint,
    owner,
    state,
    tokenAmount: {
      amount,
      decimals,
      uiAmount: Number(amount) / 10 ** decimals,
      uiAmountString: String(Number(amount) / 10 ** decimals),
    },
  };
  if (closeAuthority) info.closeAuthority = closeAuthority;
  if (extensions) info.extensions = extensions;
  const program = programId === TOKEN_2022 ? 'spl-token-2022' : 'spl-token';
  return {
    pubkey,
    account: {
      lamports,
      owner: programId,
      executable: false,
      rentEpoch: 18446744073709552000,
      space: 165,
      data: { program, parsed: { type: 'account', info }, space: 165 },
    },
  };
}
