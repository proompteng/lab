Seal the secret

```bash
kubeseal --controller-name sealed-secrets -f secret.yaml -w sealed.yaml
```

## Argo CD v3.6.1 upgrade

The control plane is pinned to the complete upstream HA manifest for Argo CD v3.6.1. The upgrade from v3.5.2 is a
single GitOps reconciliation; do not update only the container images. Argo CD 3.6 embeds Helm 4, but every enabled
OCI Helm source in this cluster uses HTTPS-backed GHCR or Docker Hub. Do not add `insecureOCIForceHttp`, a Helm v3
override, or a second rendering path. Lovely remains the renderer for Applications that already select that plugin.

The companion releases are Kargo 1.12.5, Argo Workflows 4.1.6 (chart 2.0.18), and Argo Rollouts 1.10.2
(chart 2.43.12). Reconcile Argo CD first, then Workflows and Rollouts, then Kargo. Kargo 1.12 uses only the
existing `systemResources` and `sharedResources` namespace settings; the removed `clusterSecretsNamespace`
settings must not be restored. Both configured namespaces are already `kargo`, so no Secret migration is needed.

Argo CD 3.6 uses server-side diff for Applications with server-side apply. Admission failures can therefore appear
during comparison before a sync. Workflows 4.1.6 retains the installed 4.1.2 SSO token format. Kargo 1.12 changes
image creation-time discovery, so compare the selected Freight with the pre-upgrade record before accepting a new
promotion. Existing publication annotations remain the artifact eligibility contract.

Before syncing the merged revision, require `argocd`, `root`, and `kargo` to be Synced and Healthy, ensure no Kargo
Promotion is running, and record any existing non-Healthy Stage so it is not attributed to this upgrade:

```bash
kubectl -n argocd get application argocd root kargo -o wide
kubectl -n <project>-release get promotions.kargo.akuity.io -o json | \
  jq -e '[.items[] | select(.status.phase == "Running" or .status.phase == "Pending")] | length == 0'
kubectl -n <project>-release get stages.kargo.akuity.io
```

Sync the whole self-managed Application at the exact merge commit. The Application uses server-side apply and
`ApplyOutOfSyncOnly=true`, so unchanged resources remain untouched while the three CRDs and seven changed workloads
reconcile:

```bash
argocd app sync argocd --revision <merge-commit> --prune
kubectl -n argocd rollout status statefulset/argocd-application-controller --timeout=5m
kubectl -n argocd rollout status deployment/argocd-applicationset-controller --timeout=5m
kubectl -n argocd rollout status deployment/argocd-repo-server --timeout=5m
kubectl -n argocd rollout status deployment/argocd-server --timeout=5m
kubectl -n argocd rollout status deployment/argocd-notifications-controller --timeout=5m
kubectl -n argocd rollout status deployment/argocd-dex-server --timeout=5m
kubectl -n argocd rollout status deployment/argocd-redis-ha-haproxy --timeout=5m
```

Hard-refresh the enabled OCI Helm Applications to prove Helm 4 rendering, then verify Argo and Kargo OIDC, Application
health, and Kargo's Argo integration:

```bash
for application in arc-controller kargo restate-operator restate-operator-crds; do
  argocd app get "$application" --hard-refresh
done

# Force new authentication exchanges; do not accept a cached pre-upgrade token as proof.
# Argo CD uses its local admin account. This Dex instance is the external OIDC issuer for Kargo and Argo Workflows,
# not an Argo CD SSO connector.
argocd logout argocd.proompteng.ai || true
argocd login argocd.proompteng.ai --username admin --grpc-web
argocd account get-user-info --server argocd.proompteng.ai --grpc-web

# Kargo must complete a new browser-based OIDC exchange through the Argo-hosted Dex issuer.
kargo login https://kargo.ide-newton.ts.net --sso
kargo get stages --project <project>-release

kubectl -n argocd get application -o wide
kubectl -n <project>-release get stages.kargo.akuity.io
```

The final deployment proof is the first normal Kargo promotion after the upgrade: a passing `main` image build must
create Freight, automatically promote it, update the existing `kargo/<stage>` branch, and leave the target Application
Synced and Healthy. Do not create a promotion PR, manually bump a digest, publish a synthetic image, or deploy with
`kubectl` to manufacture this proof.

Rollback if a required control-plane workload remains unavailable for five minutes, Lovely or OCI Helm rendering
fails, OIDC fails, Applications stop reconciling, or Kargo's Argo integration regresses. Revert the version pin through
Git and sync the complete `argocd` Application. If Argo CD cannot reconcile itself, apply the exact reverted render
server-side as an emergency recovery only:

```bash
kustomize build argocd/applications/argocd | \
  kubectl -n argocd apply --server-side --force-conflicts -f -
```

Never delete or recreate the Argo CRDs, Applications, ApplicationSets, Kargo Freight, Stages, or `kargo/*` branches
during rollback.

## RestateDeployment health rollout

