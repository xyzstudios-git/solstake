# Contributing to Solfund

## Development setup

Use Node.js 24 or newer and npm. Node.js 24 is recommended.

```bash
./setup.sh
npm start
```

The app runs at [http://127.0.0.1:8790](http://127.0.0.1:8790). Test dependencies are installed from the lockfile. Configuration belongs in the environment; keep local `.env` files and RPC credentials out of commits.

```bash
npm run check
npm test
npm run test:coverage
```

The normal tests use mocked RPC responses or a local LiteSVM instance. They do not require a funded wallet. Do not add network access or real wallet approvals to the default test suite.

## Changes and pull requests

1. Create a branch for one focused change.
2. Preserve existing behavior unless the issue explicitly changes it.
3. Add a meaningful regression test for transaction, parsing, storage, RPC, or state-management changes.
4. Run the relevant tests, then the full suite before requesting review.
5. Describe the resulting behavior, validation performed, and anything still unverified.

For interface changes, check the affected states at narrow and wide widths and include screenshots that contain only test data. English UI strings, accessible names, keyboard focus, and existing branding should stay consistent. Use the locally bundled components and icons; do not add a remote dependency for a minor visual change.

## Code conventions

- The application is plain JavaScript ES modules, HTML, and CSS. There is no transpilation or bundling step.
- Create untrusted names and errors as text nodes through `site/js/dom.js`; do not interpolate them into HTML.
- Keep account classification, instruction generation, fee calculations, and transaction verification separate from views.
- Preserve exact token amounts with `BigInt` and validate lamport values before converting to `Number`.
- Treat simulations as previews, not guarantees of later execution.
- Keep the RPC method allowlist, host/origin checks, response limits, and credential redaction explicit.
- Do not rename persisted history keys or deterministic account seeds as part of a branding cleanup. Compatibility needs a separate plan and tests.

Changes to signing, recipients, account authorities, Pump layouts, fee limits, or transaction verification require an independent code review. A local mock or LiteSVM result must not be described as a successful real-wallet or mainnet test.

## Reporting problems

For a normal bug report, include the app version or commit, browser and wallet versions, reproduction steps, expected behavior, and a redacted screenshot or error message. Use a test wallet where possible. Never attach recovery phrases, private keys, RPC credentials, or a browser-storage export containing personal history.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of disclosing exploit details in a public issue.

## Using Codex

Read [AGENTS.md](AGENTS.md) first. Give the agent a bounded task and relevant reproduction steps. Keep implementation claims tied to actual test output. Agents must not approve real-wallet transactions, publish releases, or push changes on a contributor's behalf without the contributor's explicit authorization.
