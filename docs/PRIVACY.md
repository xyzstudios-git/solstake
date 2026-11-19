# Data handling

Solstake asks a compatible wallet for its public address and requested signing capabilities. It does not request a recovery phrase or private key. Viewing an address performs read-only blockchain requests without connecting a wallet.

The configured Solana RPC receives queried public addresses, account identifiers, simulations and any signed transactions submitted through `/rpc`. Solana transactions and resulting balances are public on the blockchain. The browser requests token prices from Jupiter. Explorer links open Solscan when selected.

The site is delivered through Sites and Cloudflare. Hosting infrastructure processes request metadata, including network addresses, for delivery and abuse protection. Cloudflare may set its infrastructure security cookie. The app adds no advertising or analytics trackers and keeps no hosted wallet-history database.

Claim history stays in this browser's local storage, separated by wallet. Clearing browser storage removes those local records. Reconciliation checks known public signatures; it does not import all wallet activity. Wallet permissions are managed in the wallet itself.

The proxy uses bounded, short-lived in-memory IP buckets for per-isolate abuse limits. Provider endpoint credentials and diagnostic response bodies are not returned to visitors. Review hosting and RPC providers' policies for their infrastructure logging and retention.
