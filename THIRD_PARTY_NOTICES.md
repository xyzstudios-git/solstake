# Third-party notices

Solstake includes the following vendored browser assets. Their original license texts remain alongside the files.

| Component | Location | License | Source |
| --- | --- | --- | --- |
| Puppertino 2.0.0 CSS and modal/sheet helpers | `site/vendor/puppertino/` | MIT, Edgar Pérez | <https://github.com/codedgar/Puppertino> |
| Phosphor bold/fill icon fonts | `site/vendor/phosphor/` | MIT, Phosphor Icons | <https://github.com/phosphor-icons/web> |

The bundled Phosphor CSS has been adjusted to reference only the included WOFF2 fonts. No additional font binaries are required.

`site/apple-ui.css` is the local interface adaptation used by this project. No Apple font files or SF Symbols are included. The interface uses the browser's system-font stack.

The application icon and editable SVG in `design/branding/` were supplied for this project. The inline Solana mark identifies the Solana network; third-party names and marks remain the property of their respective owners. The project's code license does not grant rights to third-party trademarks.

Development dependencies are installed from the exact versions and integrity hashes in `package-lock.json`. They are not shipped to the browser or needed by the production Node server. Their own licenses are included by their packages.

Pump program identifiers, instruction discriminators, and protocol layouts are based on the official public interface documentation at <https://github.com/pump-fun/pump-public-docs>. See `tests/pump-rewards.test.mjs` for compatibility checks. No Sol Incinerator source code is bundled.

The XYZ STUDIOS wordmark in `site/assets/xyz-studios.svg` and `design/branding/xyz-studios.svg` was taken from the owner's website, <https://xyzstudios.de/>, with their authorization for this design credit. The original 600 × 73 transparent PNG embedded in the website's `assets/site.css` (`--logo-zeile`) is preserved byte-for-byte inside a simple SVG container. This is a raster wordmark, not a vector master. It replaces the earlier supplied footer artwork, is not an Apple asset and is not covered by the project code license.

The footer's `site/assets/github-mark.svg` is the unmodified white Invertocat from the [official GitHub logo files](https://brand.github.com/GitHub_Logos.zip), documented in the [GitHub Brand Toolkit](https://brand.github.com/foundations/logo). `site/assets/x-mark.svg` is the unmodified white logo from the [official X Brand Toolkit](https://about.x.com/en/who-we-are/brand-toolkit). These marks identify links to the respective services; their trademark rights and brand usage terms remain with their owners and are not granted by the proposed project code license.
