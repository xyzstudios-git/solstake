# Solstake

**Version:** 0.1.0 | **Local port:** 8790 | **Stack:** HTML/CSS, JavaScript ES modules, Node.js HTTP server

## Purpose

Reclaim eligible Solana account rent, optionally burn unwanted tokens, and claim supported Pump cashback. Wallets sign; the app adds no service fee. This is a development project, not an audited wallet product.

## Quick start and commands

Use Node.js 24+; `.nvmrc` selects version 24.

```bash
./setup.sh             # Install development dependencies and run tests
npm start              # Local app and RPC proxy, 127.0.0.1:8790
npm ci                 # Reproduce dependencies from package-lock.json
npm run check          # JavaScript syntax checks
npm test               # Offline unit, server, LiteSVM, and entry-point tests
npm run test:coverage  # Node test coverage for site/lib
node serve.mjs         # Start without installing development dependencies
```

`npm run check` checks JavaScript syntax. No application build, transpiler, database, or Docker service is required. Do not invent lint/build commands that are absent from package.json.

## Architecture

```text
serve.mjs              Local static server and restricted /rpc proxy
site/index.html        App shell, SVG sprite, sheets and alerts
site/js/main.js        Wallet, scan, selection, review, execution, history state
site/js/views.js       Account selection, wallet menus, claim-flow views
site/js/account-view.js Account totals, chart, and local transaction history
site/js/dom.js         Text-safe DOM and modal helpers
site/lib/              Chain formats, classification, RPC, plans and verification
site/vendor/           Bundled UI/icon dependencies and their licenses
site/*.css             Brand, layout, and component overrides
site/icon.svg          Runtime brand asset
tests/                 Node tests and fixtures
tools/                 Explicit demo and mainnet-simulation tools
```

The browser reads chain data through `/rpc`; only `serve.mjs` receives the configured upstream endpoint. Jupiter price requests go directly from the browser. Plans are simulated before wallet approval, then signed/sent and monitored. History stores this app's submitted claims in local browser storage and checks known signatures; it does not import all wallet history.

## Key modules

- `site/lib/accounts.js`: supported account states, exclusions, and protected mints.
- `site/lib/pump-rewards.js`: fixed Pump/PumpSwap programs, reward detection, claim instructions.
- `site/lib/instructions.js`, `tx.js`, `batch.js`: instruction construction and serialization.
- `site/lib/fees.js`, `flow.js`: fee estimates, simulation, signing, sending, confirmation.
- `site/lib/tips.js`: fixed 20% voluntary-tip policy and recipient. Opt-in is explicit per claim; no-tip plans must never add a transfer.
- `site/lib/verify.js`: returned signed-transaction checks.
- `site/lib/history.js`, `history-sync.js`: local records, totals, and reconciliation.
- `tests/main-entrypoint.test.mjs`: complete app flow with synthetic DOM/wallet/RPC.
- `tests/litesvm.e2e.test.mjs`: token operations against local program execution.

## Configuration

`npm start` loads `.env` when present. `node serve.mjs` reads the exported environment directly. See `.env.example`.

| Variable | Purpose | Default |
| --- | --- | --- |
| `SOLSTAKE_PORT` | Local loopback HTTP port | `8790` |
| `SOLSTAKE_RPC_URL` | Server-side Solana RPC endpoint | Public mainnet RPC |
| `SOLFUND_PORT`, `SOLFUND_RPC_URL`, `LEERGUT_PORT`, `LEERGUT_RPC_URL` | Backward-compatible aliases | Used if corresponding Solstake variable is absent; Solfund aliases take precedence over Leergut |

Never put endpoint credentials in browser source or print their values.

## Working rules

- Read the existing code and focused tests before editing. Preserve other contributors' changes.
- Keep UI labels, accessible names, numbers, and dates in English; preserve the system font and Solstake branding.
- Treat token names, errors, and chain data as untrusted text. Do not use HTML interpolation.
- Preserve exact token amounts and validate safe lamport arithmetic.
- Do not change recipients, fees, account authorities, program IDs, allowlists, or signing checks as incidental cleanup.
- Both claim options must be simulated, show their net estimate, and preserve explicit burn warnings. An unavailable tip option must not block a valid no-tip claim. History gross equals actual net plus network fees plus the verified tip, and failed transactions pay no tip.
- Legacy `solburn:history:v1:` storage keys and `solburn-pump-unwrap-v1` seeds are compatibility identifiers. A rename needs separate migration/design review.
- Add meaningful regression tests for logic changes; use focused verification for cosmetic changes.
- Request code review for changes to transaction, RPC, authority, and sensitive-data handling.
- Use mocks or LiteSVM for automated checks. Never sign or send real-wallet transactions as part of testing.
- `tools/mainnet-sim-check.mjs` performs external reads/simulations; run it only for an explicit network-check task, never in default CI.
- Public hosting needs a separately reviewed server-side RPC deployment; `site/` alone does not work on GitHub Pages.
- Report what was actually verified. Synthetic DOM tests do not prove browser layout; local tests do not prove Linux CI, live-wallet, or public-release readiness.

See `CONTRIBUTING.md`, `SECURITY.md`, `docs/ARCHITECTURE.md`, and `docs/VERIFICATION.md`.

The GitHub repository is `xyzstudios-git/solstake` and is private. The source and design assets have been uploaded. Public visibility and deployment still require a separate explicit go.
