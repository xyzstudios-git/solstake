# Repository and publication

The owner authorized deployment to `https://solfund.xyzstudios.de` and then public visibility of [xyzstudios-git/solstake](https://github.com/xyzstudios-git/solstake) on 19 November 2026.

The MIT text is a proposal only. No active code license has been selected; public visibility does not grant general redistribution rights. Third-party licenses and trademark rights remain separate.

## Clone and verify

```bash
gh auth status
gh repo clone xyzstudios-git/solstake
cd solstake
./setup.sh
npm start
```

The `.env` file, `node_modules`, local agent files, generated logs and private Affinity sources must remain untracked. The supplied source tree includes the implemented interface, editable SVG marks and the local vendor assets.

## Push changes

Check the authenticated account, target repository and working-tree contents before pushing. Never push environment credentials or wallet secrets.

After a push, check both Node.js CI jobs. A successful local test run does not prove that the GitHub runner succeeded. CI runs syntax and offline tests; it does not deploy a website or sign real-wallet transactions.

## Public publication

Sites hosts a Cloudflare ESM Worker. Retain the exact project identity in `.openai/hosting.json` for updates. The hosting source repository is separate from GitHub; a GitHub push does not automatically deploy.

```bash
npm run check
npm test
npm run build
node --check dist/server/index.js
```

The build embeds all original `site/` files byte-for-byte. Runtime configuration belongs in the hosting environment: `SOLSTAKE_RPC_URL` is a server secret; `SOLSTAKE_ALLOWED_ORIGINS` is a comma-separated list of exact HTTPS origins. Keep credentials out of source, manifests and logs. Shared public RPCs may block account scans from hosting infrastructure. Verify the actual configured provider; provider-side quota limits remain necessary because Worker limits are per isolate.

Only `solfund` and its verification names are changed at GoDaddy. Subdomain forwarding was replaced with the exact hosting CNAME and two provider-supplied verification TXT records. Preserve the apex, `www`, mail records and nameservers. Keep validation records while the domain remains connected; cached forwarding records can outlive the authoritative DNS update.

After deployment, check anonymous HTTPS access, security headers, original assets, a read-only address scan and browser appearance. Do not sign or submit real-wallet transactions during unattended release checks. Roll back code by redeploying a previously verified saved Site version while preserving the domain and runtime secrets. Review [data handling](PRIVACY.md), [verification](VERIFICATION.md) and [security](../SECURITY.md).
