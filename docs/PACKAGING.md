# Repository preparation record

Prepared on 19 November 2026.

- Complete browser source, local Node server, bundled UI assets, tests, demo/simulation tools, and editable branding SVG are included.
- Documentation, setup, optional environment example, Git ignore rules, CI, Dependabot, issue forms, and a PR template are present.
- The complete setup flow passed in a separate fresh dependency installation on macOS with Node.js 26: 43 modules syntax-checked and 136 tests passed.
- Missing icon-font fallback references were removed; the supplied WOFF2 fonts are retained. Embedded SVG fragment references do not require external files.
- The README preview is a neutral local app view without wallet addresses, balances, transaction history, or credentials.
- Private Affinity sources containing workstation metadata remain outside the repository. Local agent configuration, real environment files, logs, installed dependencies, and GitHub authentication data are excluded.
- The dependency audit reports three high development-only entries from the same unpatched dependency chain. The runtime-only audit reports zero. See [DEPENDENCIES.md](DEPENDENCIES.md).
- GitHub Actions, Linux, public web hosting, and wallet-specific behavior have not been validated by this preparation. The repository contains no automatic deployment.

The repository is to remain **private**. Public visibility and adoption of the proposed MIT code license require a later explicit owner approval. The target GitHub account must be verified at upload time.
