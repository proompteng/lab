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
  identities. It renders no `Namespace` object and passes a server-side API dry-run with Argo's
  `argocd-controller` field manager and server-side-apply conflict ownership behavior.
- Representative pre-upgrade Lovely outputs were canonicalized as identity-sorted JSON before hashing. The hashes
  were: Buzz `a00a13a28043cb40849b2373b0553765cbbf40295b2de78e6da76dcb6e90d921`, cert-manager
  `8103d2bf7294a7b28865b90b07af521c4753772713bb2545bb6e921ca4710348`, and Torghut
  `493015e412d88e903b152305fb5f7a7fec3744d2a657b2bc35529403f465de4d`.
- Rendering the same revision after the Lovely upgrade produced Buzz
  `bfff95b42ecef68f848696a01d0276fefeaf5b25fd1e29371c52235402804895`, cert-manager
  `8103d2bf7294a7b28865b90b07af521c4753772713bb2545bb6e921ca4710348`, and Torghut
  `95c1a7827faaa41bebc8636e5dca9516b55befabec4f2c3ec223654d4431c27a`. A two-image semantic diff against the exact
  merged source proved that both Lovely versions emitted the same 30 Buzz, 49 cert-manager, and 104 Torghut objects.
  After sorting resources by identity and removing an explicit namespace only when it equaled the Application's
  destination namespace, the old and new JSON was byte-identical. The normalized hashes were Buzz
  `faf117ca96c752cb654c53b9b7c41bccc06c5f08f25870e75fba027dbe263585`, cert-manager
  `cad3f387b857895e2f2f6c560e2c38dfb43172f13f2110c2a6dff1122d3634b7`, and Torghut
  `69647a47761849207c13b6ab2a1f65bfe100991ccf08273d8e889403b916403f` for both versions. The only changes were
  resource ordering and omission of the redundant destination namespace from five Buzz and 15 Torghut
  Helm-inflated objects; Argo resolves those objects into the Application destination namespace. Raw or merely
  identity-sorted output hashes are therefore diagnostic evidence, not a semantic acceptance gate.

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

The first control-plane sync preserved the CRD UID but used the live resource's pre-sync `Replace=true` option, so its
managed-field operation remained `Update`. The second-stage manifest sets
`ServerSideApply=true,Prune=false`: `Prune=false` permanently protects this foundational CRD, and the annotation delta
forces one more reconciliation after `Replace=true` is absent from the live resource. That reconciliation must use
server-side apply and retain the same UID.

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

If the first sync retained only an Argo `Update` managed-field entry, promote the reviewed second-stage annotation as
a separate exact revision:

```bash
set -euo pipefail
upgrade_revision="$(git rev-parse origin/main)"
crd_uid="$(kubectl get crd applicationsets.argoproj.io -o jsonpath='{.metadata.uid}')"

argocd app get argocd --hard-refresh >/dev/null
crd_drift=$(kubectl -n argocd get application argocd -o json |
  jq -r '.status.resources[] | select(.status != "Synced") | [.group,.kind,.namespace,.name] | @tsv')
test "$crd_drift" = $'apiextensions.k8s.io\tCustomResourceDefinition\t\tapplicationsets.argoproj.io'
argocd app sync argocd --revision "$upgrade_revision" --prune=false --timeout 900
argocd app wait argocd --sync --health --timeout 900

crd_json="$(kubectl get crd applicationsets.argoproj.io --show-managed-fields=true -o json)"
test "$(jq -r '.metadata.uid' <<<"$crd_json")" = "$crd_uid"
test "$(jq -r '.metadata.annotations["argocd.argoproj.io/sync-options"]' <<<"$crd_json")" = \
  'ServerSideApply=true,Prune=false'
jq -e 'any(.metadata.managedFields[]; .manager == "argocd-controller" and .operation == "Apply")' \
  <<<"$crd_json" >/dev/null
```

### Acceptance and rollback

- `argocd` is `Synced/Healthy` at the exact merge revision, with a successful operation revision.
- All Argo Deployments and StatefulSets complete rollout. New Argo CD containers run `v3.4.6`, Dex runs `v2.45.0`,
  Image Updater runs `v1.2.2`, and both repo-server Pods run Lovely `1.2.5` with no new restarts.
- The Application, CRD, ApplicationSet, Secret, and ImageUpdater UIDs in the baseline remain unchanged. The
  ApplicationSet CRD has `ServerSideApply=true,Prune=false`, no `Replace=true`, and an Argo server-side-apply
  managed-field entry.
- All four ApplicationSets retain their generated-resource counts. No Application, repository credential, SSO secret,
  Redis secret, or ImageUpdater target is recreated.
- Image Updater reports `Ready=True` and `Error=False`. Public health and Dex discovery return HTTP 200, the Argo
  service has a ready endpoint, and a fresh core-mode manifest request succeeds.
- Buzz, cert-manager, and Torghut retain equal resource counts, identities, and namespace-normalized content across
  Lovely `1.2.2` and `1.2.5`; output order and redundant destination-namespace serialization may differ. The Argo
  manifest hash is expected to change because this wave changes its desired control-plane manifests.
- Application and workload health contains no new exception beyond the explicitly recorded baseline, all nodes remain
  ready, and controller/repo-server/Image Updater logs contain no new render, cache, authentication, or reconciliation
  errors.

Rollback through a reviewed revert PR and the same root-first GitOps sequence. Preserve the newer CRDs during workload
rollback unless a separate compatibility review proves a schema rollback is required. Keep server-side apply enabled;
do not restore `Replace=true` or `ClientSideApplyMigration=false`.

Wave 3 completed on 2026-08-07 at merge `1015e6c3d7ed1793dc42fe8ee5fe23f92b10d7d0`. The ApplicationSet CRD UID,
all four ApplicationSet UIDs and generated-application counts, Argo Secrets, and the ImageUpdater resource were
preserved. The final CRD-only reconciliation used server-side apply with field manager `argocd-controller`; all Argo
workloads were ready on the target versions and the public health and Dex endpoints returned HTTP 200.

## Wave 4a: virtualization controllers and Knative operator

| Application      | From      | To        | Reconciliation | Expected impact                                                                |
| ---------------- | --------- | --------- | -------------- | ------------------------------------------------------------------------------ |
| CDI              | `v1.65.0` | `v1.66.0` | Manual         | CDI control-plane Pods roll; completed DataVolumes and their PVCs stay intact. |
| KubeVirt         | `v1.8.2`  | `v1.9.0`  | Manual         | KubeVirt control-plane Pods roll; the only VM is stopped and is not recreated. |
| Knative Operator | `v1.22.1` | `v1.23.0` | Automatic      | Operator and conversion-webhook Pods roll; Serving and Eventing remain 1.22.0. |

Verified release refs and downloaded-manifest hashes:

| Release                 | Peeled tag commit                          | Release manifest SHA-256                                                                                                                           |
| ----------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| KubeVirt `v1.9.0`       | `79d34c1762169e5b0370ec491cef5ca12e6b504c` | operator `f11307caafc3c23ffedf9887d8beb5a4419e2694da242fa68f63d1ec820de2e0`; CR `43106136dbce3312bdbfdeae612aacafc6c12da518d233f90645b4685d84a2af` |
| CDI `v1.66.0`           | `938af7c54b2491321156bad2daa707b54bbdb214` | operator `f81f2730f3404649196e9777b67a3c69fd6ea5d9eb60775dfd97ac90d2edf8e7`; CR `a497f90de608c1df26f9ee4095289373f17132d74a2042ca03e00c17c964f8a7` |
| Knative Operator `1.23` | `8f004985af79024f25b9e6014da1a4c22bf48182` | `fedbdf989590d8069a8dd29f84b8d4eb171dd3f7749b2ce32ce6de5a6cc5ae58`                                                                                 |

Validation must download the same immutable release-tag assets and verify their full hashes. All three old/new
upstream pairs preserve their resource identity sets: KubeVirt has ten rendered objects, CDI eight, and the Knative
operator 27 including its upstream Namespace.

### Compatibility and staged namespace ownership