Argo CD applies a cluster-wide health customization for `restate.dev/RestateDeployment`. It holds later sync waves
until the Restate operator has observed the current generation, registered a deployment ID, reported `Ready=True`,
and made every desired replica ready. `Ready=False` remains `Progressing`. For the pinned operator's
`Ready=Unknown/FailedReconcile` state, Kubernetes, Secret, and `RestateCloudEnvironment` dependency failures remain
`Progressing`; other reconciliation failures become `Degraded` because they require an operator or configuration
change.

After the `argocd` application reconciles this ConfigMap, existing and in-flight `RestateDeployment` health is
re-evaluated. Already registered deployments remain healthy; a Bayn sync waiting in a later wave stays held until its
current worker revision is registered. A previously failed hook requires the next normal GitOps sync or configured
automatic retry; do not recreate it manually.

Verify propagation and impact without changing cluster state:

```bash
kubectl -n argocd get configmap argocd-cm -o jsonpath='{.data.resource\.customizations\.health\.restate\.dev_RestateDeployment}{"\n"}'
kubectl -n argocd get application argocd bayn -o wide
kubectl -n bayn get restatedeployment bayn-execution-controller -o wide
kubectl -n bayn get restatedeployment bayn-execution-controller \
  -o jsonpath='{.metadata.generation}{" "}{.status.observedGeneration}{" "}{.status.deploymentId}{" "}{.status.readyReplicas}{"/"}{.status.desiredReplicas}{"\n"}'
```

Rollback by reverting this customization through a reviewed PR. Existing Restate deployments, registrations, and
invocations are not deleted by either the rollout or rollback; only Argo's health classification changes.

## CloudNativePG major-upgrade health

The Cluster health customization preserves the Argo CD v3.6.1 phase classifications except that
`Upgrading Postgres major version` is `Progressing`. CNPG uses this phase during a normal native major upgrade;
classifying it as `Degraded` causes Argo to fail the sync and Kargo to exhaust deployment retries while the database
is still upgrading. Later waves remain held until CNPG reports `Cluster in healthy state`. Delayed upgrades,
required user action, suspension, and hibernation retain their upstream classifications.

Reconcile the merged `argocd` Application before starting a PostgreSQL major upgrade. This only changes health
evaluation; it does not restart Argo or mutate databases. If an earlier promotion already failed during this phase,
retry its existing Freight through Kargo after the database is healthy. Verify the resulting promotion, exact Argo
revision, and native database acceptance. Roll back the health change by reverting this ConfigMap through Git;
retained database checkpoints and volumes are unaffected.

Regression coverage executes the ConfigMap's actual Lua with upgrade, healthy, failure, suspension, hibernation,
and missing-status fixtures:

```bash
bun test packages/scripts/src/argocd/__tests__/cnpg-cluster-health.test.ts
```

Dex uses memory storage, matching the behavior enforced by the Argo CD wrapper before 3.6. Argo CD 3.6 honors an
explicit storage override; the formerly ignored Kubernetes override cannot work without Dex CRDs and storage RBAC.
Keep the native memory configuration. The Dex readiness probe checks its listener so a failed child process cannot
leave the deployment falsely ready.

## Regenerable GitOps scratch

Kargo Git checkouts and promotion workspaces, Argo CD repository/Helm caches, and Lovely render workspaces use bounded
memory-backed `emptyDir` volumes. These paths previously wrote to the node system disk shared with etcd. During the
2026-11-12 incident, Kargo wrote 13.2 MB/s of a measured 21.2 MB/s on that disk after the ARC local scratch claims had
drained, and etcd continued reporting WAL flushes above one second. An earlier render wave wrote another 12.7 MB/s
from the repo-server Pod. Moving the regenerable files preserves their existing Pod-lifetime semantics.

| Consumer | Temporary paths | Total tmpfs cap | Memory request and limit | Process headroom |
| --- | --- | --- | --- | --- |
| Kargo controller | `/gitops-tmp`, selected by `TMPDIR` | 32 GiB | 40 GiB | 8 GiB |
| Argo CD repo-server | `/tmp` (8 GiB), `/helm-working-dir` (2 GiB) | 10 GiB | 12 GiB | 2 GiB |
| Lovely plugin | Its separate `/tmp` | 8 GiB | 12 GiB | 4 GiB |

The Kargo 1.12.5 chart hardcodes its existing disk-backed `/tmp` mount. The supported extra-volume and extra-mount
values add `/gitops-tmp`; `TMPDIR` moves both `os.TempDir()` promotion directories and default `os.MkdirTemp()` Git
directories without duplicating the chart-owned mount. The existing `/tmp` remains available for other consumers.
Kargo's four warehouse and four promotion workers remain unchanged. Requeued promotions retain their directories,
so the 32 GiB cap also budgets for the current 28 Stages: approximately 641 MiB per observed promotion workspace,
plus concurrent discovery, Git packing and growth. The measured controller cgroup peak was 2.98 GiB during the
observed wave; the retained-workspace envelope is deliberately larger than that instantaneous peak.

