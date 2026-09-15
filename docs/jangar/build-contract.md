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
- the final multi-architecture OCI index must succeed before the builder publishes `kargo-sha-<40>`; the image labels
  `org.opencontainers.image.created` and `org.opencontainers.image.revision` carry the source commit's RFC3339 time
  and full SHA, respectively
- production image promotion is performed by the Kargo `jangar` Warehouse and Stage; Kargo copies the exact source
  commit and writes the full digest plus build/provenance metadata to the generated `kargo/jangar` branch, then pushes
  it directly without a promotion pull request

## Manifest Contract

Canonical build/proof contracts:

- `packages/scripts/src/jangar/manifest-contract.ts`
- `packages/scripts/src/jangar/verify-deployment.ts`

Rules:

- the repository Kustomize files remain the reviewed configuration baseline
- Kargo writes the promoted digest and companion metadata to `kargo/jangar`; the Argo Application tracks that branch and
  ApplicationSet preserves the Kargo target revision and deployment metadata
- post-deploy verification reads the promoted digest and running image ID from the Kargo branch and Argo/runtime state
  instead of ad hoc line scanning

## Rollout Verification

Canonical verifier:

```bash
bun run packages/scripts/src/jangar/verify-deployment.ts --help
```

Checks:

- deployment rollout success for `jangar`
- expected image digest matches the rendered manifest contract
- Argo application reaches `Healthy`
- optional Argo `Synced` and expected revision checks when requested

## Production Flow

1. `jangar-build-push` validates the runtime contract, completes the final multi-architecture index, and publishes the
   eligible `kargo-sha-<40>` image after a merge to `main`; legacy `sha-*` and mutable `latest` are not Warehouse inputs.
2. The Kargo `jangar` Warehouse discovers the image and creates Freight in `lab-delivery`.
3. The exact automatic `jangar` Stage policy promotes the Freight. Kargo copies the source commit and writes the full
   digest/build metadata to `kargo/jangar`, then Argo tracks that branch and waits for sync/health.
4. The configured Jangar post-deploy health checks validate the rollout, promoted digest, running image ID, and Argo
   health.

There is no Image Updater, SHA/digest manifest bump, release branch, deployment PR, release automerge, or manual Argo
sync. If an Application is recreated, re-promote the current Freight through Kargo so the `kargo/jangar` branch is
reconstructed and tracked again.
