# Olden Era Wiki Content Refresh Runbook

## Frequency

- Check official wiki and Steam news after every game patch.
- Check Ubisoft and Hooded Horse news weekly while the game is in Early Access.
- Re-run content integrity tests after every content change.

## Commands

```bash
bun run test:olden
bun run lint:olden
bun run build:olden
```

## Manual Checks

- Confirm the latest client patch shown on the official wiki.
- Confirm faction names and game modes still match the current game.
- Confirm roadmap pages distinguish released features from planned features.
- Confirm all copied facts have attribution and license coverage.
- Confirm strategy prose is original and does not copy other guides.

## Release

- Use Conventional Commits.
- Open a PR with content sources listed.
- Wait for Olden PR CI before merge.
- Let the normal path run after merge: Docker Build and Push publishes the `olden` image, Argo CD Image Updater opens the release PR, release automerge promotes `argocd/applications/olden/kustomization.yaml`, and Argo CD syncs the app.
- Verify `https://olden.proompteng.ai/docs/meta/sources` after the release PR merges and Argo reports the app healthy.
