<p align="center"><img src="site/icon.svg" width="72" alt="Solstake logo"></p>

<h1 align="center">Solstake</h1>

<p align="center">Get your SOL back.</p>

<p align="center"><a href="#quick-start">Run locally</a> · <a href="design/README.md">Design & branding</a> · <a href="docs/ARCHITECTURE.md">Architecture</a> · <a href="docs/VERIFICATION.md">Verification</a></p>

Solstake is a Solana web app for reclaiming account rent, burning unwanted tokens, and claiming supported Pump.fun and PumpSwap cashback. It uses an English interface with locally bundled UI assets. Solstake adds no service fee; Solana network fees still apply.

This is a development project. Passing tests does not make it an audited or production-ready wallet application. See [verification and limits](docs/VERIFICATION.md).

The owner has authorized public hosting at [solfund.xyzstudios.de](https://solfund.xyzstudios.de) and public source publication. See the [deployment guide](docs/PUBLISHING.md) for setup and the verification record for tested boundaries.

## Features

- Scan SPL Token and Token-2022 accounts for a connected wallet, or inspect an address without connecting.
- Preview and simulate actions before requesting a wallet signature.
- Choose **Claim with Tip** (highlighted) or **Claim without Tip** directly in the review. The voluntary tip is 20% of the quoted recovered SOL before network fees; both options show their estimated net amount.
- Close eligible empty accounts and optionally burn selected token balances before closing their accounts.
- Detect supported Pump cashback and reclaim eligible reward-account rent. Accounts with pending token incentives, other token rewards, or unknown fields remain open.
- View locally recorded claims, cumulative charts, network fees, and net amounts for 7 days, 30 days, or all time.

NFT burning, Pump token-incentive claims, non-SOL cashback, and other protocol rewards are not implemented.

## Design included

The full English interface, editable SVG mark, local icon fonts, Apple-style component layer, responsive styles and Account charts are included. The existing typography and supplied logo are preserved. See the [design source map and visual rules](design/README.md).

## Quick start

Clone this repository, open its directory, and run:

```bash
./setup.sh
npm start
```

Open [http://127.0.0.1:8790](http://127.0.0.1:8790). Use a compatible Wallet Standard browser wallet, such as Phantom, Solflare, or Backpack. Wallet-specific and mobile compatibility still needs independent testing.

Node.js 24 or newer is required; Node.js 24 is recommended. npm is needed for the development dependencies and test suite. The app and local server themselves use no installed runtime packages or build step.

To run the server without installing test dependencies:

```bash
node serve.mjs
```

## Configuration

The default upstream is Solana's public mainnet RPC. Public RPC limits may prevent some account requests; a provider endpoint can be supplied through the environment. Keep RPC credentials on the server and out of browser files.

`npm start` loads `.env` if present. Use `SOLSTAKE_RPC_URL` for the upstream endpoint and `SOLSTAKE_PORT` for the local port. Previous `SOLFUND_*` and legacy `LEERGUT_*` names remain supported, in that order; the Solstake names take precedence. `node serve.mjs` uses exported environment variables directly. See [.env.example](.env.example) for example settings. See [AGENTS.md](AGENTS.md) for concise commands and [architecture](docs/ARCHITECTURE.md) for the request flow.

## How it works

1. Connect a wallet or choose **View an address**.
2. Review the selected accounts and rewards. Empty accounts and supported Pump claims are selected initially; token balances require an explicit selection.
3. Choose **Review selection**. Solstake simulates each batch and shows what would be burned, reclaimed, or skipped.
4. Choose either claim option, then approve the intended actions in the wallet. The optional tip is included in the same claim transaction and is never added to the no-tip option. Burning is permanent. The app monitors submitted signatures and links to the explorer.

The tip recipient is fixed in [`site/lib/tips.js`](site/lib/tips.js). Tips are rounded down to whole lamports per transaction. A failed transaction pays no tip, although Solana can still charge its network fee. Claims from the tip-receiving wallet do not send a self-tip. No tip preference is saved or applied automatically to later claims.

The **Account** button opens history recorded by this browser, separated by wallet. It starts with claims submitted through this feature; it does not import a wallet's complete transaction history. Known signatures are checked against the blockchain. Gross recovery, voluntary tips, network fees, and net amounts are kept separate. Amounts remain marked as estimates until transaction balances, fees, and the expected tip transfer are verified. Clearing browser storage removes this local record.

## Data and trust

The local server forwards a restricted set of RPC requests to the configured Solana endpoint. The browser also requests USD prices from Jupiter, which receives the requested mint addresses and the browser's IP address. Prices are informational and may be unavailable or stale.

Wallet private keys and recovery phrases are never requested by Solstake. The connected wallet signs transactions. A wallet's signing and sending capabilities affect which checks the app can perform; see [SECURITY.md](SECURITY.md). Browser history is not a complete financial ledger.

## Development

```bash
npm ci
npm run check
npm test
npm run test:coverage
```

Tests include instruction comparisons against the official Solana libraries, LiteSVM execution, the local HTTP/RPC proxy, history reconciliation, and a full app-entry-point flow with a synthetic DOM and test wallet. See [docs/VERIFICATION.md](docs/VERIFICATION.md) for what has and has not been verified.

The current development dependency audit has three known high-severity entries from one unpatched `bigint-buffer` dependency chain; the runtime-only audit is clean. Details and the tested compatibility override are recorded in [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md).

`tools/demo-chain.mjs` is a local test fixture. `tools/mainnet-sim-check.mjs` makes real RPC reads and simulations and is not part of the offline test suite. Neither tool is a production server.

## Hosting

The public deployment uses the dependency-free Cloudflare Worker in `worker/index.js`. `npm run build` embeds the original `site/` assets into `dist/server/index.js`; configure runtime values separately through the hosting secret store. The local `serve.mjs` continues to bind to loopback. GitHub Pages alone cannot run `/rpc`. See [deployment and rollback](docs/PUBLISHING.md) and [data handling](docs/PRIVACY.md).

## Using with Codex

[AGENTS.md](AGENTS.md) gives coding agents the actual commands, architecture, compatibility constraints, and transaction-safety boundaries. Start a Codex session in the repository and ask it to read that file before changing code.

## Contributing and licensing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Bundled third-party assets retain their own licenses in `site/vendor/`. Check the repository's license and asset notices before redistribution.

The [MIT text](docs/proposals/code-license.md) is a proposal only, not an active license grant. No code license has been selected; public source visibility does not grant general redistribution rights. See [third-party notices](THIRD_PARTY_NOTICES.md) and the [publishing guide](docs/PUBLISHING.md).
