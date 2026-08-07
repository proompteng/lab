# Cluster application upgrades — August 2026

This runbook controls the staged upgrade campaign for enabled applications in the `galactic-lan` cluster. Changes
must merge to `main` and reconcile through Argo CD; do not apply rendered manifests directly.

## Wave 1: patch-level applications

| Application              | From                             | To                               | Reconciliation | Expected impact                                                                                                        |
| ------------------------ | -------------------------------- | -------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Argo Rollouts            | chart 2.41.0 / app 1.9.0         | chart 2.41.1 / app 1.9.1         | Manual         | Controller restart; existing Rollouts continue reconciling.                                                            |
| Argo Workflows           | chart 1.0.18 / app 4.0.6         | chart 1.0.23 / app 4.0.8         | Manual         | CRDs update before controller/server restart; running workflow Pods are not replaced.                                  |
| Buzz                     | chart 0.1.6                      | chart 0.1.7                      | Manual         | Single application Pod rolls; expect a brief API interruption.                                                         |
| ClickHouse Operator      | 0.27.1                           | 0.27.2                           | Manual         | Operator restart only; no ClickHouseInstallation changes are included.                                                 |
| Forgejo                  | chart 17.1.1 / app 15.0.3        | chart 17.1.4 / app 15.0.6        | Manual         | Single application Pod rolls and may run patch-level database migrations.                                              |
| Istio system and ingress | 1.30.2                           | 1.30.3                           | Automatic      | Control-plane, CNI, local gateway, and ingress gateway roll; data-plane workloads remain compatible during patch skew. |
| Kubernetes Reflector     | 10.0.55                          | 10.0.63                          | Automatic      | Secret/config reflection pauses only while the controller Pod rolls.                                                   |
| pgAdmin                  | chart 1.65.0 / app 9.16          | chart 1.66.0 / app 9.17          | Manual         | Single Pod rolls; active UI sessions disconnect.                                                                       |
| Sealed Secrets           | chart 2.19.0 / controller 0.38.1 | chart 2.19.1 / controller 0.38.4 | Automatic      | Controller and web UI roll; the existing sealing keys must remain unchanged.                                           |
| Tailscale Operator       | 1.98.4                           | 1.98.9                           | Automatic      | Operator Pod rolls; existing proxy StatefulSets and established data paths remain in place.                            |
| Traefik                  | chart 41.0.1 / app 3.7.5         | chart 41.1.1 / app 3.7.9         | Automatic      | Ingress controller rolls with multiple replicas; watch external routing throughout.                                    |

The six automatic applications reconcile as soon as Argo observes the merged revision. Their upgrades are patch-level
and tolerate temporary old/new version skew. Do not start the manual group until every automatic application is
`Synced` and `Healthy` at the merged revision.

### Recorded pre-merge baseline

The following baseline was captured at `2026-08-07T08:34:01Z`, before PR #13560 merged, while every target still ran
revision `bb0230cd2f2bad537c3511a7916323458df3478f`.

- Nodes `talos-192-168-1-194`, `talos-192-168-1-85`, and `turin` were `Ready` on Kubernetes `v1.35.0`.
- All target applications were `Synced` and `Healthy` except Buzz, which was `OutOfSync` and `Healthy` only because of
  the retained `Backup` `buzz-db-acceptance-20260723t091130z`.
- The only failing or unready workloads were two existing failed Synthesis Jobs,
  `autonomous-trader-market-open-qbfz7-job-6x54s` and `autonomous-trader-scorecard-readback-c9qck-job-8qwpp`, and the
  existing unready Torghut Pod `torghut-hyperliquid-runtime-54469dcc6d-6b2cp`.

The pre-merge Sealed Secrets key identities were:

| Secret name               | UID                                    |
| ------------------------- | -------------------------------------- |
| `sealed-secrets-key2cg4d` | `58e0e77f-2d16-4243-a2cd-e9896893878f` |
| `sealed-secrets-key4vts2` | `4b855a78-6cf1-40b3-b01d-fd096fdc3aa9` |
| `sealed-secrets-key5vpnp` | `74952053-0cbc-49e0-afea-5412209e3b5e` |
| `sealed-secrets-keybfnj6` | `542a97e7-89b6-4f27-b2cd-9c71896c7c11` |
| `sealed-secrets-keyh547n` | `f74b3f86-34e4-4aa8-b75d-8ce7c7d853d2` |
| `sealed-secrets-keyzrp7l` | `4eaedd2c-f0a6-40ab-b01d-27c3ee4d6c6e` |

These commands produced the baseline:

```bash
set -euo pipefail
kubectl -n default get nodes
kubectl -n argocd get applications \
  argo-rollouts argo-workflows buzz clickhouse-operator forgejo istio-ingress istio-system \
  kubernetes-reflector pgadmin sealed-secrets tailscale traefik \
  -o custom-columns=APP:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status,REVISION:.status.sync.revision
kubectl -n default get pods --all-namespaces -o json |
  jq -r '.items[]
    | select(
        .status.phase == "Pending"
        or .status.phase == "Failed"
        or .status.phase == "Unknown"
        or (
          .status.phase == "Running"
          and (((.status.containerStatuses // []) | length) == 0 or any(.status.containerStatuses[]?; .ready != true))
        )
      )
    | [.metadata.namespace,.metadata.name,.status.phase]
    | @tsv'
kubectl -n sealed-secrets get secret -l sealedsecrets.bitnami.com/sealed-secrets-key -o json |
  jq -r '.items[] | [.metadata.name,.metadata.uid] | @tsv' | sort
```

### Post-merge release gate

