Seal the secret

```bash
kubeseal --controller-name sealed-secrets -f secret.yaml -w sealed.yaml
```

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
