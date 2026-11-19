# Architecture

## Runtime and requests

Solfund has two runtime parts: static browser ES modules under `site/` and the Node.js HTTP server in `serve.mjs`. There is no bundler, database, application package dependency, or build output to generate. Test and demo tooling uses development dependencies from the lockfile.

```text
Browser UI ── same-origin /rpc ── local Node server ── configured Solana RPC
    │
    ├── Wallet Standard wallet ── signature approval / wallet-owned sending
    ├── Jupiter price API ── informational USD estimates
    ├── browser localStorage ── this app's per-wallet claim history
    └── Solscan links ── opened only when selected
```

The server normally listens on `127.0.0.1:8790`. Its allowed host/origin set comes from that local port. The upstream URL may contain a provider credential and stays on the server. Static files are confined to `site/`.

The `/rpc` proxy permits specific methods with parameter checks: token-account and balance reads, rent lookup, blockhash/block-height/priority-fee reads, simulation, sending, signature statuses, and transaction details. It does not provide unrestricted forwarding. Request/response bounds, timeouts, security headers, and host/origin checks are implemented in `serve.mjs`.

## Browser state

`site/js/main.js` owns the current wallet, owner address, scan phase, accounts, selection, prices, prepared plan, running state, and account-history view. `views.js` and `account-view.js` construct DOM through `dom.js`; chain text is inserted as text rather than HTML.

An owner change invalidates the previous plan and clears account data. Wallet changes received during a running claim are deferred so the captured transaction owner and recorded history remain consistent. Scan failures keep retry controls available and do not produce a clean-success state.

## Scan and classify

`rpc.js` queries both supported token programs. `accounts.js` validates the parsed account and classifies it as empty, holding, protected, unsupported, or unknown. Eligible empty accounts are initially selected; balances requiring burning are not.

Current exclusions include non-empty wrapped SOL, the explicit protected-mint set, frozen balances, NFT-like balances, foreign close authorities, withheld transfer fees, and confidential/unknown formats. The classifier is intentionally conservative but is not an exhaustive valuation or asset-recognition service.

Metadata comes from Token-2022 metadata or Metaplex. Prices come from Jupiter and are used for warnings and display, not as proof that a token is worthless. A missing quote remains unknown.

## Pump integration

`pump-rewards.js` derives the fixed Pump.fun and PumpSwap accumulator addresses and validates account owners, layouts, discriminators, balances, and relevant fields. The implementation cites a pinned official IDL revision in its source.

Supported actions recover eligible native SOL cashback or PumpSwap wrapped-SOL cashback and eligible accumulator rent. PumpSwap uses an isolated temporary WSOL account; an existing user WSOL account is not used as that temporary destination.

Unclaimed incentives, tracked volume, non-SOL rewards, or unknown fields keep the accumulator open. The app may still claim a supported cashback amount where the plan allows it. Token-incentive distributions and non-SOL cashback transfers are not implemented.

## Transaction flow

1. `batch.js` packs the selected actions within transaction-size/item limits.
2. `flow.js` simulates batches. Failing groups can be subdivided to isolate the failing item.
3. The app shows expected recovery, estimated fees, burns, skipped actions, and wallet-approval information.
4. A compatible wallet approves the prepared transaction. With `signTransaction`, the app checks the returned message using `verify.js` before sending. The fallback `signAndSendTransaction` capability sends within the wallet and cannot provide that same pre-send inspection.
5. The app polls confirmation and records known signatures. A timeout or incomplete RPC answer is not proof that a submitted transaction never landed.

The app constructs legacy transactions with one required signer. Accepted wallet changes are explicitly handled compute-budget adjustments within the additional-fee ceiling and Lighthouse check instructions. Other message changes are rejected on the app-side signing path.

## History and totals

`history.js` stores versioned records by wallet using the legacy `solburn:history:v1:` prefix. Each signature is deduplicated, and verified terminal data takes precedence over stale estimated updates. Storage errors produce a visible warning and retain an in-memory session copy where possible.

Only claims submitted through this app after recording was introduced are present. `history-sync.js` checks bounded windows of known signatures with historical status lookup and fetches transaction details. It verifies the signature and owner fee payer before calculating the wallet's actual pre/post SOL delta and network fee. Unresolved windows rotate so older entries are not permanently skipped.

`Total claimed` is confirmed gross recovery before network fees. Fees and net use actual transaction data when available; estimates stay labeled. Failed/open claims do not add to gross claimed. Time-range summaries and charts are derived from the selected locally recorded entries.

## Tools and deployment

`tools/demo-chain.mjs` starts an explicitly local LiteSVM fixture and app server. Signature verification is disabled in this fixture to support injected test-wallet workflows. Its account set and RPC coverage are limited; it is not a general Solana node or a production server.

`tools/mainnet-sim-check.mjs` performs live read/simulation requests and does not submit transactions. It is separate from the normal automated tests.

A public deployment needs a reviewed server-side `/rpc` endpoint and deployment-specific origin, HTTPS, rate-limit, credential, and privacy handling. Static hosting alone cannot replace the local proxy. See [SECURITY.md](../SECURITY.md).
