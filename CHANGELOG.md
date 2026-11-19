# Changelog

Changes are recorded by release. Unreleased work is not a published or production-verified release.

## [Unreleased]

### Fixed

- Refresh changed or unavailable Pump rewards into a new simulated review, preserving other eligible claims.
- Allow higher Pump rewards with unchanged instructions while retaining the originally approved tip quote.

- Respect account-level wallet signing permissions and refresh same-address account authorizations.
- Stop revoked accounts before wallet requests and provide explicit reconnect/review recovery for authorization errors.

### Added

- Compact X, XYZ STUDIOS design credit and direct repository footer.

- Optional 20% tipping in the claim review, with a prominent tipped option and an equally direct no-tip option.
- Both plans are simulated before approval; tips execute atomically with claims and are never added after an opt-out.
- History separates verified tips, network fees, gross recovery and net received amounts.

- SPL Token and Token-2022 account scanning, simulation, and eligible account cleanup.
- Optional selected-token burning with value warnings and extra confirmation.
- Supported Pump.fun/PumpSwap cashback and eligible reward-account rent recovery.
- Wallet-separated local claim history, cumulative charts, and transaction reconciliation.
- Offline instruction, RPC, LiteSVM, view, and app-entry-point tests.
- Repository documentation and reproducible development setup.

### Changed

- Replaced footer cards with borderless brand links and the original transparent XYZ STUDIOS website wordmark.

- Renamed the product to Solstake; previous server environment names remain compatible.
- Converted the interface, accessibility labels, errors, and numeric/date formatting to English.
- Made the Account control a circular icon button.
- Improved narrow layouts, dialog scrolling, scan failures, search selection notices, wallet-change handling, and keyboard focus.

### Compatibility

- Legacy browser-history keys and deterministic temporary-account seeds remain unchanged.
- Pending token incentives, non-SOL token rewards, and unknown Pump fields keep reward accounts open; full token-incentive and non-SOL cashback claims are not implemented.
