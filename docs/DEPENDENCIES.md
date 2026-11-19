# Dependency status

Checked during repository preparation on 19 November 2026. This is a recorded result, not a guarantee about future advisories.

The browser application and production Node server have no installed runtime dependencies. The Solana SDKs and LiteSVM are development tools for instruction comparisons, local-chain tests, and the explicit simulation/demo commands.

The tested development versions are `@solana/web3.js` 1.98.4, `@solana/spl-token` 0.4.15, and `litesvm` 0.3.3. A pinned `jayson` 5.0.0 override replaces the old transitive JSON-RPC client. A dedicated mocked `Connection` test checks the legacy SDK transport with this override; the complete test suite also passes.

## Audit result

The initial lockfile reported 10 entries (7 moderate and 3 high). The prepared lockfile reports **3 high entries and no moderate entries**. `npm audit --omit=dev` reports **0 vulnerabilities**.

The remaining high entries represent the unpatched `bigint-buffer` advisory and its dependent packages, `@solana/buffer-layout-utils` and `@solana/spl-token`. See [GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg). No patched version of that underlying package was available during preparation. The findings have not been filtered, renamed, or treated as resolved because native bindings may be absent on one machine.

Avoid applying `npm audit fix --force`: the suggested downgrade of the Token SDK is not an equivalent security update, and a switch to the latest SDK generation requires a deliberate test-tool migration. The remaining development-tool exposure is a known limitation. This source package is not an independent security audit or a public-deployment approval.

Run the checks again before release:

```sh
npm audit
npm audit --omit=dev
npm test
```

Dependabot is configured for npm and GitHub Actions updates. Review dependency changes and rerun the full suite before merging them.
