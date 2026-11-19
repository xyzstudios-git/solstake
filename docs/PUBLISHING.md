# Repository and publication

The project targets the private repository [xyzstudios-git/solstake](https://github.com/xyzstudios-git/solstake). The owner has authorized the private upload. Public visibility and deployment require separate, explicit approval.

The proposed code license is MIT; the owner must choose the license before public publication. Third-party licenses and trademark rights remain separate.

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

Check the authenticated account, target repository, private visibility and working-tree contents before pushing. Never push environment credentials or wallet secrets.

After a push, check both Node.js CI jobs. A successful local test run does not prove that the GitHub runner succeeded. CI runs syntax and offline tests; it does not deploy a website or sign real-wallet transactions.

## Public publication

Public visibility requires a separate owner go and a confirmed code license. Public web hosting needs a reviewed HTTPS deployment for the static files and restricted `/rpc` proxy; GitHub Pages alone cannot run this server. Review the remaining limits in [VERIFICATION.md](VERIFICATION.md) and [SECURITY.md](../SECURITY.md).