- The [KubeVirt support matrix](https://github.com/kubevirt/sig-release/blob/main/releases/k8s-support-matrix.md)
  explicitly supports KubeVirt 1.9 on Kubernetes 1.35. The `MultiArchitecture` feature gate was deprecated in 1.8
  because the admission check was removed; Kubernetes now schedules the requested architecture directly. Removing the
  gate does not disable multi-architecture scheduling and avoids carrying a deprecated gate into 1.9.
- The KubeVirt 1.9 operator CRD still serves the live `v1` stored version and `v1alpha3`; CDI 1.66 still serves the live
  `v1beta1` stored version. No CRD storage migration is required for this wave.
- CDI 1.66 makes its metrics endpoints authenticated and creates the required metrics-reader RBAC. No repository
  scraper directly targets those endpoints. It also enables `WebhookPvcRendering` by default; the completed live
  DataVolume is not mutated or recreated.
- Knative 1.23 requires Kubernetes 1.34 or newer. The cluster runs 1.35, and the operator embeds the 1.22.0 Serving and
  Eventing manifests, so upgrading the operator alone leaves the operand versions unchanged. The operator must pass
  acceptance before Wave 4b changes either operand CR.
- The upstream Knative operator manifest currently owns `Namespace/knative`. This stage adds `Prune=false` both to the
  rendered Namespace and to ApplicationSet-managed namespace metadata. After the annotation is live, a follow-up
  change must delete the upstream Namespace from Kustomize output; never let automated prune delete the namespace.

### Recorded pre-merge baseline

The baseline was captured at `2026-08-07T10:26:07Z`. `kubevirt`, `cdi`, and `knative` were `Synced/Healthy` at
`1015e6c3d7ed1793dc42fe8ee5fe23f92b10d7d0`; the first two were manual and Knative was automatic.

| Resource                                         | UID                                    | State                    |
| ------------------------------------------------ | -------------------------------------- | ------------------------ |
| `KubeVirt/kubevirt`                              | `5aa3b3c0-ce57-4009-8cfe-d5fb03421a34` | deployed `v1.8.2`        |
| `CDI/cdi`                                        | `5824b5fe-428c-426c-8483-ddd2a8bf5af8` | deployed `v1.65.0`       |
| `VirtualMachine/openclaw`                        | `2991fc00-afe8-44d8-bc0e-7b9f3360f0d4` | stopped, `amd64`         |
| `DataVolume/openclaw-rootdisk-rbd`               | `083dcc42-e411-4c1e-85c5-a3fcdf3e27c8` | succeeded                |
| `PersistentVolumeClaim/openclaw-rootdisk-rbd`    | `339191df-569a-46e4-b4c2-d647b6313d2b` | bound                    |
| `KnativeServing/knative-serving`                 | `3726092f-a8ce-4690-9445-0b9c2968f564` | ready `1.22.0`           |
| `KnativeEventing/knative-eventing`               | `4868f9bd-a221-47d4-8366-8f6929e13395` | ready `1.22.0`           |
| `Secret/knative/operator-webhook-certs`          | `14535284-19a1-424c-9e9d-30c7bc28b8a2` | present                  |
| `Namespace/knative`                              | `b45355e7-34c7-483b-9e0f-1431571ae7f7` | source-managed           |
| `CustomResourceDefinition/kubevirts.kubevirt.io` | `2a17d2c5-bb8b-4461-b8eb-da5e30a6b87e` | stored version `v1`      |
| `CustomResourceDefinition/cdis.cdi.kubevirt.io`  | `2a8de916-a389-4e66-b188-70d909717f64` | stored version `v1beta1` |

There was no running VMI. All three nodes were ready on Kubernetes 1.35.0. The three Knative Services were ready at
revisions `froussard-00025`, `torghut-01545`, and `torghut-sim-01617`. Existing long-lived KubeVirt and CDI Pods had
historical restart counts as high as 170 and 800 respectively; compare new Pod UIDs and require zero new restarts
instead of treating those old counters as upgrade failures. The Knative operator had zero restarts and its webhook had
two historical restarts.

### Promotion

Resolve the reviewed squash commit and require it to remain the exact `main` tip. First wait for root to generate the
Knative Application namespace policy, then accept the automatic operator rollout before starting manual controllers:

```bash
set -euo pipefail
git fetch --quiet origin main
upgrade_revision=$(gh pr view codex/cluster-app-upgrades-wave4-virtualization-knative -R proompteng/lab \
  --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')
test -n "$upgrade_revision"
test "$(git rev-parse origin/main)" = "$upgrade_revision"

argocd app get root --hard-refresh >/dev/null
argocd app wait root --sync --health --timeout 600
for _ in {1..30}; do
  namespace_policy=$(kubectl -n argocd get application knative -o json |
    jq -r '.spec.syncPolicy.managedNamespaceMetadata.annotations["argocd.argoproj.io/sync-options"] // ""')
  [[ "$namespace_policy" == Prune=false ]] && break
  sleep 2
done
test "$namespace_policy" = Prune=false

argocd app get knative --hard-refresh >/dev/null
argocd app wait knative --sync --health --timeout 900
test "$(kubectl -n argocd get application knative \
  -o jsonpath='{.status.operationState.syncResult.revision}')" = "$upgrade_revision"
test "$(kubectl get namespace knative \
  -o jsonpath='{.metadata.annotations.argocd\.argoproj\.io/sync-options}')" = Prune=false
kubectl -n knative rollout status deployment/knative-operator --timeout=10m
kubectl -n knative rollout status deployment/operator-webhook --timeout=10m
```

Sync CDI first so its storage APIs are settled before the KubeVirt controller rolls. Both applications must be synced
without prune:

```bash
set -euo pipefail
argocd app sync cdi --revision "$upgrade_revision" --prune=false --timeout 900
argocd app wait cdi --sync --health --timeout 900
kubectl -n cdi wait --for=jsonpath='{.status.phase}'=Deployed cdi/cdi --timeout=10m
test "$(kubectl -n cdi get cdi cdi -o jsonpath='{.status.observedVersion}')" = v1.66.0

argocd app sync kubevirt --revision "$upgrade_revision" --prune=false --timeout 900
argocd app wait kubevirt --sync --health --timeout 900
kubectl -n kubevirt wait --for=jsonpath='{.status.phase}'=Deployed kubevirt/kubevirt --timeout=10m
test "$(kubectl -n kubevirt get kubevirt kubevirt -o jsonpath='{.status.observedKubeVirtVersion}')" = v1.9.0
test "$(kubectl -n kubevirt get kubevirt kubevirt -o json |
  jq -r '(.spec.configuration.developerConfiguration.featureGates // []) | index("MultiArchitecture")')" = null
```

### Acceptance and rollback

- All three Applications are `Synced/Healthy` at `upgrade_revision`; every new controller Pod is ready with zero
  restarts and logs contain no new webhook, reconciliation, architecture, DataVolume, or upgrade errors.
- KubeVirt and CDI report the target operator, target, and observed versions with `Available=True`,
  `Progressing=False`, and `Degraded=False`. Their CR and CRD UIDs match the baseline.
- The stopped VM, completed DataVolume, bound PVC, and underlying PV retain their UIDs and states. Starting the VM is
  outside this control-plane upgrade and must not be used as an implicit smoke test.
- The Knative operator and webhook run the 1.23 release digests, while the Serving and Eventing CRs remain ready at
  `1.22.0`. Their UIDs, the webhook certificate Secret UID, all three Knative Service UIDs, and latest-ready revisions
  remain unchanged.
- `Namespace/knative` retains its UID and has `argocd.argoproj.io/sync-options=Prune=false`. Wave 4b must not begin
  until the namespace is protected and the operator passes acceptance.
- All nodes remain ready and the phase-aware fleet query has no new exception beyond the previously recorded two
  failed Synthesis Jobs and Torghut's pre-existing degraded Application health.

Rollback through a reviewed revert PR, in reverse order, with no prune. Preserve newer CRDs and never delete the VM,
DataVolume, PVC, PV, Knative CRs, webhook certificates, or namespace. Keep the namespace protection annotation during
rollback. Do not roll the operator below 1.23 after a Wave 4b operand upgrade unless the restored operator embeds and
supports the target operand version.

Wave 4a completed on 2026-08-07 at merge `801a47bd76c7cc0a971098d2984b23fce3c3784a`. KubeVirt and CDI reported
their target and observed versions (`v1.9.0` and `v1.66.0`) with all availability conditions satisfied. The stopped VM,
completed DataVolume, PVC, PV, controller CRs, and CRDs retained their recorded UIDs. Knative's namespace, operator
webhook certificate, Serving and Eventing CRs, and all three Knative Services retained their UIDs; the operands stayed
ready at 1.22. Every replacement Pod was ready with zero restarts.

KubeVirt 1.9 deliberately removes the legacy `kubevirt-virt-handler-certs` mount after every handler advertises
`kubevirt.io/supports-migration-cn-types=true` and receives `--migration-cn-types migration`; upstream PR 15949 calls
this the final migration-certificate transition. The unused legacy file watcher consequently logs a missing-file error
once per minute. The active `kubevirt-virt-handler-migration-client-certs` mount and certificate were present on all
three handlers, no other error recurred after startup, all handlers were ready with zero restarts, and KubeVirt remained
`Available=True`, `Progressing=False`, and `Degraded=False`. Treat only that exact legacy watcher message as an accepted
upstream diagnostic until KubeVirt removes the unused manager.

## Wave 4 namespace management handoff

Wave 4a first placed `argocd.argoproj.io/sync-options=Prune=false` on both the source and live namespace. The handoff then
removes the upstream `Namespace` from rendered output and retains ApplicationSet-managed namespace metadata. Argo CD
3.4's managed-namespace implementation always replaces that annotation value with `ServerSideApply=true`; it cannot
combine a caller-provided `Prune=false` value. The generated namespace remains safe because Argo does not resource-track
it unless a tracking annotation is explicitly added. Keep `argocd.argoproj.io/tracking-id` absent, assert that the
Application has no Namespace in `status.resources`, and use the standard managed-by label as the metadata-management
receipt. This change must not roll a Knative workload or custom resource.

```bash
set -euo pipefail
git fetch --quiet origin main
upgrade_revision=$(gh pr view codex/cluster-app-upgrades-wave4-knative-namespace -R proompteng/lab \
  --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')
test -n "$upgrade_revision"
test "$(git rev-parse origin/main)" = "$upgrade_revision"

argocd app get root --hard-refresh >/dev/null
argocd app wait root --sync --health --timeout 600
argocd app get knative --hard-refresh >/dev/null
argocd app wait knative --sync --health --timeout 900
test "$(kubectl -n argocd get application knative \
  -o jsonpath='{.status.operationState.syncResult.revision}')" = "$upgrade_revision"
test "$(kubectl get namespace knative -o jsonpath='{.metadata.uid}')" = b45355e7-34c7-483b-9e0f-1431571ae7f7
test "$(kubectl get namespace knative \
  -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}')" = argocd
test "$(kubectl get namespace knative \
  -o jsonpath='{.metadata.annotations.argocd\.argoproj\.io/sync-options}')" = ServerSideApply=true
test -z "$(kubectl get namespace knative \
  -o jsonpath='{.metadata.annotations.argocd\.argoproj\.io/tracking-id}')"
test "$(kubectl -n argocd get application knative -o json |
  jq '[.status.resources[] | select(.kind == "Namespace")] | length')" = 0
```

Acceptance requires the Knative Application to be `Synced/Healthy` at the exact merge revision, the rendered target to
contain no `Namespace`, the live namespace UID to remain unchanged, the managed-by and server-side-apply metadata to be
present without a tracking annotation, and all Knative operator, Serving, Eventing, and Service identities and readiness
states to remain unchanged. Roll back by restoring the protected source Namespace; never delete or recreate the live
namespace.

The namespace management handoff completed on 2026-08-07 at merge
`5984b9d7a2e31e24562ddd58d59c3b23bca15bc4`. The namespace retained UID
`b45355e7-34c7-483b-9e0f-1431571ae7f7`, gained `app.kubernetes.io/managed-by=argocd`, retained Argo's generated
`ServerSideApply=true` marker, and had no tracking annotation. The Application reported no Namespace in
`status.resources`. Both operator Pods retained their UIDs and zero restart counts; all Knative operand and Service
identities and readiness states were unchanged.

## Wave 4b: Knative Serving

| Application     | From     | To       | Reconciliation | Expected impact                                                        |
| --------------- | -------- | -------- | -------------- | ---------------------------------------------------------------------- |
| Knative Serving | `1.22.0` | `1.23.0` | Automatic      | Serving and net-istio control-plane Pods roll; user revisions persist. |

Knative Serving 1.23.0 is the current upstream release. Its peeled tag commit is
`7ed4aa2ab601e3a33c6552285f6e0d910747351d`; release asset hashes are
`b172ff4901ed50f8e4e09ff8616e54d22e264df7086ce8cb74f513a04812fe74` for `serving-crds.yaml`,
`be3f16c9c0ac9276cc173ef04871aaeac78537f9edb116310caa02f016e9cbc2` for `serving-core.yaml`, and
`07d412839ff834de8a14903d51175383d8f3f1d682805325840493f165eef53b` for `serving-hpa.yaml`. The 1.23
`net-istio.yaml` hash is `74fe1afaf2f7ec714f92d085a4211d54fde87bc6c5502538c07d9cf7cf01751e`.
The old and new Serving asset sets each contain the same 61 resource identities; both net-istio releases contain the
same 13 identities. No object replacement is expected.

The pre-merge Serving CR UID is `3726092f-a8ce-4690-9445-0b9c2968f564`. All seven control-plane Deployments were
available at five replicas. The three Services, Routes, and Configurations were ready at revisions `froussard-00025`,
`torghut-01545`, and `torghut-sim-01617`; `https://froussard.proompteng.ai` returned HTTP 200. Preserve the five
Serving CRDs and user-facing identities below.

| Resource                                                           | UID                                    | Stored version or state   |
| ------------------------------------------------------------------ | -------------------------------------- | ------------------------- |
| Deployment `knative-serving/activator`                             | `93b7e990-ebca-4c06-9e82-70a5e4c3ca47` | five ready replicas       |
| Deployment `knative-serving/autoscaler`                            | `9f830a5e-fdcb-4d88-9d4a-49f697673c57` | five ready replicas       |
| Deployment `knative-serving/autoscaler-hpa`                        | `1acc84f2-54ff-4040-ad70-bdfc1ebb1e69` | five ready replicas       |
| Deployment `knative-serving/controller`                            | `fe822778-eab9-468c-a3b2-36865b4a06f6` | five ready replicas       |
| Deployment `knative-serving/net-istio-controller`                  | `26033def-50ed-44d4-b547-0d2714d218d9` | five ready replicas       |
| Deployment `knative-serving/net-istio-webhook`                     | `88bdf8cc-58db-496f-820d-f1029b281a2f` | five ready replicas       |
| Deployment `knative-serving/webhook`                               | `94e278b6-6a14-4b1e-b83b-2048f23ece4c` | five ready replicas       |
| CRD `configurations.serving.knative.dev`                           | `53429658-026b-437f-9890-7b7dfa357ebd` | `v1`                      |
| CRD `domainmappings.serving.knative.dev`                           | `8421d3fb-c3b5-4190-81be-3abf310f48f5` | `v1beta1`                 |
| CRD `revisions.serving.knative.dev`                                | `77daef6d-fc0a-48bd-b6e3-20e84f1018a7` | `v1`                      |
| CRD `routes.serving.knative.dev`                                   | `a57ac078-7437-4f1f-92de-52d64721a70b` | `v1`                      |
| CRD `services.serving.knative.dev`                                 | `9cec4931-03c0-4faa-9ca2-35b9f405ad30` | `v1`                      |
| KService `froussard/froussard`                                     | `302afcd9-5f4e-4ed7-ac7c-e89aa0db665e` | ready `froussard-00025`   |
| KService `torghut/torghut`                                         | `4e723125-fa71-46d4-b300-55e0169952e5` | ready `torghut-01545`     |
| KService `torghut/torghut-sim`                                     | `4a17ef99-f94d-4dd9-860f-3c26a484aa82` | ready `torghut-sim-01617` |
| Revision `froussard/froussard-00025`                               | `075d2b31-ba1f-454b-806e-97b3093c0b4b` | ready                     |
| Revision `torghut/torghut-01545`                                   | `551aa2d2-867a-48c0-8b96-713617039fec` | ready                     |
| Revision `torghut/torghut-sim-01617`                               | `a2b7ed65-bc6f-45ef-a604-866680bdd3af` | ready                     |
| Certificate `froussard/route-d6056a74-af3a-477f-bf21-c947784e55f5` | `28dccf3a-bc7f-4002-9669-dfff533a5e26` | ready                     |
| TLS Secret `froussard/route-d6056a74-af3a-477f-bf21-c947784e55f5`  | `dfa5ddc5-f8ed-4142-af37-937bbf8bd5ea` | present                   |

```bash
set -euo pipefail
git fetch --quiet origin main
upgrade_revision=$(gh pr view codex/cluster-app-upgrades-wave4-knative-serving -R proompteng/lab \
  --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')
test -n "$upgrade_revision"
test "$(git rev-parse origin/main)" = "$upgrade_revision"

argocd app get knative-serving --hard-refresh >/dev/null
argocd app wait knative-serving --sync --health --timeout 1200
test "$(kubectl -n argocd get application knative-serving \
  -o jsonpath='{.status.operationState.syncResult.revision}')" = "$upgrade_revision"
kubectl -n knative-serving wait --for=jsonpath='{.status.version}'=1.23.0 \
  knativeserving/knative-serving --timeout=15m
for deployment_name in activator autoscaler autoscaler-hpa controller net-istio-controller net-istio-webhook webhook; do
  kubectl -n knative-serving rollout status "deployment/$deployment_name" --timeout=15m
done
curl -fsS -o /dev/null https://froussard.proompteng.ai
```

Acceptance requires the Application to be `Synced/Healthy` at the exact merge revision and the Serving CR to retain its
UID while reporting Ready at 1.23.0. All seven Deployment UIDs, five Serving CRD UIDs and stored versions, and all user
Service, Route, Configuration, revision, Certificate, and Secret identities must remain unchanged. Every replacement
control-plane Pod must be ready with zero restarts, all three Services must retain their latest-ready revisions, and the
external Froussard route must still return HTTP 200. Roll back the version field through a reviewed revert only if the
1.23 control plane has not written incompatible state; preserve the newer CRDs and all user workloads during rollback.

Wave 4b completed on 2026-08-07 at merge `f129d8496da59f3b187053c821a69e07cf070c85`. The Serving CR, all seven
Deployment UIDs, five CRD UIDs and stored versions, the three Services and latest-ready Revisions, and the Froussard TLS
Certificate and Secret retained their identities. All 35 replacement control-plane Pods were ready at 1.23.0 with zero
restarts; the cleanup and storage-version migration Jobs each succeeded once. Transient Activator probe failures during
the rolling cutover stopped after the old Pods terminated. The Froussard route continued to return HTTP 200.

## Wave 4c: Knative Eventing and Kafka source

| Application                       | From     | To       | Reconciliation | Expected impact                                                     |
| --------------------------------- | -------- | -------- | -------------- | ------------------------------------------------------------------- |
| Knative Eventing                  | `1.22.0` | `1.23.0` | Automatic      | Eventing control-plane Pods roll; event resources retain identity.  |
| Knative Kafka controller + source | `1.22.0` | `1.23.0` | Automatic      | Kafka controllers and source dispatcher roll without data deletion. |

The 1.23 releases are the current upstream versions. The peeled tag commits are
`d6139ffb2175b4a7387f56a8b2c589a17c631719` for Eventing and
`2dcdd7c72a3d856ba137cef5a3a5c0a6d55fe58f` for eventing-kafka-broker. Relevant asset hashes are:

| Asset                            | SHA-256                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `eventing-crds.yaml`             | `20da395bc5a1de2633907d229180a1db3dd4a53fae541c24c6719de0adba8fb8` |
| `eventing-core.yaml`             | `9af6b3e7a7ae7e26de0018806226d044c0e5ff2612c1530ddc3f413e77b0b42b` |
| `in-memory-channel.yaml`         | `5ccc661337215e5b773648223bbf899c74fb316120983bd2c074c90db08c4c4d` |
| `mt-channel-broker.yaml`         | `2cd56ab5cbd40ab5c11c3019a88c78c6b9df9deb44732dfbed15f638818584a3` |
| `eventing-tls-networking.yaml`   | `03c9486b49baf7efe15b1861a9c9de4ed564ee4328fd00751459d5d659000fea` |
| `eventing-post-install.yaml`     | `61c043d7713279df917c9657e1a2e063c3f107fe50ef905cc1af1f52ad2e6688` |
| `eventing-kafka-controller.yaml` | `d969623c82ee2de280c4bd10cfedc9b9aa472e29b7553e659b7294793643d46c` |
| `eventing-kafka-source.yaml`     | `64140e65c596490efcfa9872c07ede70711e99ecd41ae111dd06cf21f8cde129` |

The old and new Eventing asset sets each contain the same 154 resource identities; the direct Kafka controller/source
sets each contain the same 35. The Kafka release includes dependency security fixes. The Kustomization also migrates the
existing namespace-selector overlay from deprecated `patchesStrategicMerge` syntax to the equivalent `patches` path.

The pre-merge Eventing CR UID is `4868f9bd-a221-47d4-8366-8f6929e13395`. The canonical identity receipt for its 11
Deployments and two StatefulSets is `aab969ab26d5263161a8cf2a6c5e395d3795042f64f85bf3b9d680dea9636024`; the
23 Eventing/Kafka CRD names, UIDs, and stored versions hash to
`f8504329f7bc06269a0644618fbe88545a2ee5fb38040962fa25bca4dd2bec2e`. The only live user Eventing objects are:

| Resource                                                     | UID                                    | State |
| ------------------------------------------------------------ | -------------------------------------- | ----- |
| KafkaSource `agents/agents-codex-github-events`              | `fc3ce8dd-f96f-4a83-9569-c7413489f963` | Ready |
| ConsumerGroup `agents/fc3ce8dd-f96f-4a83-9569-c7413489f963`  | `35e2cbe6-dd85-42c5-b12e-63aae471fa56` | Ready |
| Consumer `agents/fc3ce8dd-f96f-4a83-9569-c7413489f963-kfffw` | `f3110801-0c0a-49cc-a515-e7e0b1375572` | Ready |

```bash
set -euo pipefail
git fetch --quiet origin main
upgrade_revision=$(gh pr view codex/cluster-app-upgrades-wave4-knative-eventing -R proompteng/lab \
  --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')
test -n "$upgrade_revision"
test "$(git rev-parse origin/main)" = "$upgrade_revision"

argocd app get knative-eventing --hard-refresh >/dev/null
argocd app wait knative-eventing --sync --health --timeout 1200
test "$(kubectl -n argocd get application knative-eventing \
  -o jsonpath='{.status.operationState.syncResult.revision}')" = "$upgrade_revision"
kubectl -n knative-eventing wait --for=jsonpath='{.status.version}'=1.23.0 \
  knativeeventing/knative-eventing --timeout=15m
kubectl -n agents wait --for=condition=Ready kafkasource/agents-codex-github-events --timeout=15m
```

Acceptance requires the Application to be `Synced/Healthy` at the exact merge revision and the Eventing CR to retain
its UID while reporting Ready at 1.23.0. Recompute both canonical identity receipts and require exact matches, require
all 12 desired control-plane Pods to be ready on 1.23 with zero restarts, and require successful cleanup/storage-version
migration Jobs. The KafkaSource, ConsumerGroup, and Consumer must retain their UIDs and Ready conditions. The Kafka
source dispatcher must remain ready, the patched mutating webhook must stay scoped to `knative-eventing`, and no new
recurring controller error may remain after startup. Roll back the version and release URLs only through a reviewed
revert; preserve newer CRDs and all Eventing objects during rollback.

Wave 4c completed on 2026-08-07 at merge `0abc1164f89b15abf9be3b738b1234cd95b262b3`. The Eventing CR, all 13
Deployment and StatefulSet identities, all 23 CRD UIDs and stored versions, and the KafkaSource, ConsumerGroup, and
Consumer UIDs were preserved. All desired 1.23 Pods became ready with zero restarts and the storage-version migration
Job succeeded. The Kafka controller continues to report absent `kafka-broker-dispatcher` and
`kafka-channel-dispatcher` StatefulSets because this cluster intentionally installs only the Kafka source plane; the
same upstream scheduler code and log behavior exist in 1.22 and 1.23. The source dispatcher also continues to receive
HTTP 422 for unsupported event types on the shared GitHub webhook topic. The Agents handler's only 422 path deliberately
rejects unsupported event types and predates this upgrade; the Ready source continues to advance offsets. Neither
recurring message is a 1.23 regression or a reason to install unused broker/channel operands.

## Wave 5a: Alloy and kube-state-metrics

| Application                                 | From               | To                 | Reconciliation | Expected impact                                                                        |
| ------------------------------------------- | ------------------ | ------------------ | -------------- | -------------------------------------------------------------------------------------- |
| Alloy collectors in 10 enabled applications | `1.11.2`           | `1.18.1`           | Mixed          | Collector Pods roll independently; application workloads do not roll.                  |
| Observability kube-state-metrics chart      | `7.3.0` / `2.18.0` | `8.2.0` / `2.19.1` | Automatic      | One metrics Pod rolls in place; metric objects and custom state configuration persist. |

Alloy 1.18.1 is the current upstream release and includes backported fixes for GO-2026-6061 and GO-2026-5970. Its
multi-architecture image index digest is `sha256:0f4434c92b3e6cdac38bb129b344e1790c246f7b6e2eaffcc16a5fa363240e33`
and contains both `linux/amd64` and `linux/arm64`, matching the cluster nodes. Every enabled River configuration validates
with the target 1.18.1 binary. The documented 1.12 exporter label change does not apply because none of these configs
uses the blackbox, SNMP, or StatsD exporters. The disabled `facteur` and `graf` applications remain untouched.

Kube-state-metrics chart 8.2.0 packages app 2.19.1. Rendering 7.3.0 and 8.2.0 with the repository values produces the
same six resource identities, with canonical identity hash
`40556a2d2f8da5bc60acee4c791bbbc2d317797425a3b45758dbc6efce91bb81`, and the Deployment selector is unchanged.
The configured collector list and custom Argo CD and CloudNativePG state metrics remain explicit and unchanged.

Preserve these pre-merge Deployment identities:

| Deployment                                          | UID                                    |
| --------------------------------------------------- | -------------------------------------- |
| `agents/agents-alloy`                               | `a3ba02f7-cd9c-40a1-b441-e95915e1186b` |
| `argo-workflows/argo-workflows-alloy`               | `bdb9460b-a043-4f9a-b1e3-abc4a9855f93` |
| `argocd/argocd-alloy`                               | `1ec0c154-b891-4df8-8a80-e05845d4de46` |
| `bilig/bilig-alloy`                                 | `936b4cd8-f601-4de0-b5a7-f96f497154a1` |
| `buzz/buzz-alloy`                                   | `081cfbd5-3483-44ab-a4d5-80844614678c` |
| `jangar/jangar-alloy`                               | `a4d52115-fcd4-4744-a65d-d7e707293043` |
| `nats/nats-alloy`                                   | `e1eba73d-67a7-416c-af2c-ff0d3f3e6d47` |
| `observability/observability-cluster-metrics-alloy` | `b02148f1-7308-4e34-82ec-bc606e6a99e1` |
| `observability/observability-kube-state-metrics`    | `e244832b-9bac-47c6-aa29-1a6da041a481` |
| `oirat/oirat-alloy`                                 | `c8d9cdec-e4aa-4bea-9368-a2e4b7e665a1` |
| `torghut/torghut-alloy`                             | `ebd469eb-065d-4ad3-a46c-27b052e77d19` |

```bash
set -euo pipefail
git fetch --quiet origin main
upgrade_revision=$(gh pr view codex/cluster-app-upgrades-wave5-observability -R proompteng/lab \
  --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')
test -n "$upgrade_revision"
test "$(git rev-parse origin/main)" = "$upgrade_revision"

for app in bilig jangar nats observability torghut; do
  argocd app get "$app" --hard-refresh >/dev/null
done
for app in agents argo-workflows argocd buzz oirat; do
  argocd app get "$app" --hard-refresh >/dev/null
done

argocd app sync agents --resource apps:Deployment:agents-alloy
argocd app sync argo-workflows --resource apps:Deployment:argo-workflows-alloy
argocd app sync argocd --resource apps:Deployment:argocd-alloy
argocd app sync buzz --resource apps:Deployment:buzz-alloy
argocd app sync oirat --resource apps:Deployment:oirat-alloy

for pair in \
  agents/agents-alloy \
  argo-workflows/argo-workflows-alloy \
  argocd/argocd-alloy \
  bilig/bilig-alloy \
  buzz/buzz-alloy \
  jangar/jangar-alloy \
  nats/nats-alloy \
  observability/observability-cluster-metrics-alloy \
  observability/observability-kube-state-metrics \
  oirat/oirat-alloy \
  torghut/torghut-alloy; do
  namespace=${pair%/*}
  deployment=${pair#*/}
  kubectl -n "$namespace" rollout status "deployment/$deployment" --timeout=15m
done
```

Acceptance requires every Deployment UID above to remain unchanged, every replacement Pod to be ready with zero
restarts, all Alloy containers to run 1.18.1, and kube-state-metrics to report chart 8.2.0/app 2.19.1. Validate each
Alloy readiness endpoint and require no recurring post-startup errors. Query the kube-state-metrics service through the
API proxy and require representative `kube_pod_info`, `kube_argocd_application_deployment_history_info`, and
`kube_cnpg_*` metrics. Preserve and explicitly recheck the pre-existing `agents` and `oirat` OutOfSync states and the
pre-existing `torghut` Degraded state so the targeted manual syncs do not reconcile unrelated resources. Roll back by
reviewed revert; the metrics collectors are stateless and no persisted application data is changed.

Wave 5a completed on 2026-08-07 at merge `2a470a95854fefd6c71342a4d8145a7000a42365`. All 11 Deployment UIDs
were preserved, every replacement Pod became ready with zero restarts, and every Alloy Pod reported `Alloy is ready.`
through its loopback readiness endpoint. Kube-state-metrics reported chart 8.2.0/app 2.19.1 and returned 442
`kube_pod_info`, 79 `kube_argocd_application_deployment_history_info`, and 66 `kube_cnpg_*` samples in the acceptance
snapshot. Startup reads of old container logs caused bounded Loki age-window rejects in five collectors; no error or
warning recurred in the subsequent 60-second window. All ten Applications recorded the exact merge revision;
`agents` and `oirat` retained their unrelated OutOfSync resources and `torghut` retained its pre-existing Degraded
health while returning to Synced.

## Wave 5b: Flipt, Karapace, and cloudflared

| Application       | From                          | To                 | Reconciliation | Expected impact                                                                 |
| ----------------- | ----------------------------- | ------------------ | -------------- | ------------------------------------------------------------------------------- |
| Feature flags     | chart/app `2.10.0`            | chart/app `2.11.0` | Automatic      | Recreate one Pod; retain the Git-backed flag state and existing cache PVC.      |
| Kafka Karapace    | floating `latest` (app 6.2.0) | app `6.2.2`        | Automatic      | Roll one stateless schema-registry Pod; retain the Kafka `_schemas` topic.      |
| Cloudflare tunnel | floating `latest` (2026.7.1)  | app `2026.7.3`     | Automatic      | Rolling replacement; tunnel connections drain and reconnect through Cloudflare. |

The target image indexes are pinned immutably and contain both `linux/amd64` and `linux/arm64`:

- Flipt: `sha256:d20384874048ef6ac326f4937cee64f1db175a1878a87db32916cc8db46c740e`.
- Karapace: `sha256:3c202789067f1bc3aa68d9dbb22d6298d254380a9e69c2705120c7434277238c`.
- cloudflared: `sha256:e39ee8da81ad5e05d77f38d2f51c60ca51bf2a8450ac3abab50c17fdb91d91bf`.

Flipt chart 2.10.0 and 2.11.0 render the same six resource identities with canonical identity hash
`62b2e009866b0585f5ee7bf25a413d713fe79d24b252ac182568a8c47499f53d`; the Deployment selector and Recreate strategy
are unchanged. Karapace 6.2.2 is a patch release whose schema-reader fix is compatible with the existing configuration.
cloudflared keeps `--no-autoupdate`, so the GitOps pin remains authoritative.

Preserve these pre-merge identities and data receipts:

| Resource                                       | UID                                    |
| ---------------------------------------------- | -------------------------------------- |
| `feature-flags/Deployment/feature-flags`       | `42c47a6b-211e-4f4c-8994-38029f8e77e7` |
| `feature-flags/PVC/feature-flags`              | `346b2485-fa36-447e-ad28-f9826ddb5dcf` |
| `kafka/Deployment/karapace`                    | `5fa20705-133f-41d1-bcf1-c34098d2ca84` |
| `kafka/Service/karapace`                       | `b3931c82-83ec-417d-96a7-f267323f626c` |
| `cloudflare/Deployment/cloudflared-deployment` | `bc768d68-e31d-4b98-8723-1188282f2683` |

The pre-merge `feature-flags-state` head is `0649c31fe01b2075de88c8fd5dc4b0fb39522cb5`. Karapace reports four
subjects with sorted JSON SHA-256 `c372679b92ee2057a19827dce2cd941419df54363187b0d708c66594b7da1e11`.

```bash
set -euo pipefail
git fetch --quiet origin main
upgrade_revision=$(gh pr view codex/cluster-app-upgrades-wave5-services -R proompteng/lab \
  --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')
test -n "$upgrade_revision"
test "$(git rev-parse origin/main)" = "$upgrade_revision"

for app in feature-flags kafka cloudflare; do
  argocd app get "$app" --hard-refresh >/dev/null
  argocd app wait "$app" --sync --health --timeout 1200
done
kubectl -n feature-flags rollout status deployment/feature-flags --timeout=15m
kubectl -n kafka rollout status deployment/karapace --timeout=15m
kubectl -n cloudflare rollout status deployment/cloudflared-deployment --timeout=15m
```

Acceptance requires all five UIDs above and the Flipt PVC volume binding to remain unchanged. Require the Flipt health
endpoint to report `SERVING`, its Git state head to remain exact, and the target 2.11.0 image to be ready with zero
restarts. Require Karapace to report 6.2.2, preserve the exact sorted subject hash, and serve every registered subject.
Require cloudflared to report 2026.7.3, return HTTP 200 with at least one ready connection, and show no recurring tunnel
errors after convergence. Each Application must be `Synced/Healthy` at the exact merge revision. Roll back through a
reviewed revert only; never delete the Flipt PVC or Kafka `_schemas` topic.

Wave 5b merged as `305f732b9e15ca3252526e4c4e6040ea1699094b`. Flipt and cloudflared passed their runtime gates, and all
five resource UIDs plus the Flipt volume binding were preserved. Karapace 6.2.2 started healthy and replayed through
offset 248, but returned zero subjects, so the wave remains unaccepted.

The failed Karapace gate exposed pre-existing topic retention loss rather than a 6.2.2 reader regression. An
independent consumer reported `_schemas` watermarks `low=249, high=249`; all three broker replicas contained only the
empty segment beginning at offset 249. The topic was not represented by a `KafkaTopic`, so it retained the broker
defaults `cleanup.policy=delete` and `retention.ms=604800000`. The previous long-running Karapace process continued to
serve four subjects from memory after Kafka deleted their records, masking the loss until the upgrade restarted it.

The corrective gate is a managed `KafkaTopic/karapace-schemas` targeting `_schemas`, with one partition, three replicas,
and `cleanup.policy=compact`. It carries Argo's `Prune=false` sync option so deleting or renaming the manifest cannot
cause Strimzi to delete the data-bearing Kafka topic. Do not restore registry records until that resource is `Ready` and
an independent Kafka admin read confirms the effective compact-only policy. Recovery must preserve the current IDs
observed in retained payloads (`7`, `8`, and `9`) and the legacy IDs still present in retained TA payloads (`1` and `4`),
restore exactly the four pre-upgrade active subjects, and prove that each ID serves a schema capable of decoding its
corresponding retained payload without exposing payload contents. Keep Wave 5b open until those checks and a fresh
Karapace restart both pass.

Wave 5b was accepted after corrective merges `86d3d99db86f4482f1fbe6222929214ee1edc164` and
`df3180afd1ca1d77b44c17e9ca08b7bcd08d3930`. The managed `_schemas` topic is `Ready`, has effective non-default
`cleanup.policy=compact`, and carries Argo `Prune=false`. A fresh Karapace 6.2.2 process replayed offsets `0..254`,
reported five schemas, four live versions, and two soft-deleted recovery versions, then returned the exact active
subject hash `c372679b92ee2057a19827dce2cd941419df54363187b0d708c66594b7da1e11`. Registry IDs `1`, `4`, `7`, `8`, and
`9` resolved to the expected schema hashes, and bounded retained samples for every ID decoded completely. The
Karapace Deployment UID remained unchanged and its replacement Pod was ready with zero restarts. Flipt returned
`SERVING` at 2.11.0, and cloudflared 2026.7.3 returned HTTP 200 with four ready tunnel connections. All three
Applications were `Synced/Healthy` at the exact final merge.

## Wave 6a: Temporal patch release

| Application | From                                 | To                                   | Reconciliation | Expected impact                                                       |
| ----------- | ------------------------------------ | ------------------------------------ | -------------- | --------------------------------------------------------------------- |
| Temporal    | chart `1.5.0`, server/admin `1.31.1` | chart `1.6.0`, server/admin `1.31.2` | Manual         | Roll six stateless Deployments and replace the idempotent schema Job. |
| Temporal UI | app `2.51.1`                         | app `2.52.0`                         | Manual         | Roll the singleton web Deployment.                                    |

Upstream chart 1.5.0 to 1.6.0 changes only `Chart.yaml` and the three default image tags; no chart template changes.
The Temporal server 1.31.1 to 1.31.2 comparison contains no Cassandra, persistence, or schema files. The 29 stable
rendered resource identities have canonical hash `dec760551321b2383c922a6d29884999536543cbc40ffed3a36b4634631ee8ac` in
both renders; the Elasticsearch chart's pre-existing random Helm test Pod is excluded from that identity receipt.
Selectors, services, Cassandra, Elasticsearch, PVC templates, persistence configuration, and history shard count are
unchanged. The target multi-architecture image indexes are pinned immutably:

- server 1.31.2: `sha256:b5ecdb8282bededae2a10c36e8d862e27d0bc2d247fc73c5416025997ab4a1da`;
- admin-tools 1.31.2: `sha256:dbc5fcd6ee8f0f4d808bf765af9a87dea9d8a283abfdcfbd2fc148496ba66107`;
- UI 2.52.0: `sha256:fc47cd8202c98ed868745fd9f2f011585232676d08da621b9a6d7bc4653c17aa`.

The pre-merge data receipt is Cassandra schema `1.13` with minimum compatible version `1.0`, all three Cassandra
nodes `UN`, Elasticsearch `green` with zero unassigned shards, cluster ID
`2eac29aa-efe4-4403-afa7-f20b8e7e61bd`, 512 history shards, 737 visible workflows in `default`, and one in
`temporal-system`. Preserve these Deployment UIDs:

| Resource                           | UID                                    |
| ---------------------------------- | -------------------------------------- |
| `temporal-admintools`              | `f139661d-02f0-411c-82d0-3287041baffb` |
| `temporal-frontend`                | `36acf421-54f0-4241-ae50-e2a3d0aec458` |
| `temporal-history`                 | `0bbd1158-822b-45f3-a0aa-04698633f945` |
| `temporal-matching`                | `a538b62d-0107-471e-8d8f-378a70229ac4` |
| `temporal-web`                     | `eac533f9-507f-48b2-ab70-6b7f47c05b23` |
| `temporal-worker`                  | `8451c404-2047-4a2a-af09-aef302f57cb5` |
| `StatefulSet/temporal-cassandra`   | `0a9b7396-7c88-4750-ba97-cf03e48e374b` |
| `StatefulSet/elasticsearch-master` | `5ec04c53-8e25-4465-b94c-afa84d7328be` |

After merge, hard-refresh and wait for the `temporal` Application at the exact merge. The schema Job is deliberately
annotated `Force=true,Replace=true`; require its replacement to complete before accepting the service rollouts. Require
all six Deployment UIDs and both StatefulSet UIDs to remain unchanged, every new Pod to be ready with zero restarts,
cluster health to report `SERVING`, both namespaces to remain registered, the cluster ID and 512-shard configuration
to remain exact, and visible workflow counts not to decrease. Require Cassandra schema `1.13`, three `UN` nodes, and
Elasticsearch `green` with zero unassigned shards. Check a bounded recent server log window for recurring errors.
Because the patch has no schema change, rollback is a reviewed Git revert; Temporal supports an older binary with a
newer schema, but never remove Cassandra or Elasticsearch data during rollback.

Wave 6a was accepted at merge `1ee45ded122b1de749ee01f9b0b7147926ce31b2`. A reviewed manual Argo sync replaced
the schema Job, which reported zero Cassandra updates from schema 1.13 and completed with admin-tools 1.31.2 before
the six Deployment rollouts. All six Deployment UIDs and both data StatefulSet UIDs remained unchanged. The six new
Pods were ready with zero restarts and exact target image digests. Temporal reported server 1.31.2, `SERVING`, the
same cluster ID and 512 history shards, both namespaces registered, and visible workflow counts 739 and one.
Cassandra remained three `UN` nodes at schema 1.13; Elasticsearch remained green with zero unassigned shards. The
simultaneous singleton rollout produced bounded membership errors against old Pod addresses, and the visibility Job
reported the existing Elasticsearch legacy-template deprecation; a subsequent 60-second window had zero errors or
warnings across the five runtime services. The Application finished `Synced/Healthy` at the exact merge.

## Wave 6b: Open WebUI database migration

| Application | From                         | To                           | Reconciliation | Expected impact                                                                     |
| ----------- | ---------------------------- | ---------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| Open WebUI  | chart `15.2.0`, app `0.10.2` | chart `16.0.0`, app `0.11.0` | Automatic      | Stop the singleton, migrate PostgreSQL, then start one replacement StatefulSet Pod. |

The chart changes only chart/app metadata and its disabled Ollama dependency from 1.65.0 to 1.70.0; Open WebUI chart
templates are unchanged. Both full Jangar renders contain the same 38 identities with canonical hash
`40eb37d7881e25ab6ebcbc56f0a83f9e72261d8ab9fffe8c2d213b6c9941bbe3`. The StatefulSet selector, singleton replica,
service, external PVC, PostgreSQL connection, Redis connection, and persistence mounts remain unchanged. The target
Open WebUI multi-architecture image is pinned to
`sha256:72c0ba641ba75e7aa52655cb242570906ececd09b1140fb736483038a22b3228`.

Open WebUI 0.11.0 explicitly requires a database and associated-data backup and does not support mixed-version
rolling deployments. This installation has exactly one replica, so its default StatefulSet update stops 0.10.2 before
starting 0.11.0. The target migration chain advances Alembic from `42e2978c7933` through seven reversible migrations
to `f0bd01a18a3d`; it adds chat/current-message/variable columns and indexes. The preflight has one user, zero
normalized-email duplicates, zero memories, 28 chats, 124 chat messages, and zero automations. The shared Jangar
database is about 25 GB and its schema-only SHA-256 is
`2dedef4448cd6b5d6b20c58e2464c1d73eca5875ca2607932a7fa0f6b629a217`.

Before merge, require a new completed `barmanObjectStore` backup of `jangar-db` and a ready RBD `VolumeSnapshot` of
PVC `open-webui`; retain both until final fleet acceptance. Continuous archiving must remain healthy. Preserve these
identities:

| Resource                               | UID                                    |
| -------------------------------------- | -------------------------------------- |
| `StatefulSet/open-webui`               | `1087ca2d-7d9a-4ea0-a214-0f06b92096dd` |
| `Service/open-webui`                   | `cf5789f3-ada0-4091-970d-3c6ff399db17` |
| `ServiceAccount/open-webui`            | `9d55967f-4608-4395-9c4b-85b8b1f67e0a` |
| `PersistentVolumeClaim/open-webui`     | `2ffa4cb1-87c9-40e9-b467-e2a939f6607f` |
| `Cluster.postgresql.cnpg.io/jangar-db` | `2059ac54-3ca8-4ed0-bb06-60288ae3a310` |

After merge, hard-refresh and wait for `jangar` at the exact merge. Require the StatefulSet rollout to finish with one
ready 0.11.0 Pod at the pinned digest and zero restarts, all identities and the PVC volume binding to remain exact,
`/health` to return true, and `/api/version` to report 0.11.0. Require Alembic head `f0bd01a18a3d`, unchanged row
counts in all five migration-touched tables, no normalized-email duplicates, a healthy two-instance CNPG cluster with
continuous archiving, and no recurring migration/runtime errors. Rollback requires stopping 0.11.0 and restoring both
the pre-merge database point and associated-data snapshot before reverting Git; do not run 0.10.2 against a partially
migrated database.

Wave 6b was accepted at merge `30cff1bec28e99f8395d6c36e1c0b3269b056980`. Before merge, CNPG backup
`jangar-db-openwebui-v0-11-0-20260807t131310z` completed from the standby with WAL range
`00000005000003ED00000050` through `00000005000003ED00000054`, and VolumeSnapshot
`open-webui-pre-v0-11-0-20260807t131310z` became ready for the 5 GiB PVC. Argo server-side applied only the
Open WebUI ServiceAccount, Service, and StatefulSet. The existing StatefulSet, Service, ServiceAccount, PVC, database
Cluster UIDs, and PVC volume binding remained exact. A ten-second RBD reattachment delay cleared without action; the
new Pod then pulled the 1.83 GB image, ran all seven migrations, and became ready with zero restarts at the pinned
digest. `/health` returned true and `/api/version` returned 0.11.0. Alembic reached `f0bd01a18a3d`; the user, memory,
chat, chat-message, and automation counts remained 1, 0, 28, 124, and 0, with zero normalized-email duplicates. CNPG
remained two of two ready with continuous archiving, repeated health probes passed, and a subsequent 60-second runtime
window contained no errors. The Application finished `Synced/Healthy` at the exact merge.

## Wave 6c: Saigak Ollama runtime

| Application | From     | To       | Reconciliation | Expected impact                                                                  |
| ----------- | -------- | -------- | -------------- | -------------------------------------------------------------------------------- |
| Ollama      | `0.13.5` | `0.32.6` | Manual         | Stop the singleton GPU Pod, verify the cached model, then start its replacement. |

The target is the latest upstream stable release and its official multi-architecture image index contains both amd64
and arm64 manifests. Pin both the model-init and server containers to
`sha256:b88c73ace3e115f8ec53dc8761ae1c0aabfa675406e3681786b98757ce050f42`. Upstream stable release notes from
0.13.5 through 0.32.6 contain no storage migration, model-format incompatibility, or embedding API removal. The 0.32.6
removal of experimental image generation is irrelevant because Saigak's proxy rejects generation and completion
routes.

The singleton uses StatefulSet rolling replacement and a 200 GiB node-local model-cache PVC, so merge must not trigger
the rollout automatically. The current and upstream `qwen3-embedding:8b` manifests both reference the exact 4.68 GB
model layer `sha256:3fcd3febec8b3fd64435204db75bf0dd73b91e8d0661e0331acfe7e7c3120b85`; no model download or
model-data transition is expected. The custom `qwen3-embedding-saigak:8b` model is embedding-only, uses that layer and
`num_ctx 32768`, and currently produces finite normalized 4096-dimensional vectors while resident entirely in GPU
VRAM. Preserve these identities:

| Resource                                  | UID                                    |
| ----------------------------------------- | -------------------------------------- |
| `StatefulSet/saigak`                      | `ca97f12d-ecdb-4bcd-8e58-997ac2142704` |
| `Service/saigak`                          | `4ac187de-f91d-4e51-9da3-5275a1c8d529` |
| `PersistentVolumeClaim/saigak-altra-data` | `53628b88-ba4b-4571-a494-4448dd35e741` |

After merge, capture a fresh baseline embedding, perform a reviewed manual Argo sync, and wait for the StatefulSet.
Require both containers to be ready with zero restarts, the init and server image IDs to resolve to the pinned target,
`ollama --version` to report 0.32.6, and the single custom model to retain its layer, parameters, embedding capability,
and GPU residency. Require `/readyz`, `/v1/models`, and repeated `/v1/embeddings` calls to pass with finite normalized
4096-dimensional vectors and no material semantic drift from the baseline. Preserve all identities and the PVC binding,
and check a bounded post-start log window for recurring errors. With no persistent-data migration and the exact model
layer retained, rollback is a reviewed Git revert followed by manual sync; never remove the model-cache PVC.

Wave 6c was accepted at merge `1ebded25d6335ad3b66caf9be58460384bce9c28`. A reviewed manual Argo sync
replaced the singleton Pod while preserving the StatefulSet, Service, PVC, and volume-binding identities. The init
container completed once and the Ollama and proxy containers became ready with zero restarts at the pinned digest.
Ollama reported 0.32.6; the only custom model retained its exact layer, 4096-dimensional embedding capability,
`num_ctx 32768`, and full GPU residency. Five consecutive readiness probes passed. The post-upgrade embedding was
finite and normalized, with cosine similarity `0.9995798919` to the fresh baseline and maximum component delta
`0.003224742`. An intentional saturation probe briefly filled the single parallel request queue and caused bounded
readiness and broken-pipe messages; the service recovered without restart, and the final 60-second window was clean.
The Application finished `Synced/Healthy` at the exact merge.

## Wave 6d: Flamingo vLLM runtime

| Application | From     | To       | Reconciliation | Expected impact                                                               |
| ----------- | -------- | -------- | -------------- | ----------------------------------------------------------------------------- |
| Flamingo    | `0.23.0` | `0.26.0` | Manual         | Stop the singleton GPU Pod, reuse its model cache, and start its replacement. |

The target is the latest upstream stable vLLM release. Its official `v0.26.0-x86_64-cu129` image is pinned to the
single-platform amd64 manifest digest
`sha256:3c5c53248febaa72823a4b7e51aafa1cd2b65d860392e3930414da4d3864f541`, matching the Turin node architecture
and CUDA lane. The Qwen3 reasoning parser, `qwen3_coder` tool parser, and every deployed server flag remain supported.
The release removes legacy PagedAttention and makes Multi-Request v2 the default, but neither change alters the
OpenAI-compatible endpoints, model alias, or persistent model-cache format used here. This wave changes only the
image; model, context, concurrency, KV-cache dtype, resources, probes, scheduling, and services stay exact.

The Deployment uses `Recreate` and a 256 GiB RBD model-cache PVC. Before the manual sync, require a fresh ready
`VolumeSnapshot` of `flamingo-model-cache`, a passing smoke-profile baseline, sufficient PVC free space, and confirmation
that Flamingo and the approved Plex transcode workload are the only Turin GPU consumers. Retain the snapshot through
final fleet acceptance. Preserve these identities:

| Resource                                     | UID                                    |
| -------------------------------------------- | -------------------------------------- |
| `Deployment/flamingo`                        | `68e14b68-d63e-4196-9904-a0aed48e0541` |
| `Service/flamingo`                           | `9be4c6e6-cbf2-4882-9e23-b5b21bcf6f8e` |
| `PersistentVolumeClaim/flamingo-model-cache` | `2c2ff36a-f4de-49f8-ae22-80337fab64fe` |

The pre-sync smoke artifact
`/tmp/flamingo-vllm-bench/flamingo-vllm-0-23-0-preupgrade-smoke-2026-08-07T13-53-28-137Z.json` passed every gate,
including 220K recall, with zero request errors, aborts, or preemptions across 236,825 prompt tokens. VolumeSnapshot
`flamingo-pre-vllm-v0-26-0-20260807t135506z` is ready for the full 256 GiB PVC with UID
`bbad601c-553d-4c84-8694-6c3b1d66bf33`; retain it through final fleet acceptance.

After merge, inspect the reviewed Argo diff and require it to contain only the vLLM image replacement before manually
syncing. Wait up to four hours for the model load. Require the replacement Pod to run on `turin`, become ready with
zero restarts at the pinned digest, and report vLLM 0.26.0. Require `/v1/models` to expose only `qwen36-flamingo` with
`max_model_len=262144`, then run the repository smoke profile with exact no-thinking, medium-thinking, structured tool
call, long-context recall, scheduler, and zero error/abort/preemption gates. Preserve all identities and the PVC volume
binding, confirm GPU residency and bounded host/GPU memory, and check a clean post-start log window for recurring OOM,
parser, KV-cache, or request failures. With no persistent-data migration, rollback is a reviewed Git revert followed by
manual sync; never delete the model-cache PVC or its retained snapshot.

Wave 6d was accepted at merge `c7d511df58a8193773e4eb07c53e55ec8d84ee07`. A reviewed manual Argo sync
changed only the vLLM image. The Deployment, both Services, PVC, and volume binding retained their exact identities;
the replacement Pod ran on `turin` at the pinned digest with zero restarts. The 11.7 GB image pull took 2m27s, all six
cached model shards loaded in 10.45s, and engine initialization completed in 152.75s. vLLM reported 0.26.0,
`qwen36-flamingo`, 262,144-token context, 23.27 GiB model memory, and a 53.51 GiB FP8 KV cache.

The compatibility artifact
`/tmp/flamingo-vllm-bench/flamingo-vllm-0-26-0-compatibility-smoke-2026-08-07T14-08-13-467Z.json` passed every
chat, thinking, structured-tool, 220K recall, scheduler, memory, error, abort, and preemption gate. A separate direct
comparison against 0.23.0 measured output throughput `313.94` versus `313.43` tok/s, p99 TTFT `253.03` versus
`278.41` ms, and mean TPOT `5.92` versus `5.87` ms. Its only failed check was the tuning harness's intentionally
inapplicable requirement that every candidate be 20% faster; the version upgrade was performance-neutral and passed
both latency-regression guardrails. Five consecutive health/model probes passed, the final 60-second log window was
clean, and the Application finished `Synced/Healthy` at the exact merge. Retain VolumeSnapshot
`flamingo-pre-vllm-v0-26-0-20260807t135506z` until final fleet acceptance.

## Wave 6e: Keycloak schema migration

| Application | From     | To       | Reconciliation | Expected impact                                                                |
| ----------- | -------- | -------- | -------------- | ------------------------------------------------------------------------------ |
| Keycloak    | `26.5.1` | `26.7.1` | Automatic      | Stop the singleton, migrate PostgreSQL, and start one replacement StatefulSet. |

Keycloak 26.7.1 is the latest upstream stable release and includes five security fixes. Its official image index is
pinned to `sha256:f1f1f01e472c8a78df40d8f2a49a925274eda4d3d80d5f6edbb5c880ee3c01c6` and contains Linux amd64 and
arm64 manifests. Upstream requires downtime for a minor-version upgrade and warns that the migrated schema is not
compatible with the old server. This installation has one StatefulSet replica, so ordered replacement stops 26.5.1
before 26.7.1 acquires the Liquibase lock; no mixed-version interval occurs.

The migration adds the 26.6 group-organization relationship, offline-session realm/index backfill, and entity
timestamps, followed by the 26.7 realm display-name migration, verifiable-credential and outbox tables, persistent
authentication-session tables, consent-scope parameters, login-failure storage, client timestamps, and cluster-event
storage. The preflight database is 13 MB with 178 recorded changesets, 90 public tables, 518 columns, and 213 indexes.
It contains one realm, eight clients, two users, 32 roles, nine offline user sessions, and nine offline client sessions.
Its canonical schema-only SHA-256, after removing PostgreSQL 18's randomized dump restrict markers, is
`bd62c328c6a8fb327b32a74368d2eb4728e097b81a8754b708d3b6e769fd16e3`.

There is no configured CNPG object-store backup for this cluster. The validated custom-format logical dump
`/tmp/keycloak-v26-5-1-20260807t141927z.dump` is 211,890 bytes with SHA-256
`dcbf5ddd92797c6195cd675a00122891c16b4c02d15aa643a314930594d5d1b3`; `pg_restore --list` parsed it completely.
After a primary checkpoint, VolumeSnapshot `keycloak-db-pre-v26-7-1-20260807t141340z` became ready for the 5 GiB
primary PVC with UID `75f3f4da-5c90-4a9d-b406-cded2a03f863`. Retain both recovery artifacts through final fleet
acceptance. Preserve these identities:

| Resource                                 | UID                                    |
| ---------------------------------------- | -------------------------------------- |
| `StatefulSet/keycloak`                   | `624dfbe0-f107-40a4-838d-b1126d8e4335` |
| `Service/keycloak`                       | `3c0bc0a4-70d3-4866-97bf-8e38ca608c11` |
| `Service/keycloak-discovery`             | `b2c62892-fcbc-4aab-8915-cd456aacc89a` |
| `Cluster.postgresql.cnpg.io/keycloak-db` | `64364be2-6fbd-4d37-82db-ad3c9df0d4ea` |
| `PersistentVolumeClaim/keycloak-db-1`    | `b868772d-75fb-4a04-8da1-62d81d55d4eb` |
| `PersistentVolumeClaim/keycloak-db-3`    | `3dd76f2e-e59e-4fe5-b9ed-3fe61d8b19af` |

The preflight realm projection hash is `2b5f84a29109eed2caa0786d7a2b66b63f4e9630de432853ba7b1f9801fd8109`,
and the sorted client projection hash is `156e94510df90dd2403874795206eeab5cf95f5f47132dd7aa289f66d11d31b0`.
The public issuer is `https://auth.proompteng.ai/realms/master`, and its two signing-key IDs are
`G-jdaaYZyS2BKLu_9xnwIeP0GoQYWCjm6QJmtiE7EMw` and `m4ODn9BPTWleS9KO2iPCA9s4Rl2ByeEww94xEEd4hRs`.

After merge, wait for the automatic ordered rollout. Require the replacement Pod to become ready with zero restarts
at the pinned digest and report 26.7.1. Require the two-instance CNPG cluster to remain healthy and all six resource
UIDs plus both PVC bindings to remain exact. Confirm Liquibase completes without checksum, lock, or migration errors;
record its new head and schema hash; and require every preflight row count not to decrease. Require the realm and client
projection hashes, issuer, signing-key IDs, discovery document, admin authentication, and health endpoints to remain
exact, then check a clean bounded runtime log window. Rollback requires scaling Keycloak to zero, restoring the logical
dump or checkpointed snapshot, and only then reverting Git; never start 26.5.1 against the migrated database.
