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
metrics_revision=$(git ls-remote https://github.com/kubernetes-sigs/metrics-server.git \
  'refs/tags/v0.9.0' 'refs/tags/v0.9.0^{}' |
  awk '$2 == "refs/tags/v0.9.0^{}" { peeled=$1 }
       $2 == "refs/tags/v0.9.0" { direct=$1 }
       END { print (peeled != "" ? peeled : direct) }')
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

Wave 2 completed on 2026-08-07 at merge `4813a91f8b1f4e5ac00c7562746c4651949e529b`. All three controller
applications reached `Synced/Healthy`; certificate, external-secret, generated-secret, APIService, CNPG, and PVC UIDs
were preserved. Metrics queries and the Buzz endpoint succeeded. Argo pruned only the completed one-shot `Backup`
request; the `14d` object-store retention policy and all scheduled backups remained intact.

## Wave 3: Argo control plane

Upgrade the self-managed control plane as one coordinated unit:

- Argo CD `v3.3.9` -> `v3.4.6`
- Argo CD Image Updater `v1.2.0` -> `v1.2.2`
- Lovely CMP `1.2.2` -> `1.2.5`
- Dex `v2.43.0` -> `v2.45.0`, inherited from the Argo CD HA manifest

Verified lightweight release refs:

| Release                | Commit                                     | Manifest or image evidence                                                                            |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Argo CD `v3.4.6`       | `e1becb74c728a992804d39c3ceb2e9e6ae58f0ae` | HA manifest SHA-256 `67d1513b1ec6f5265bf48bc7509f251a1ba791b22d0a40f3586fa1ce07d60465`                |
| Image Updater `v1.2.2` | `0e7ba4e51d2f8e64934f738db9f2b57274a401d3` | install manifest SHA-256 `9551f4135c714c57b0637260e2bef1b47fb081dd66c3baea5db8bd491f8af22b`           |
| Lovely `1.2.5`         | `29742c0fe861c619f7d8c1ebbbf1043478d1ce55` | multi-platform image digest `sha256:6cf1db338edda01018a623504bccb7c96e9e3b611a361a0e3942e9e2100e867b` |

The Argo CD, Dex, and Image Updater target image indexes resolve to
`sha256:6e9f4f1d646d9056c8e285495d0c8043b5f553c784181b3522ef324dcefdcc82`,
`sha256:b8469881d3cb3a73001506f0d3aaefecb9c45d2311c1e0f405d8ac538316c59d`, and
`sha256:6a61e42794105cfd0ca029068f0cfc27bc29b9882d23df7bded7fcd1e14203da`, respectively.

### Compatibility and recorded baseline

- Argo CD 3.4 is tested with Kubernetes 1.35, which matches all three nodes.
- No ApplicationSet uses the Kubernetes-version auto-label or a version selector. The 3.4 cluster-version formatting
  change therefore has no repository consumer, and the Lovely `$KUBE_VERSION` contract is unchanged upstream.
- The repository does not configure Dex preprocessing or gRPC DNS TXT service configuration. The Dex 2.45 and new
  default `GRPC_ENABLE_TXT_SERVICE_CONFIG=false` behavior require no override.
- The only Argo-specific alert uses the stable `argocd_app_info` metric, not changed OpenTelemetry semantic attributes.
- The fully rendered target contains 100 non-Namespace resources, exactly matching the 100 currently tracked resource
  identities. It renders no `Namespace` object and passes a server-side API dry-run with the Argo field manager.
- Representative pre-upgrade Lovely outputs were canonicalized as sorted JSON before hashing. The hashes were: Buzz
  `a00a13a28043cb40849b2373b0553765cbbf40295b2de78e6da76dcb6e90d921`, cert-manager
  `8103d2bf7294a7b28865b90b07af521c4753772713bb2545bb6e921ca4710348`, and Torghut
  `493015e412d88e903b152305fb5f7a7fec3744d2a657b2bc35529403f465de4d`. Raw YAML hashes are not an acceptance
  signal because serialization can differ without a manifest change.

Live identity baseline:

| Resource                             | UID                                    |
| ------------------------------------ | -------------------------------------- |
| `Application/argocd`                 | `25a2d122-ba0f-453b-b6d3-de23489bb5c6` |
| `CRD/applicationsets.argoproj.io`    | `aca1cb44-7d0d-44bd-932a-377651c53513` |
| `ApplicationSet/appset-helm`         | `e61413d8-fa0f-49b0-b00f-683d3920a9d4` |
| `ApplicationSet/bootstrap`           | `d4a4325b-37d8-4199-9c6e-4f0952ebba8f` |
| `ApplicationSet/platform`            | `df00b5f6-5927-4296-a4a0-7168e4470792` |
| `ApplicationSet/product`             | `54b89646-4a76-453d-8d36-2b2a0c0ecc9e` |
| `Secret/argocd-secret`               | `4f2bf4ad-56da-4b66-ae29-e2d1da18c8d1` |
| `Secret/argocd-notifications-secret` | `7ca5d751-9ba6-4e1f-be44-5c80ffdf4549` |
| `Secret/argocd-redis`                | `49dcecf6-65f6-4865-9543-8d41340506a2` |
| `ImageUpdater/product-image-updater` | `0a81a6c6-0653-4f91-9af5-562bb33a88e0` |

Before the upgrade, 76 of 79 Applications were synced and 77 were healthy. The exact pre-existing exceptions were:

- `agents`, `froussard`, and `oirat`: `OutOfSync/Healthy`
- `torghut`: `Synced/Degraded`
- the two previously recorded failed Synthesis Jobs

Do not attribute those conditions to this wave or sync those applications as part of the Argo rollout. The public
Argo health and Dex discovery endpoints returned HTTP 200; the in-cluster Argo server EndpointSlice had one ready
endpoint. The workstation could not resolve the private Tailscale hostname, so use in-cluster endpoint readiness as
the private-path acceptance signal.

### ApplicationSet CRD apply migration

The live ApplicationSet CRD was originally created by `kubectl-create` and subsequently updated through
`Replace=true`. Argo CD 3.3 and later require server-side apply for this CRD because client-side apply can exceed the
annotation size limit. Before syncing the control plane:

1. Replace the CRD's `Replace=true` annotation with `ServerSideApply=true`.
2. Remove the obsolete `ClientSideApplyMigration=false` workaround from the bootstrap ApplicationSet template.
3. Sync `root` first so `Application/argocd` has server-side apply enabled without the migration disablement.
4. Sync the Argo application without prune. The server-side apply must preserve the CRD UID and move field ownership
   to the Argo field manager; never delete and recreate the CRD.

### Promotion

After merge, allow only two root states: either the reviewed `ApplicationSet/bootstrap` drift is still pending, or root
already auto-synced the exact merge revision. In both cases, require the generated Argo Application to carry the new
policy before touching the control plane:

```bash
set -euo pipefail
upgrade_revision="$(git rev-parse origin/main)"

argocd app get root --hard-refresh >/dev/null
root_drift=$(kubectl -n argocd get application root -o json |
  jq -r '.status.resources[] | select(.status != "Synced") | [.group,.kind,.namespace,.name] | @tsv')
if [[ -n "$root_drift" ]]; then
  test "$root_drift" = $'argoproj.io\tApplicationSet\targocd\tbootstrap'
  argocd app sync root --revision "$upgrade_revision" --prune=false --timeout 600
  argocd app wait root --sync --health --timeout 600
else
  test "$(kubectl -n argocd get application root -o jsonpath='{.status.sync.status}')" = Synced
  test "$(kubectl -n argocd get application root -o jsonpath='{.status.sync.revision}')" = "$upgrade_revision"
fi
for _ in {1..30}; do
  migration_disabled=$(kubectl -n argocd get application argocd -o json |
    jq -r '.spec.syncPolicy.syncOptions | index("ClientSideApplyMigration=false")')
  [[ "$migration_disabled" == null ]] && break
  sleep 2
done
test "$(kubectl -n argocd get application argocd -o json |
  jq -r '.spec.syncPolicy.syncOptions | index("ClientSideApplyMigration=false")')" = null

argocd app get argocd --hard-refresh >/dev/null
test "$(kubectl -n argocd get application argocd -o json |
  jq -r '.spec.syncPolicy.automated // "manual"')" = manual
argocd app sync argocd --revision "$upgrade_revision" --prune=false --timeout 900
argocd app wait argocd --sync --health --timeout 900
```

The Argo sync must not report a prune. If the reviewed resource-identity comparison changes after merge, stop before
syncing and re-review the exact additions and removals.

### Acceptance and rollback

- `argocd` is `Synced/Healthy` at the exact merge revision, with a successful operation revision.
- All Argo Deployments and StatefulSets complete rollout. New Argo CD containers run `v3.4.6`, Dex runs `v2.45.0`,
  Image Updater runs `v1.2.2`, and both repo-server Pods run Lovely `1.2.5` with no new restarts.
- The Application, CRD, ApplicationSet, Secret, and ImageUpdater UIDs in the baseline remain unchanged. The
  ApplicationSet CRD has `ServerSideApply=true`, no `Replace=true`, and an Argo server-side-apply managed-field entry.
- All four ApplicationSets retain their generated-resource counts. No Application, repository credential, SSO secret,
  Redis secret, or ImageUpdater target is recreated.
- Image Updater reports `Ready=True` and `Error=False`. Public health and Dex discovery return HTTP 200, the Argo
  service has a ready endpoint, and a fresh core-mode manifest request succeeds.
- Buzz, cert-manager, and Torghut canonical Lovely output hashes remain equal to the recorded baseline. The Argo
  manifest hash is expected to change because this wave changes its desired control-plane manifests.
- Application and workload health contains no new exception beyond the explicitly recorded baseline, all nodes remain
  ready, and controller/repo-server/Image Updater logs contain no new render, cache, authentication, or reconciliation
  errors.

Rollback through a reviewed revert PR and the same root-first GitOps sequence. Preserve the newer CRDs during workload
rollback unless a separate compatibility review proves a schema rollback is required. Keep server-side apply enabled;
do not restore `Replace=true` or `ClientSideApplyMigration=false`.
