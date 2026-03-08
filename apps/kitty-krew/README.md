# Kitty Krew

TanStack Start app packaged for container builds and GitHub Actions image publishing.

## Local development

From the repo root:

```bash
bun run --filter ./apps/kitty-krew dev
bun run --filter ./apps/kitty-krew build
```

Or from `apps/kitty-krew`:

```bash
bun install
bun run dev
bun run build
bun run start
```

The app serves on port `3000`.

## Container build

`apps/kitty-krew/Dockerfile` uses a multi-stage Bun build with repo-root context:

- builder image: `oven/bun:1.3.10-alpine`
- build context: `.`
- Dockerfile path: `./apps/kitty-krew/Dockerfile`

That root context is required because the image copies shared workspace manifests, the root `bun.lock`, and shared
packages before building the app workspace.

Example local build from the repo root:

```bash
docker build -f apps/kitty-krew/Dockerfile -t kitty-krew:local .
```

## GitHub Actions build flow

Image publishing is wired through `.github/workflows/docker-build-push.yaml`.

- trigger: `push` to `main` when `apps/kitty-krew/**` changes
- reusable workflow: `.github/workflows/docker-build-common.yaml`
- image name: `kitty-krew`
- Docker context: `.`
- Dockerfile: `./apps/kitty-krew/Dockerfile`

## Notes

- The package manifest still carries the original example package name. The runtime scripts and Docker build are the
  current source of truth for this workspace.
- If you change the Dockerfile inputs, keep the repo-root build context aligned with the files copied in the builder
  stage.
