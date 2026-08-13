# Bayn GitOps rollout notes

## Inactive native Restate worker

The `bayn-execution-controller` `RestateDeployment` registers the native worker without activating an execution
controller. The worker starts with read-only broker access and no capital authority. There is no bootstrap Job in this
layer, so reconciliation must not create controller state, schedule ticks, or submit broker mutations.

Before merging this layer, require the `restate-operator-crds`, `restate-operator`, and `restate` Argo applications to
be `Synced` and `Healthy`, and verify the Restate request-identity foundation described in
`argocd/applications/restate/README.md`. The bootstrap `SealedSecret` uses sync wave `-2` and the repository's
current-generation health gate; the `RestateDeployment` follows in wave `-1`. A missing or undecryptable Secret must
block the worker instead of allowing a partially configured pod.

After the normal Argo sync, verify the inactive deployment without printing credentials or invoking the bootstrap
handler:

```sh
kubectl get application -n argocd bayn restate-operator-crds restate-operator restate -o wide
kubectl get crd restatedeployments.restate.dev -o name
kubectl get sealedsecret -n bayn bayn-execution-bootstrap -o jsonpath='{.status.conditions[*].type}{" "}{.status.conditions[*].status}{"\n"}'
kubectl get secret -n bayn bayn-execution-bootstrap -o name
kubectl get restatedeployment -n bayn bayn-execution-controller -o wide
kubectl get deployment,pod -n bayn -l app.kubernetes.io/name=bayn-execution-controller -o wide
kubectl get pod -n bayn -l app.kubernetes.io/name=bayn-execution-controller -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.containerStatuses[0].imageID}{"\n"}{end}'
kubectl logs -n bayn -l app.kubernetes.io/name=bayn-execution-controller --since=10m
```

Expected:

- all four Argo applications are `Synced` and `Healthy`;
- the SealedSecret is current and the generated Secret exists before the worker pod starts;
- the operator reports one available worker revision at the committed image digest;
- logs show registration and readiness, with no activation, tick, writer-fence acquisition, or broker mutation;
- the existing Bayn status service remains the only active lifecycle owner until the cutover layer lands.

The expected impact is one inactive worker pod plus narrowly scoped PostgreSQL, TigerBeetle, ClickHouse, telemetry,
DNS, and broker-proxy network paths. The worker has no service-account token and accepts Restate requests only from the
`restate` namespace. Its bootstrap endpoint is token-authenticated but must not be called during this layer.

If the Secret, worker, registration, or dependency paths do not converge, revert this layer through a normal PR and
let Argo prune the `RestateDeployment`, its generated Deployment/Service, NetworkPolicy, and bootstrap Secret. Do not
delete Restate registrations, CRDs, PVCs, or the existing Bayn lifecycle owner by hand. Confirm the generated worker
pod and Service are gone, the legacy owner still holds the writer fence, reconciliation remains exact, and the broker
mutation ledger did not advance before resuming the stack.
