# Kargo deployment runbook

## Normal path

1. Merge the reviewed source change to `main`.
2. Wait for the main-branch build/test workflow to complete the final multi-architecture index and publish the eligible
   `kargo-sha-<40>` alias with the required OCI source-time/revision labels. Warehouses ignore legacy `sha-*` and
   mutable `latest`. For external `analysis`, `latest` is only a `Digest`-strategy discovery pointer and Freight/manifests
   pin the immutable digest; external `bilig` uses bare 40-hex/`NewestBuild`.
3. Inspect the Kargo Warehouse and Freight in `lab-delivery`.
4. Wait for the exact automatic promotion policy to promote the target Stage.
5. Let Kargo copy the exact source commit, write the full digest and companion build/provenance metadata to
   `kargo/<stage>`, push that branch without a pull request, and let the Argo Application track and sync it.
6. Verify Argo health, the workload rollout, the running image ID, and the service's live checks.

Do not open or merge a digest/SHA manifest pull request. Image Updater, release branches, release automerge, manual
Argo syncs, and direct `kubectl apply` are retired from the normal path.

## Evidence

```bash
set -euo pipefail

kubectl -n lab-delivery get project,warehouse,freight,stage
kubectl -n lab-delivery get warehouse/<warehouse> -o yaml
kubectl -n lab-delivery get freight/<freight> -o yaml
kubectl -n lab-delivery get stage/<stage> -o yaml

kubectl -n argocd get application/<application> -o jsonpath='{.status.sync.status}{"\n"}{.status.health.status}{"\n"}'
kubectl -n argocd get application/<application> -o jsonpath='{.spec.source.targetRevision}{"\n"}{.status.sync.revision}{"\n"}'
kubectl -n <workload-namespace> rollout status deployment/<deployment> --timeout=5m
kubectl -n <workload-namespace> get pods -l app.kubernetes.io/instance=<application> -o wide
```

The Freight digest, generated `kargo/<stage>` branch, Argo sync revision, and running image ID must correspond. For a
multi-architecture image, the kubelet may report the platform child digest rather than the index digest.
`Synced`/`Healthy` does not replace rollout or application-level readiness proof.

## Recovery

Inspect the Warehouse, Freight, Stage, generated `kargo/<stage>` branch, Argo Application, events, and workload logs
before changing anything. Correct the owning source or build failure, then re-promote a previously proven Freight through
Kargo. Do not patch a live Deployment, run `argocd app sync`, or create a manifest-bump PR.

Direct deployment is a break-glass action only when explicitly authorized and recorded with the incident. Restore Kargo
control after the incident. Bayn is not Kargo-enrolled and remains subject to its `bayn-release` activation and lineage
authority; an image digest alone never authorizes strategy promotion.

## New application enrollment

Add a main-only immutable image publisher, one Warehouse, one Stage with an exact Git branch and digest/build metadata
update contract, an exact automatic policy, and the target Application's `kargo.akuity.io/authorized-stage` annotation.
Configure promotion to update the source files consumed by the Application's existing renderer and prove the rendered
output contains the promoted digest; do not replace a working renderer as part of enrollment.
