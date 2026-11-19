# Changelog

Changes are recorded by release. Unreleased work is not a published or production-verified release.

## [Unreleased]

### Added

- SPL Token and Token-2022 account scanning, simulation, and eligible account cleanup.
- Optional selected-token burning with value warnings and extra confirmation.
- Supported Pump.fun/PumpSwap cashback and eligible reward-account rent recovery.
- Wallet-separated local claim history, cumulative charts, and transaction reconciliation.
- Offline instruction, RPC, LiteSVM, view, and app-entry-point tests.
- Repository documentation and reproducible development setup.

### Changed

- Renamed the product to Solfund.
- Converted the interface, accessibility labels, errors, and numeric/date formatting to English.
- Made the Account control a circular icon button.
- Improved narrow layouts, dialog scrolling, scan failures, search selection notices, wallet-change handling, and keyboard focus.

### Compatibility

- Legacy browser-history keys and deterministic temporary-account seeds remain unchanged.
- Pending token incentives, non-SOL token rewards, and unknown Pump fields keep reward accounts open; full token-incentive and non-SOL cashback claims are not implemented.
