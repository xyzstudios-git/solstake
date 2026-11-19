# Security policy

Solstake builds transactions that may permanently burn tokens or close accounts. The current development version is not independently audited. Automated tests, simulations, and code review reduce particular risks but do not prove that every wallet, account type, or deployment is safe.

## Reporting a vulnerability

If this repository has GitHub private vulnerability reporting enabled, use **Security → Report a vulnerability**. If that option is unavailable, ask the maintainers for a private reporting route without posting exploit details or sensitive data publicly.

Include the affected commit, a minimal reproduction using test accounts, the expected impact, and any relevant logs with credentials removed. Never send recovery phrases, private keys, funded-wallet key files, RPC tokens, or raw browser-storage exports.

## Current boundaries

- The application does not request private keys or recovery phrases. Signing is delegated to a compatible Wallet Standard wallet.
- For wallets that return signed transactions, `site/lib/verify.js` compares the returned message with the prepared plan before the app sends it. Only specifically handled compute-budget changes and Lighthouse checks are permitted. Wallets exposing only sign-and-send perform sending themselves; that path does not provide the same app-side pre-send inspection.
- The account classifier excludes unsupported or protected cases. This is a defined set of rules, not a guarantee that every valuable or unusual asset is recognized.
- Pump integration uses fixed program IDs and a pinned layout reference. Pending incentives, token rewards, or unknown account fields prevent closing the accumulator. On-chain program changes can require updates.
- The supplied HTTP server binds to loopback, restricts host/origin, validates permitted RPC parameters, bounds request and response sizes, and sends security headers. It is a local-development server, not an internet-facing deployment template.
- API endpoint credentials belong in server configuration. Do not place them in `site/` or publish them in issues, commits, screenshots, or logs.
- History is stored locally by wallet and reconciles known signatures. It can be missing, corrupted, unavailable, or incomplete and must not be used as a complete accounting record.
- The voluntary 20% tip uses a fixed recipient and an explicit choice for each claim. Its transfer is included after the claim instructions in the same transaction. No-tip plans and self-recipient claims add no transfer. Signed-message checks cover the recipient and amount; failed claim transactions pay no tip, while network fees may still be charged. History verifies the expected transfer before adding the tip back to gross recovery.

## External services

The configured Solana RPC receives queried addresses and submitted transactions. The browser requests token prices from Jupiter. Explorer links open Solscan when selected. Review the privacy and reliability implications of these services before deploying or changing them.

## Before a public deployment

Review the complete deployed path, including HTTPS, origin validation, rate limiting, secrets, dependencies, browser-wallet behavior, privacy information, and incident reporting. Test the exact deployed build with suitable test data. Publishing the source repository alone is not evidence that deployment or wallet handling has been verified.
