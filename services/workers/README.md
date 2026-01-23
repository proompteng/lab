# Workers image (codex tools)

This image is intended for the Firecracker/Kata pod in `argocd/applications/workers`.
It bundles nvm + Node, Bun, and the Codex CLI.

Build/push via:

```
bun run packages/scripts/src/workers/build-image.ts [tag]
```
