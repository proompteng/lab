# Kargo deployment automation

This repository uses Kargo as the single image-promotion authority. Git remains the complete desired-state authority:
source, workload configuration, and Kargo resources are reviewed in Git. Kargo owns the release decision after an image
has been published; it directly manages a deployment branch and does not open a second pull request to rewrite a SHA or
digest in the source repository.

The cluster installation is pinned to the Kargo v1.11 API and chart contract. Keep Warehouse, Freight, Stage, and
promotion-step fields aligned with that pinned version when enrolling an application.

## Operator UI

The Kargo API serves its UI at `https://kargo.ide-newton.ts.net` through a private Tailscale Ingress. Authenticate with
the existing Argo Dex SSO identity. Kargo's built-in admin account and API Secret management are disabled; credentials
and delivery resources remain declarative GitOps inputs. The UI is an operator view of Warehouse, Freight, Stage,
Promotion, and Argo state. Normal application upgrades remain automatic and must not be replaced with UI-driven image
selection, manifest edits, or manual Argo synchronization.

The CLI uses the same SSO provider:

```bash
kargo login https://kargo.ide-newton.ts.net --sso
```

## Artifact eligibility

Repo-owned builders publish an immutable Kargo alias only after the final multi-architecture OCI index succeeds. The
default alias is `kargo-sha-<40>`. Applications that retain a build receipt use
`kargo-sha-<40>-run-<github-run-id>` so a new run for the same source commit never attempts to move an immutable tag.
Every platform image carries `org.opencontainers.image.created` set to the source commit's RFC3339 time and
`org.opencontainers.image.revision` set to the full source commit SHA. The final OCI index repeats the source and
revision as OCI annotations. Receipt-bearing indexes also record the real `ai.proompteng.github-actions-run-id` and
the admitted `ai.proompteng.github-actions-build-conclusion`; the builder rejects a run-qualified tag whose annotations
are absent or disagree. Kargo exposes those annotations through `imageFrom(...).Annotations`. Applications with
retained build receipts must read them from the selected Freight image and must not substitute a Freight name or
invented conclusion. Repo-owned Warehouses select only their immutable alias shape; they ignore legacy `sha-*` tags
and mutable `latest`, so failed or pre-migration builds cannot create Freight. These tags are builder/Warehouse
implementation details: operators and agents do not create, retag, or manually select them.

`analysis` and `bilig` are the explicit external-publisher exceptions. The `analysis` Warehouse watches the publisher's
mutable `latest` discovery pointer with `imageSelectionStrategy: Digest`; its Freight and generated manifests pin the
immutable digest. The `bilig` Warehouse uses `NewestBuild` over the publisher's bare 40-hex tag. Neither external image
uses the repo-owned `kargo-sha-<40>` contract, and operators do not retag or manually select either publisher's tags.

## Normal production path

Every application image follows this transaction:

1. Merge the reviewed source pull request to `main`.
2. The existing `main` build workflow runs its tests, completes the final multi-architecture build, and publishes the
   eligible immutable artifact described above. A mutable `latest` tag or legacy `sha-*` tag is not a Kargo input.
3. The Kargo Warehouse observes the published image and creates a Freight containing the exact image digest.
4. The application's exact automatic promotion policy selects that Freight and promotes the matching Kargo Stage.
5. The Stage copies the exact source commit, writes the full image digest and companion build/provenance metadata, and
   directly commits and pushes `kargo/<stage>` with no pull request. The Argo CD Application tracks that branch. Kargo
   waits for Argo sync and health.
6. The application rollout and service-specific live checks prove the result. A retained post-deploy workflow listens
   to its exact `kargo/<stage>` branch and manifest paths, because the generated Kargo commit—not the earlier `main`
   merge—is the deployed revision. `workflow_dispatch` may run the same verifier diagnostically; it is not a promotion
   or recovery fallback.

There is no Image Updater, SHA-manifest bump, release branch, deployment PR, release automerge, manual Argo sync, or
direct `kubectl` deployment in this path. A failed build, Warehouse, Freight, Stage, Argo, or rollout gate blocks the
transaction at that gate; it is not repaired by bypassing the gate.

