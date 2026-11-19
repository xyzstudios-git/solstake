# Solstake design

This repository includes the complete implemented visual interface and its local assets. These are the source files used by the application, rather than a screenshot-only mockup.

<p align="center"><img src="branding/source-logo.svg" width="88" alt="Solstake logo"></p>

## Brand assets

| Asset | Source | Use |
| --- | --- | --- |
| Application mark | [`../site/icon.svg`](../site/icon.svg) | Header, start screen, browser icon |
| Supplied color mark | [`branding/source-logo.svg`](branding/source-logo.svg) | Original gradient artwork extracted from the supplied Affinity SVG artboard, with transparent margins fitted |
| Design credit logo | [`branding/xyz-studios.svg`](branding/xyz-studios.svg), [`../site/assets/xyz-studios.svg`](../site/assets/xyz-studios.svg) | Original transparent horizontal wordmark from the XYZ STUDIOS website |
| Earlier layout preview | [`../docs/images/preview.jpg`](../docs/images/preview.jpg) | Archived layout reference; predates the replacement logo |

The current logo is the supplied pair of open circular arcs with the original purple-to-green gradient. The supplied Affinity SVG is a multi-variant artboard; its colored version is an embedded transparent PNG. `branding/source-logo.svg` retains those colored pixels without resampling, crops only the transparent exterior and centers the mark within a square canvas. The application uses a 512 × 512 optimized derivative in `site/icon.svg`, shared by the 32 px header mark, start screen and favicon. These SVG containers hold raster artwork and are not editable vector masters. No font or wordmark from the artboard was imported; the existing Solstake system-font wordmark remains live text.

The original multi-variant artboard remains in the owner's supplied file outside the repository. Both prior application-logo files have been replaced by the current artwork.

## Interface layers

| Layer | Source of truth | Responsibility |
| --- | --- | --- |
| Component base | [`../site/vendor/puppertino/`](../site/vendor/puppertino/) | Bundled Puppertino CSS and modal/sheet helpers |
| Apple-style adaptation | [`../site/apple-ui.css`](../site/apple-ui.css) | Spacing scale, shared controls and component corrections |
| Solstake theme and layout | [`../site/app.css`](../site/app.css) | Brand colors, floating header, materials, account rows, dialogs and responsive layouts |
| Account view | [`../site/account.css`](../site/account.css), [`../site/js/account-view.js`](../site/js/account-view.js) | Claim totals, chart, transactions and history states |
| Main views | [`../site/js/views.js`](../site/js/views.js), [`../site/index.html`](../site/index.html) | Start, account selection, wallet menu and claim flow |
| Icons | [`../site/vendor/phosphor/`](../site/vendor/phosphor/) | Local bold/fill icon fonts with their license |

Styles are loaded in this order: Puppertino, `apple-ui.css`, `app.css`, then `account.css`. Keep application-specific overrides in the application styles instead of modifying the vendored component library.

## Color and type

| Role | Current value |
| --- | --- |
| Logo gradient | Original colors from the supplied artwork |
| Brand purple | `#9945FF` |
| Indigo | `#8752F3` |
| Teal | `#3FBAC8` |
| Green | `#19FB9B` |
| Dark page | `#0A0B0F` |
| Light page | `#F5F5F8` |

The supplied logo retains its own purple-to-green gradient. SOL amounts and accent controls retain their existing gradients. Controls use the existing accessible contrast treatment in the CSS. Status is conveyed with text and icons as well as color.

The typography uses the existing system-font stack. No new webfont, Apple font file, or SF Symbols package is included. Phosphor supplies the icon glyphs.

## Layout and interaction

- A floating capsule header contains refresh, wallet and the circular **44 × 44 px Account icon**.
- Claim review offers two equally sized controls. **Claim with Tip** uses the prominent Solstake treatment; **Claim without Tip** uses a neutral treatment. Both remain directly visible and show their estimated net payout. The optional 20% amount and recipient are disclosed before approval; token-burning labels remain explicit.
- SOL and USD summaries sit beside each other on wider screens and stack on narrow screens. The token list spans the content width below.
- The content maximum is 1180 px, increasing to 1280 px on very wide screens. Cards use a 28 px radius. Shared spacing follows a 4 px scale.
- Glass is concentrated in navigation and modal controls. Content cards use a stable surface for readable values and descriptions.
- Mobile token rows keep account names, descriptions and amounts readable. Wallet groups have separate insets and padding, and sheet content uses consistent 16 px spacing. Long dialog messages scroll while their actions remain available. Mobile sheets fit short contents, while tablets and larger screens use a centered sheet. Account metrics use two columns on tablets and four on larger screens.
- Account history provides 7-day, 30-day and all-time views, a cumulative chart, an accessible data table, explicit transaction status and explorer links.
- The interface language is English. Numbers use decimal points, USD uses the dollar format, and dates use `en-US` formatting.
- The styles include reduced-motion, reduced-transparency and increased-contrast treatments. This is not a claim of complete accessibility conformance.

## Preserve when changing the design

Keep the supplied logo geometry and current typography. Show pending claims separately from confirmed totals. Do not let visual changes hide token-burn warnings, storage errors, account restrictions, network fees or transaction status.

The recorded browser checks and their limits are in [`../docs/VERIFICATION.md`](../docs/VERIFICATION.md). Vendor licensing and mark ownership are recorded in [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

The compact footer appears only on the disconnected start page and contains three equal-width borderless links in one grid: X, the XYZ STUDIOS website and the Solstake repository. All three share the caption and interaction treatment. X and the original GitHub mark use 32 px frames; the transparent studio wordmark fits the same row without stretching. “Designed by:” appears above the studio wordmark; “GitHub” labels the repository link. The footer adapts to light/dark appearance and reserves room for the mobile claim control.
