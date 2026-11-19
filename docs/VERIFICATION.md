# Verification and known limits

This document distinguishes local automated checks, observed browser behavior, and work that still needs independent verification. It is not an audit report or a release approval.

## Recorded local checks

As of 19 November 2026, the working project passed **131 Node tests on macOS** after the English interface and circular Account control changes. That result applies to the tested working state. A newly generated CI workflow is not considered verified until its own run succeeds.

The repository preparation then passed the complete `./setup.sh` flow in a separate fresh installation: syntax checks for 43 JavaScript modules and **136 tests** on macOS with Node.js 26. Four added tests cover configuration precedence, legacy environment variables, native `.env` loading, and explicit arguments for the simulation tool. A further test checks the updated development SDK transport. The earlier layout screenshot was captured from the prepared Solfund source before the rename to Solstake, without a connected wallet. See [dependency status](DEPENDENCIES.md) for the remaining development-only advisory.

The minimal development-dependency update then passed **136 tests**, including a new SDK transport compatibility test. The app's browser code is byte-identical across that dependency update. The audit result and remaining development-only findings are described in [DEPENDENCIES.md](DEPENDENCIES.md).

| Area | Evidence and scope |
| --- | --- |
| Chain formats | Base58, byte utilities, PDA derivation, instructions, transaction serialization, and returned-message verification compared with the installed Solana libraries. |
| Account rules | Empty/holding/protected/unknown states and relevant Token-2022 exclusions. |
| LiteSVM | Local execution of token burning/closing, rent return, frozen-account behavior, and a complete simulated/sign/send/confirm flow. |
| Pump | PDA/layout/instruction checks, supported cashback/rent plans, pending/unknown-field preservation, isolated temporary WSOL handling, and mixed-plan accounting. These do not prove execution against every current mainnet program state. |
| RPC server | Static-file boundaries, host/origin checks, method/parameter restrictions, request/response limits, credential redaction, and transaction-history read options. |
| History | Per-wallet persistence, signature deduplication, storage failures, exact totals, chain reconciliation, expired-signature rechecks, and rotation past unresolved entries. |
| App entry point | A synthetic DOM and local test wallet exercise connect, scan, review, signing, sending, confirmation, stored history, account navigation, focus, failed scans/retry, and deferred wallet changes. |
| Views | Unsupported account visibility, read-only guidance, disabled actions, concise destructive labels, search clearing, and selection outside a filtered result. |

The normal test suite uses mocked transport or LiteSVM; it does not require RPC credentials, a funded wallet, or real network transactions.

## Browser observations

The optional-tip extension passed **151 automated tests**, including both app-entry-point choices, exact System Program transfer comparison, packet sizing, signed-message tampering, rollback in LiteSVM, tip-unavailable fallback, and history reconciliation. No real tip or mainnet claim was signed or submitted by these checks. Rendered browser QA for the new tip controls remains open because browser access was unavailable during this change.

The account-selection layout was inspected in Chrome at 320, 375, 768, and 1440 CSS-pixel viewport widths without horizontal overflow in the tested state. Mobile claim-preview and long-error-dialog layouts were checked. The English Account screen and circular 44 × 44 Account control were observed in the live local app, including a previously recorded claim reconciled with transaction details.

These observations cover the tested dark appearance and states. They do not establish accessibility conformance, support for every browser, complete light-mode verification, or all wallet/mobile combinations. Synthetic DOM tests do not substitute for rendered-browser checks.

## Reproduce automated checks

```bash
npm ci
npm test
npm run test:coverage
```

The first command needs registry access. Once dependencies are installed, the normal tests do not intentionally call a live Solana RPC or request a real-wallet signature. Local HTTP tests listen on ephemeral loopback ports.

Coverage must be generated from the current checkout. Historical coverage percentages from an earlier implementation are intentionally not presented as the current result.

## Not yet established

- Independent security audit or public-deployment readiness.
- End-to-end behavior for every real Phantom, Solflare, Backpack, mobile-wallet, or sign-and-send-only configuration.
- Execution against every current Pump/PumpSwap layout or future program revision.
- NFT burning, Pump token-incentive claims, non-SOL cashback, surplus-lamport withdrawal, or other proposed reward integrations.
- Very large wallets/history records or long-duration provider failures under realistic load.
- Complete production privacy, rate-limit, abuse-handling, monitoring, and incident-response behavior.

A future release should record its exact commit, runtime/platform, test output, browser checks, and deployment-specific validation. Keep real-wallet approvals with the wallet owner.

## Solstake name and design-credit footer

On 19 November 2026, the Solstake rename and compact footer extension passed syntax checks for **45 JavaScript modules** and **152 offline tests** on macOS. The additional configuration test verifies `SOLSTAKE_*` precedence while retaining `SOLFUND_*` and `LEERGUT_*` aliases. The supplied XYZ STUDIOS logo retains its artwork and embedded mask image; only the SVG artboard bounds were fitted. The source and runtime copies match.

Code review found no actionable issues. Browser control was unavailable in this chat, so responsive appearance, footer interactions and light/dark layout have not been visually verified in a live browser for this change. Prior browser observations above do not constitute visual approval of the new footer. The first private GitHub push also passed both Ubuntu CI jobs (Node.js 24 and 26): [CI run 44531521479](https://github.com/xyzstudios-git/solstake/actions/runs/44531521479), source commit `94cffa12518e30d257936ae86c92c737ae9e95c2`. Both runners completed dependency installation, syntax checks and the offline tests successfully. Later pushes still need their own CI checks.

The follow-up footer alignment uses three equal-width 80 px links with common states and logo frames. The original GitHub and X SVGs match their official downloaded source files byte-for-byte; all footer files were verified over the local HTTP server. The existing app-entry-point test passed against the updated HTML, including its mocked claim and persisted-history flow. This remains a code/asset check; a rendered browser view of the aligned footer was not available in this chat.