Kargo's `lab-delivery` Project, Warehouses, Freight records, Stages, promotion policies, and `kargo/<stage>` branches
are the promotion record. The ApplicationSet points each Kargo-managed Application at its Kargo branch and must not
overwrite that branch or its managed deployment metadata. If an Application is recreated, re-promote its current
Freight so Kargo reconstructs the branch and Argo follows it; do not recreate a digest bump pull request. An explicitly
authorized break-glass direct deployment is an incident action, not a normal release path.

Bayn is the one safety exception and is not enrolled in a Kargo Warehouse or Stage. Its `bayn-release` activation and
source-lineage branch remain the authority for strategy activation; an image digest alone never creates Freight or
authorizes a Bayn promotion.

## Application enrollment

For a new image-backed application:

1. Make the `main` build publish the verified `kargo-sha-<40>` artifact only after its final multi-architecture index
   succeeds, with the required OCI labels. Do not add a deployment PR job or a workflow that edits an Argo manifest
   after publication. For external `analysis`, keep `latest` as a `Digest`-strategy discovery pointer and pin the
   immutable digest in Freight/manifests; for external `bilig`, retain the bare 40-hex `NewestBuild` contract.
2. Add one Kargo Warehouse for the image and one Stage with the exact Git branch, digest, and build/provenance update
   contract. Add an exact automatic policy for that Stage; do not use a broad selector that can promote unrelated
   artifacts.
3. Add `kargo.akuity.io/authorized-stage: lab-delivery:<stage>` to the target Argo Application. If one Application
   consumes several images, authorize each corresponding Stage.
4. Configure Kargo to update the source files consumed by the Application's configured renderer (Kustomize, Helm,
   Lovely, or another approved renderer). Validate the rendered output against the promoted digest; the renderer is an
   implementation detail, not a second promotion authority.
5. Configure the ApplicationSet to track `kargo/<stage>` and preserve Kargo-managed deployment metadata. Keep the
   repository manifest on `main` as the reviewed source/configuration baseline; the Kargo branch is generated promotion
   state, not a second review boundary.
6. Prove one complete transaction: published immutable image -> Warehouse -> Freight -> Stage promotion -> Argo
   `Synced`/`Healthy` -> workload rollout -> application-specific live check.
7. If the application retains a post-deploy workflow, trigger it from the exact generated `kargo/<stage>` branch and
   the files the Stage writes. Do not trigger deployment proof from `main`, where the promoted digest does not yet
   exist.

## Evidence

Run these read-only checks from an authenticated cluster client. Replace placeholders with the exact resource names;
always provide an explicit namespace:

```bash
set -euo pipefail

# Kargo promotion record
kubectl -n lab-delivery get project,warehouse,freight,stage
kubectl -n lab-delivery get warehouse/<warehouse> -o yaml
kubectl -n lab-delivery get freight/<freight> -o yaml
kubectl -n lab-delivery get stage/<stage> -o yaml

# Argo result, Kargo branch, and the image selected by the Application
kubectl -n argocd get application/<application> -o jsonpath='{.status.sync.status}{"\n"}{.status.health.status}{"\n"}'
kubectl -n argocd get application/<application> -o jsonpath='{.spec.source.targetRevision}{"\n"}{.status.sync.revision}{"\n"}'

# Workload result (use the resource kind owned by the application)
kubectl -n <workload-namespace> rollout status deployment/<deployment> --timeout=5m
kubectl -n <workload-namespace> get pods -l app.kubernetes.io/instance=<application> -o wide
```

The evidence must identify the promoted digest and show that the running workload reports the same image ID (allowing
for a platform child digest when a multi-architecture index is used). `Synced`/`Healthy` alone is not rollout or live
application proof. The service's current runbook supplies endpoint, readiness, and domain-specific checks.

Distinguish these states in incident notes and delivery records: merged, built, published, Freight created, promoted,
Argo synced/healthy, rollout ready, and live application verified. “Merged” or “built” is not “deployed.”

## Recovery

For a failed promotion, inspect the Kargo Stage, Freight, Kargo branch, and Argo Application in the namespaces above and
fix the source-owned failure. Re-promote a previously proven Freight through Kargo for a targeted rollback; Kargo will
rewrite/push the branch and Argo will reconcile it. Do not edit a live Deployment, run `argocd app sync`, or create a
manifest-bump PR. If direct deployment is unavoidable, record explicit break-glass authorization and the incident
evidence, then restore Kargo control through Git/configuration afterward.

Historical release-branch and Image Updater documents are not current operating instructions; consult Git history when
auditing an old transaction.
