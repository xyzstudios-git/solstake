# Third-party notices

Solfund includes the following vendored browser assets. Their original license texts remain alongside the files.

| Component | Location | License | Source |
| --- | --- | --- | --- |
| Puppertino 2.0.0 CSS and modal/sheet helpers | `site/vendor/puppertino/` | MIT, Edgar Pérez | <https://github.com/codedgar/Puppertino> |
| Phosphor bold/fill icon fonts | `site/vendor/phosphor/` | MIT, Phosphor Icons | <https://github.com/phosphor-icons/web> |

The bundled Phosphor CSS has been adjusted to reference only the included WOFF2 fonts. No additional font binaries are required.

`site/apple-ui.css` is the local interface adaptation used by this project. No Apple font files or SF Symbols are included. The interface uses the browser's system-font stack.

The application icon and editable SVG in `design/branding/` were supplied for this project. The inline Solana mark identifies the Solana network; third-party names and marks remain the property of their respective owners. The project's code license does not grant rights to third-party trademarks.

Development dependencies are installed from the exact versions and integrity hashes in `package-lock.json`. They are not shipped to the browser or needed by the production Node server. Their own licenses are included by their packages.

Pump program identifiers, instruction discriminators, and protocol layouts are based on the official public interface documentation at <https://github.com/pump-fun/pump-public-docs>. See `tests/pump-rewards.test.mjs` for compatibility checks. No Sol Incinerator source code is bundled.
