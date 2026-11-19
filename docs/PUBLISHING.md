# Publishing the prepared repository

The source is prepared locally. No remote repository is created by these instructions and no deployment runs automatically.

The owner has chosen a **private repository**. Public visibility or deployment requires a separate, explicit approval. Before the first push, verify the target GitHub account or organization. The proposed code license is MIT; review it before public publication. Third-party licenses and trademark rights remain separate.

The prepared initial commit uses a neutral project identity, not a personal email address. Choose an appropriate public or GitHub noreply author identity before subsequent commits. Review [dependency status](DEPENDENCIES.md) as part of the publication decision.

From the repository directory:

```sh
npm ci
npm run check
npm test
git status --short
```

The `.env` file, `node_modules`, local agent files, generated logs, and private Affinity sources must remain untracked. The original Affinity file is preserved separately from the GitHub source package because it contains workstation metadata.

For a new private GitHub repository, after checking the authenticated account:

```sh
gh auth status
gh repo create solfund --private --source=. --remote=origin --push
```

Use `--public` only when public publication and the license have been approved. Do not create a remote README or license through GitHub before pushing the complete local tree.

After the push, check that both Node.js CI jobs pass. Configure repository security reporting and review permissions in GitHub. CI does not deploy a website. Public web hosting needs a separate deployment plan for the static files and the restricted `/rpc` proxy; GitHub Pages alone cannot run this server.
