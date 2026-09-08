---
name: deployment
description: Verify image delivery through Kargo and Argo CD in this repo. Use when an image is published, a Kargo promotion is investigated, or a rollout needs proof.
---

# Deployment

## Overview

Production image delivery is automatic and single-writer:

`main` merge -> tested image build/publish -> Kargo Warehouse -> Freight -> exact automatic Stage promotion ->
Kargo copies the source commit and full digest/build metadata to `kargo/<stage>` -> Argo CD sync/health -> workload
rollout and live proof.

Repo-owned builders publish `kargo-sha-<40>` only after the final multi-architecture OCI index succeeds, with OCI
`org.opencontainers.image.created` set to the source commit's RFC3339 time and `org.opencontainers.image.revision` set
to its full SHA. Their Warehouses ignore legacy `sha-*` and mutable `latest`. External `analysis` uses publisher
`latest` only as a `Digest`-strategy discovery pointer and pins the immutable digest in Freight/manifests; external
`bilig` uses bare 40-hex/`NewestBuild`. Agents do not create or retag release tags.

Kargo is the promotion authority. Git remains the complete desired-state authority. Do not create a digest/SHA manifest
bump, release branch, deployment PR, release automerge, Image Updater change, manual Argo sync, or direct Kubernetes
deployment for a normal release. Kargo-owned `kargo/<stage>` branches are generated deployment state and are pushed
without a pull request; Argo Applications track those branches.

## When to use

- You need to verify a source merge, image publication, Freight, Stage promotion, or workload rollout.
- You need to enroll a new image-backed application (see [`docs/release-automation.md`](../../docs/release-automation.md)).
- You need to recover a failed rollout by re-promoting a previously proven Freight.

## Verify a promotion

Use explicit namespaces and read-only commands:

```bash
kubectl -n lab-delivery get project,warehouse,freight,stage
kubectl -n lab-delivery get warehouse/<warehouse> -o yaml
kubectl -n lab-delivery get freight/<freight> -o yaml
kubectl -n lab-delivery get stage/<stage> -o yaml
kubectl -n argocd get application/<application> -o jsonpath='{.status.sync.status}{"\n"}{.status.health.status}{"\n"}'
kubectl -n argocd get application/<application> -o jsonpath='{.spec.source.targetRevision}{"\n"}{.status.sync.revision}{"\n"}'
kubectl -n <workload-namespace> rollout status deployment/<deployment> --timeout=5m
kubectl -n <workload-namespace> get pods -l app.kubernetes.io/instance=<application> -o wide
```

Confirm the Freight digest, generated `kargo/<stage>` branch, Application target revision, running image ID, rollout,
and service-specific readiness/live check. Argo `Synced` and `Healthy` are necessary but do not prove that the new
workload is ready or that the service works.

## Rollback and break-glass

For a failed promotion, fix the source-owned failure and re-promote a known-good Freight through Kargo. Kargo rewrites
and pushes the deployment branch; Argo reconciles it. Do not edit a live Deployment or manifest, run `argocd app sync`,
or make a deployment PR. A direct deployment is permitted only with explicit break-glass authorization recorded in the
incident; restore Kargo control afterward.

The Bayn exception remains in force: Bayn is not enrolled in a Kargo Warehouse or Stage. `bayn-release` activation and
source-lineage state govern strategy activation.

## Development-only helpers

The repository contains service scripts that can build or mutate a local/isolated environment. They are not the
production image-promotion path and must not be used to bypass Kargo. See `packages/scripts/README.md` for their scope.

## Resources

- Canonical flow and enrollment: [`docs/release-automation.md`](../../docs/release-automation.md)
- Reference runbook: [`references/deploy-runbook.md`](references/deploy-runbook.md)
- Checklist: [`assets/deploy-checklist.md`](assets/deploy-checklist.md)