The main repo-server cache occupied 647 MiB and its cgroup peaked at 1.27 GiB. Lovely peaked at 2.84 GiB; the current
tracked checkout contains 179 MiB, so 16 concurrent source copies occupy about 2.8 GiB before generated output.
The caps leave room for those copies and rendering while retaining the existing parallelism of 16. Each repo-server
Pod reserves 24 GiB for its two containers. At the incident preflight, Turin had 1,038 GiB allocatable and 503 GiB
requested; adding Kargo and its repo-server reservation increases requested memory by 63 GiB. Altra had 753 GiB
allocatable and 179 GiB requested; its repo-server reservation increases requests by 23 GiB. Neither node reported
memory pressure. Recheck these budgets when placement, repository size, Stage count or rendering concurrency changes.

Kubernetes counts tmpfs pages against the writing container's memory. The request reserves capacity for the full
scratch cap plus process headroom; `sizeLimit` alone would not reserve it. ENOSPC, OOM kills, rising memory usage or
manifest-generation failures require investigation and a reviewed capacity adjustment. Do not remove the limits to
hide them. Lovely keeps its own filesystem, preserving upstream isolation from the main repo-server's `/tmp`.
The standard emptyDir root is writable by the existing non-root users (the deployed Kargo root was mode 0777); no
root init container, fsGroup, credential change or new privilege is required. GPG, TLS, plugin binaries and durable
volumes retain their existing storage. Runtime layers and logs still use node storage.

Render both the pinned Kargo chart with the ApplicationSet's values and the full Argo CD Kustomization before merge.
The focused contract verifies every tmpfs cap, combined per-container memory budget and Lovely filesystem isolation:

```bash
bun test packages/scripts/src/shared/__tests__/gitops-scratch.test.ts
```

Roll out through the existing root/ApplicationSet and self-managed Argo CD reconciliation at the reviewed commit.
Prefer the interval between Kargo promotions; its singleton uses `Recreate`, while repo-server preserves its existing
one-at-a-time rolling strategy. Verify the rendered requests/limits, `TMPDIR`, actual `tmpfs` mounts, writability as
the existing container user, and a normal Git discovery/promotion and Lovely/Helm render. Then require a fresh
30-minute representative native-build observation with API readiness passing, no new slow-WAL warnings or monitor
quorum losses, and the existing Ceph latency/slow-operation alerts evaluated. A cancelled qualification is not proof.

Rollback by reverting these scratch/resource changes through Git and reconciling the same Applications. Temporary
checkouts regenerate as they already do after a Pod replacement; Kargo resources, Git promotion history and durable
volumes are retained. Reverting returns these writes to the system disk, so the original contention risk also returns.

## Bounded cold repository acquisition

The controller and API server use a 300-second repo-server RPC deadline. The main repo-server gives each external
command 180 seconds, followed by the existing 10-second fatal cleanup grace. This leaves 110 seconds within the RPC
budget for repository-lock wait, manifest generation and cleanup. These are operational bounds for GitOps work;
they do not change application health probes, trading deadlines, retries, concurrency or TLS validation.

On 2026-11-12, an Altra repo-server cache had three approximately 224 MB kept Git packs but no refs. Repeated
60-second RPC cancellations interrupted cold fetches and discarded partial packs. One Kargo render request spent
about 57 seconds waiting for that repository, leaving only three seconds for its fetch. Its tmpfs had ample free
space, memory reported no OOM events and current CPU pressure was zero. The other replica completed warm fetches
in under a second. The longer, finite budget addresses the observed cold-acquisition cancellation loop; a slow or
failed fetch still requires investigation rather than an unlimited deadline or manual writes to Argo's cache.

Argo CD v3.6.1 applies the RPC deadline around the entire
[repo-server client call](https://github.com/argoproj/argo-cd/blob/v3.6.1/reposerver/apiclient/clientset.go).
Its [Git commands](https://github.com/argoproj/argo-cd/blob/v3.6.1/util/git/client.go) also inherit that context and
the independent [command timeout](https://github.com/argoproj/argo-cd/blob/v3.6.1/util/exec/exec.go), so both bounds
must allow the cold fetch. The standard ConfigMap keys feed the controller and API-server environment at Pod start;
the committed `repo-budget-revision` annotations roll those consumers when this budget changes. Keep both annotations
in step with future budget updates. Repo-server's environment change uses its existing one-at-a-time rollout.

Run the focused scratch/budget contract above and render the full pinned Kustomization. Verify the rendered
ConfigMap references, command environment and unchanged replica/rollout settings. After normal GitOps reconciliation,
check the effective environment, a completed cold fetch with refs present, and successful normal manifest generation
on each repo-server replica. A successful render from only the warm replica does not qualify the replacement cache.
Retain the existing memory and tmpfs checks; changing the deadline does not establish storage or market readiness.
