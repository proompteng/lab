# Jangar Build And Release Contract

This is the operational build contract for Jangar. Use it as the source of truth for CI/CD, release scripts, and post-deploy verification.

## Runtime Build

Inputs:

- `services/jangar/package.json`
- `services/jangar/vite.config.ts`
- `services/jangar/vite.server.config.ts`
- `services/jangar/src/**`

Command:

```bash
bun run --cwd services/jangar build
```

Outputs:

- client assets in `services/jangar/.output/public`
- server bundle in `services/jangar/.output/server/index.mjs`

Runtime expectations:

- the production container serves static assets from `.output/public`
- the production container starts the HTTP runtime from `.output/server/index.mjs`
- a valid release must include both artifacts; a client-only Vite build is not sufficient

## Image Build

Canonical image orchestration:

```bash
bun run packages/scripts/src/jangar/build-images.ts
```

Contracts:

- image metadata is emitted through `packages/scripts/src/jangar/release-contract.ts`
- the runtime image and optional control-plane image share one typed release contract
- manifest updates use `packages/scripts/src/jangar/update-manifests.ts`

## Manifest Contract

Canonical manifest readers/writers:

- `packages/scripts/src/jangar/manifest-contract.ts`
- `packages/scripts/src/jangar/update-manifests.ts`
- `packages/scripts/src/jangar/verify-deployment.ts`

Rules:

- kustomization image references are read and updated through typed YAML parsing
- rollout annotations are updated through typed YAML parsing
- post-deploy verification reads the expected digest from the same manifest contract instead of ad hoc line scanning

## Rollout Verification

Canonical verifier:

```bash
bun run packages/scripts/src/jangar/verify-deployment.ts --help
```

Checks:

- deployment rollout success for `jangar` and `jangar-worker`
- expected image digest matches the rendered manifest contract
- Argo application reaches `Healthy`
- optional Argo `Synced` and expected revision checks when requested

## Production Flow

1. `jangar-build-push` builds and publishes the runtime contract.
2. `jangar-release` writes the promoted digest into GitOps manifests.
3. Argo CD reconciles the release revision.
4. `jangar-post-deploy-verify` validates rollout, digest, and Argo health.
