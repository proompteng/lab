Seal the secret

```bash
kubeseal --controller-name sealed-secrets -f secret.yaml -w sealed.yaml
```

## Argo CD v3.5.2 upgrade

The control plane is pinned to the complete upstream HA manifest for Argo CD v3.5.2. The upgrade from v3.4.6 is a
single GitOps reconciliation; do not update only the container images. Argo CD 3.5 embeds Helm 4, but every enabled
OCI Helm source in this cluster uses HTTPS-backed GHCR or Docker Hub. Do not add `insecureOCIForceHttp`, a Helm v3
override, or a second rendering path. Lovely remains the renderer for Applications that already select that plugin.

Before syncing the merged revision, require `argocd`, `root`, and `kargo` to be Synced and Healthy, ensure no Kargo
Promotion is running, and record any existing non-Healthy Stage so it is not attributed to this upgrade:

```bash
kubectl -n argocd get application argocd root kargo -o wide
kubectl -n lab-delivery get promotions.kargo.akuity.io -o json | \
  jq -e '[.items[] | select(.status.phase == "Running" or .status.phase == "Pending")] | length == 0'
kubectl -n lab-delivery get stages.kargo.akuity.io
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

# Force new browser-based OIDC exchanges; do not accept a cached pre-upgrade token as proof.
argocd logout argocd.proompteng.ai || true
argocd login argocd.proompteng.ai --sso --grpc-web
argocd account get-user-info --server argocd.proompteng.ai --grpc-web

kargo login https://kargo.ide-newton.ts.net --sso
kargo get stages --project lab-delivery

kubectl -n argocd get application -o wide
kubectl -n lab-delivery get stages.kargo.akuity.io
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
