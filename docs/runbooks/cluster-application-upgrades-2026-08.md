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

### Preflight

Record the baseline and exact release revision:

```bash
set -euo pipefail
git fetch --quiet origin main
upgrade_pr=13560
upgrade_revision=$(gh pr view "$upgrade_pr" -R proompteng/lab --json state,mergeCommit --jq \
  'select(.state == "MERGED") | .mergeCommit.oid')
test -n "$upgrade_revision"
test "$(git rev-parse origin/main)" = "$upgrade_revision"
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
```

Save the Sealed Secrets key identities before reconciliation:

```bash
kubectl -n sealed-secrets get secret -l sealedsecrets.bitnami.com/sealed-secrets-key -o json |
  jq -r '.items[] | [.metadata.name,.metadata.uid] | @tsv' | sort
```

Stop if nodes are not ready, a target application is already degraded, or the baseline contains an unexplained failing
workload. The `origin/main` equality check is a hard gate: if another change has reached `main`, stop and isolate this
wave behind an immutable release ref before syncing anything. Buzz's known `OutOfSync` resource is the retained one-off CNPG `Backup`
`buzz-db-acceptance-20260723t091130z`; it must not be pruned by this rollout.

### Automatic group

Wait for the automatically reconciled applications, then prove their workloads completed rolling:

```bash
set -euo pipefail
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

Compare the Sealed Secrets key name/UID output with the preflight capture. Stop before the manual group if any key was
replaced, routing regressed, or an application is not healthy.

### Manual group

Sync and verify one application at a time. `--prune=false` prevents this upgrade from deleting unrelated live objects.

```bash
set -euo pipefail
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

Repeat the preflight application and failing-Pod queries after the manual group and compare them with the baseline.

### Rollback

Revert the wave-one commit through a reviewed pull request. Automatic applications will reconcile the revert; sync the
manual applications to the revert revision in reverse order with `--prune=false`. Stop before rolling Forgejo back if
its logs report a database migration that is not backward compatible; use the existing CNPG recovery procedure instead
of attempting an in-place database downgrade. Retain newer CRDs during controller rollback and never delete Sealed
Secrets keys, CNPG backups, PVCs, or the documented Buzz backup.