Immediately after merge, resolve the immutable squash commit from the reviewed PR and require it to remain the current
`main` tip before accepting the automatic group or starting any manual sync:

```bash
set -euo pipefail
git fetch --quiet origin main
upgrade_revision=$(gh pr view 13560 -R proompteng/lab --json state,mergeCommit --jq \
  'select(.state == "MERGED") | .mergeCommit.oid')
test -n "$upgrade_revision"
test "$(git rev-parse origin/main)" = "$upgrade_revision"
```

If another change has reached `main`, stop and isolate this wave behind an immutable release ref before syncing
anything. Stop if a node is no longer ready, a target application is degraded, or the phase-aware Pod query reports a
new workload beyond the recorded baseline. The Buzz backup must not be pruned by this rollout.

### Automatic group

Wait for the automatically reconciled applications, then prove their workloads completed rolling:

```bash
set -euo pipefail
git fetch --quiet origin main
upgrade_revision=$(gh pr view 13560 -R proompteng/lab --json state,mergeCommit --jq \
  'select(.state == "MERGED") | .mergeCommit.oid')
test -n "$upgrade_revision"
test "$(git rev-parse origin/main)" = "$upgrade_revision"
for upgrade_app in istio-system istio-ingress kubernetes-reflector sealed-secrets tailscale traefik; do
  argocd app wait "$upgrade_app" --sync --health --timeout 900
  test "$(kubectl -n argocd get application "$upgrade_app" -o jsonpath='{.status.sync.revision}')" = "$upgrade_revision"
done
kubectl -n istio-system rollout status deployment/istiod --timeout=10m
kubectl -n istio-system rollout status deployment/knative-local-gateway --timeout=10m
kubectl -n istio-system rollout status daemonset/istio-cni-node --timeout=10m
kubectl -n istio-ingress rollout status deployment/gateway --timeout=10m
kubectl -n kubernetes-reflector rollout status deployment/kubernetes-reflector --timeout=10m
kubectl -n sealed-secrets rollout status deployment/sealed-secrets --timeout=10m
kubectl -n sealed-secrets rollout status deployment/sealed-secrets-web --timeout=10m
kubectl -n tailscale rollout status deployment/operator --timeout=10m
kubectl -n traefik rollout status deployment/traefik --timeout=10m
```

Compare the Sealed Secrets key name/UID output with the recorded pre-merge baseline. Stop before the manual group if
any key was replaced, routing regressed, or an application is not healthy.

### Manual group

Sync and verify one application at a time. `--prune=false` prevents this upgrade from deleting unrelated live objects.

```bash
set -euo pipefail
git fetch --quiet origin main
upgrade_revision=$(gh pr view 13560 -R proompteng/lab --json state,mergeCommit --jq \
  'select(.state == "MERGED") | .mergeCommit.oid')
test -n "$upgrade_revision"
test "$(git rev-parse origin/main)" = "$upgrade_revision"
argocd app sync argo-rollouts --revision "$upgrade_revision" --prune=false --timeout 600
argocd app wait argo-rollouts --sync --health --timeout 600
kubectl -n argo-rollouts rollout status deployment/argo-rollouts --timeout=10m

argocd app sync argo-workflows --revision "$upgrade_revision" --prune=false --timeout 600
kubectl -n argo-workflows wait --for=condition=complete job/argo-workflows-crd-install --timeout=5m
argocd app wait argo-workflows --sync --health --timeout 600
kubectl -n argo-workflows rollout status deployment/argo-workflows-server --timeout=10m
kubectl -n argo-workflows rollout status deployment/argo-workflows-workflow-controller --timeout=10m

argocd app sync clickhouse-operator --revision "$upgrade_revision" --prune=false --timeout 600
argocd app wait clickhouse-operator --sync --health --timeout 600
kubectl -n clickhouse-operator rollout status deployment/clickhouse-operator-altinity-clickhouse-operator --timeout=10m

for upgrade_app in forgejo pgadmin buzz; do
  argocd app sync "$upgrade_app" --revision "$upgrade_revision" --prune=false --timeout 600
  argocd app wait "$upgrade_app" --health --timeout 600
done
kubectl -n forgejo rollout status deployment/forgejo --timeout=10m
kubectl -n pgadmin rollout status deployment/pgadmin --timeout=10m
kubectl -n buzz rollout status deployment/buzz --timeout=10m
```

Buzz is expected to remain `OutOfSync` only for the retained one-off `Backup`. Any additional drift is a failure.

### Acceptance

- All target applications are healthy and use `upgrade_revision`; Buzz has only its documented retained backup drift.
- Every upgraded controller and application workload is available with no new restarts or crash loops.
- Sealed Secrets key names and UIDs are unchanged, and an existing `SealedSecret` remains decrypted.
- Existing Istio/Traefik routes, Tailscale ingress, Forgejo, pgAdmin, Buzz, and the Argo UIs respond normally.
- No ClickHouseInstallation, database cluster, PVC, or user workload was recreated.

Repeat the recorded application, phase-aware Pod, and Sealed Secrets key queries after the manual group and compare
them with the pre-merge baseline above.

### Rollback

Revert the wave-one commit through a reviewed pull request. Automatic applications will reconcile the revert; sync the
manual applications to the revert revision in reverse order with `--prune=false`. Stop before rolling Forgejo back if
its logs report a database migration that is not backward compatible; use the existing CNPG recovery procedure instead
of attempting an in-place database downgrade. Retain newer CRDs during controller rollback and never delete Sealed
Secrets keys, CNPG backups, PVCs, or the documented Buzz backup.
