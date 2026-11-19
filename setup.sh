#!/bin/sh
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
command -v node >/dev/null 2>&1 || { printf '%s\n' 'Node.js 24 or newer is required.' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { printf '%s\n' 'npm is required.' >&2; exit 1; }
node --input-type=module -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Node.js 24 or newer is required."); process.exit(1); }'

npm ci
npm run check
npm test
printf '\n%s\n' 'Setup complete. Run npm start, then open http://localhost:8790.'
