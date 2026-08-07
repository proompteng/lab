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
- All target applications were `Synced` and `Healthy` except Buzz. Argo reported the desired one-shot `Backup`
  `buzz-db-acceptance-20260723t091130z` as missing; a direct API read confirmed that the object was absent live.
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
new workload beyond the recorded baseline.

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
  test "$(kubectl -n argocd get application "$upgrade_app" \
    -o jsonpath='{.status.operationState.syncResult.revision}')" = "$upgrade_revision"
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
any key was replaced, routing regressed, or an application is not healthy. Lovely-rendered applications report the
rendered content revision in `.status.sync.revision`; the immutable Git revision used for the operation is
`.status.operationState.syncResult.revision`.

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

for upgrade_app in forgejo pgadmin; do
  argocd app sync "$upgrade_app" --revision "$upgrade_revision" --prune=false --timeout 600
  argocd app wait "$upgrade_app" --health --timeout 600
done
kubectl -n forgejo rollout status deployment/forgejo --timeout=10m
kubectl -n pgadmin rollout status deployment/pgadmin --timeout=10m
```

Do not repeat the Wave-one Buzz sync. Its historical one-shot `Backup` was still declared in Git, so the original sync
at `2026-08-07T08:53:18Z` recreated the absent request and completed a new object-store backup with ID
`20260807T085319`. Wave 2 removes the stale declaration and prunes only the completed Kubernetes request object.

### Acceptance

- All target applications are healthy and used `upgrade_revision` for their successful sync operation.
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
Secrets keys, object-store backup contents, or PVCs. Do not restore the stale Buzz one-shot `Backup` declaration.

## Wave 2: identity and metrics controllers

| Application                | From                  | To                    | Reconciliation | Expected impact                                                                                   |
| -------------------------- | --------------------- | --------------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| cert-manager               | chart/app `v1.20.3`   | chart/app `v1.21.1`   | Automatic      | CRDs update first; controller, cainjector, and webhook Pods roll without reissuing certificates.  |
| External Secrets Operator  | chart/app `2.7.0`     | chart/app `2.8.0`     | Automatic      | Controller, certificate controller, and webhook Pods roll; generated Secrets remain in place.     |
| Metrics Server             | upstream tag `v0.8.1` | upstream tag `v0.9.0` | Automatic      | Both HA replicas roll; the aggregated Metrics API may be briefly unavailable during convergence.  |
| Buzz desired-state cleanup | completed one-shot CR | declaration removed   | Manual prune   | Delete only the completed Kubernetes backup request; object-store data remains retention-managed. |

The cluster runs Kubernetes `v1.35.0`, within cert-manager 1.21's supported and tested `1.33`–`1.36` range. The
[cert-manager 1.21 release notes](https://cert-manager.io/docs/releases/release-notes/release-notes-1.21/) remove the
chart's default TokenRequest RBAC and three metrics override keys. No live Issuer references a service account and the
repository does not set the removed metrics keys; the rendered identity diff removes only that Role and RoleBinding.
[External Secrets 2.8](https://github.com/external-secrets/external-secrets/releases/tag/v2.8.0) retains the
`external-secrets.io/v1` APIs and 1Password provider used here and adds one unrelated GitLab generator CRD.
[Metrics Server v0.9.0](https://github.com/kubernetes-sigs/metrics-server/releases/tag/v0.9.0) is pinned to signed tag
commit `2a7c4b2c7d46552ff47f4aeaa3a735c582587ecd`; the existing HA overlay and `--kubelet-insecure-tls` patch still
render.

### Recorded pre-merge baseline

The following baseline was captured at `2026-08-07T08:58:27Z` before Wave 2 merged:

- `cert-manager`, `external-secrets`, and `metrics-server` were `Synced` and `Healthy`.
- cert-manager controller `v1.20.3` was ready with 8 historical restarts, cainjector with 370, and webhook with 0.
- External Secrets `v2.7.0` had two ready main controllers with 85 and 130 historical restarts, one ready certificate
  controller with 110, and two ready webhooks with 0. The new Pods must start with zero restarts.
- Metrics Server had two ready `v0.8.1` replicas with zero restarts. APIService `v1beta1.metrics.k8s.io` was available,
  and `kubectl top nodes` returned all three nodes.
- Every ClusterIssuer and Certificate was ready. Both 1Password ClusterSecretStores and the ExternalSecret canary were
  ready.
- The phase-aware fleet query returned only the two pre-existing failed Synthesis Jobs recorded in Wave 1.

The identities that must survive the rollout are:

| Resource                                  | UID                                    |
| ----------------------------------------- | -------------------------------------- |
| ClusterIssuer `knative-selfsigned-issuer` | `e716aa1d-ca3f-4565-a6e2-7e932dfc234f` |
| ClusterIssuer `letsencrypt-prod`          | `c44486b8-3a73-4f66-aeb8-42d3fea4a333` |
| ClusterSecretStore `onepassword-infra`    | `02f6b066-384a-47da-b2e4-61d94bd1ff25` |
| ClusterSecretStore `onepassword-media`    | `27071cf8-f8c3-4ef2-b722-033249707ae2` |
| ExternalSecret `external-secrets-canary`  | `b74f3c72-54c6-414f-ab03-b04d46d8c7a4` |
| APIService `v1beta1.metrics.k8s.io`       | `c7c0bdc8-f48b-4154-83fb-2b7b6ec6f0d7` |
| CNPG Cluster `buzz-db`                    | `2c3316a7-3261-4b61-b467-b413e6f66bb7` |
| PVC `buzz-redis-buzz-redis-0`             | `cdfe6189-3001-445e-9828-e7611c11f7ae` |
| PVC `buzz-db-1`                           | `3983a356-765b-4294-b0fd-0ad4b736c014` |
| PVC `buzz-db-2`                           | `30cb1b05-79fc-40ed-9d67-b552849cf8ed` |
| PVC `buzz-db-3`                           | `2d93ff4e-6c1b-46c1-8c6b-108bd654874f` |

Wave-one reconciliation recreated `Backup/buzz-db-acceptance-20260723t091130z` as UID
`3564b2e9-9f13-414d-88e5-6650baec24c3`. It completed at `2026-08-07T08:53:23Z` with backup ID
`20260807T085319`. `ObjectStore/buzz-db` retains object-store backups for `14d`; removing the completed `Backup`
request does not alter that retention policy.

### Post-merge release gate

Resolve the reviewed Wave-two squash commit and require it to be the immutable `main` tip before acceptance:

```bash
set -euo pipefail
git fetch --quiet origin main
upgrade_revision=$(gh pr view codex/cluster-app-upgrades-wave2-controllers -R proompteng/lab \
  --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')
test -n "$upgrade_revision"
test "$(git rev-parse origin/main)" = "$upgrade_revision"
metrics_revision=$(git ls-remote https://github.com/kubernetes-sigs/metrics-server.git refs/tags/v0.9.0 |
  cut -f1)
test "$metrics_revision" = 2a7c4b2c7d46552ff47f4aeaa3a735c582587ecd
```

Stop if any baseline identity changes, a Certificate or secret-store resource becomes unready, the Metrics API stops
serving after convergence, or the phase-aware Pod query reports a new failure.

### Automatic controller rollout

```bash
set -euo pipefail
for upgrade_app in cert-manager external-secrets metrics-server; do
  argocd app get "$upgrade_app" --hard-refresh >/dev/null
  argocd app wait "$upgrade_app" --sync --health --timeout 900
done

for upgrade_app in cert-manager external-secrets; do
  test "$(kubectl -n argocd get application "$upgrade_app" \
    -o jsonpath='{.status.operationState.syncResult.revision}')" = "$upgrade_revision"
done
test "$(kubectl -n argocd get application metrics-server \
  -o jsonpath='{.spec.source.targetRevision}')" = v0.9.0
test "$(kubectl -n argocd get application metrics-server \
  -o jsonpath='{.status.sync.revision}')" = "$metrics_revision"

kubectl -n cert-manager rollout status deployment/cert-manager --timeout=10m
kubectl -n cert-manager rollout status deployment/cert-manager-cainjector --timeout=10m
kubectl -n cert-manager rollout status deployment/cert-manager-webhook --timeout=10m
kubectl -n external-secrets rollout status deployment/external-secrets --timeout=10m
kubectl -n external-secrets rollout status deployment/external-secrets-cert-controller --timeout=10m
kubectl -n external-secrets rollout status deployment/external-secrets-webhook --timeout=10m
kubectl -n kube-system rollout status deployment/metrics-server --timeout=10m
```

Require all certificate and secret reconciliation contracts, plus the Metrics API, to remain healthy:

```bash
set -euo pipefail
kubectl -n cert-manager get clusterissuer -o json |
  jq -e 'all(.items[]; any(.status.conditions[]?; .type == "Ready" and .status == "True"))' >/dev/null
kubectl -n default get certificate --all-namespaces -o json |
  jq -e 'all(.items[]; any(.status.conditions[]?; .type == "Ready" and .status == "True"))' >/dev/null
kubectl -n external-secrets get clustersecretstore -o json |
  jq -e 'all(.items[]; any(.status.conditions[]?; .type == "Ready" and .status == "True"))' >/dev/null
kubectl -n external-secrets get externalsecret external-secrets-canary -o json |
  jq -e 'any(.status.conditions[]?; .type == "Ready" and .status == "True")' >/dev/null
kubectl -n default get apiservice v1beta1.metrics.k8s.io -o json |
  jq -e 'any(.status.conditions[]?; .type == "Available" and .status == "True")' >/dev/null
kubectl -n default top nodes
```

### Buzz one-shot cleanup

Wait until the three automatic applications pass acceptance. Hard-refresh Buzz and require its only drift to be the
completed one-shot `Backup` before allowing prune:

```bash
set -euo pipefail
test "$(kubectl -n buzz get backup buzz-db-acceptance-20260723t091130z \
  -o jsonpath='{.status.phase}')" = completed
test "$(kubectl -n buzz get backup buzz-db-acceptance-20260723t091130z \
  -o jsonpath='{.status.backupId}')" = 20260807T085319
test "$(kubectl -n buzz get objectstore buzz-db -o jsonpath='{.spec.retentionPolicy}')" = 14d

argocd app get buzz --hard-refresh >/dev/null
buzz_drift=$(kubectl -n argocd get application buzz -o json |
  jq -r '.status.resources[] | select(.status != "Synced") | [.group,.kind,.namespace,.name] | @tsv')
test "$buzz_drift" = $'postgresql.cnpg.io\tBackup\tbuzz\tbuzz-db-acceptance-20260723t091130z'

argocd app sync buzz --revision "$upgrade_revision" --prune --timeout 600
argocd app wait buzz --sync --health --timeout 600
if kubectl -n buzz get backup buzz-db-acceptance-20260723t091130z >/dev/null 2>&1; then
  exit 1
fi
test "$(kubectl -n buzz get cluster buzz-db -o jsonpath='{.metadata.uid}')" = \
  2c3316a7-3261-4b61-b467-b413e6f66bb7
test "$(kubectl -n buzz get objectstore buzz-db -o jsonpath='{.spec.retentionPolicy}')" = 14d
```

Compare Buzz PVC UIDs with the baseline and confirm the scheduled backup resource and completed daily backups remain.
The stale on-demand request must not return on later syncs.

### Acceptance and rollback

- All three controller applications are `Synced` and `Healthy` with the intended Git or upstream tag revision.
- New controller Pods are ready with zero restarts; no webhook, APIService, or leader-election errors appear in logs.
- ClusterIssuer, Certificate, ClusterSecretStore, ExternalSecret, generated Secret, and APIService UIDs are unchanged.
- `kubectl top nodes` and a representative `kubectl top pods` request succeed after the Metrics Server rollout.
- The fleet phase-aware Pod query has no new entries, and all nodes remain ready.
- Buzz is `Synced` and `Healthy`; its stale one-shot request is absent, its CNPG/PVC identities are unchanged, and its
  scheduled backups and `14d` object-store retention remain intact.

Rollback controller versions through a reviewed revert PR. Keep the newer CRDs unless a documented incompatibility
requires a separate CRD migration; never delete certificate keys or generated Secrets. Revert Metrics Server to
`v0.8.1` only after proving the HA manifest still serves the Metrics API. The Buzz one-shot manifest must remain
removed during rollback.
