# Bayn GitOps rollout notes

## Native Restate execution cutover

The `bayn-execution-controller` `RestateDeployment` is the single execution scheduler. It starts with read-only broker
access and no capital authority. A source-versioned Argo sync hook authenticates to the Restate ingress, verifies the
exact source/image/strategy/account plan, rotates the exact previous native controller binding when one is configured,
and only then activates the replacement controller. The public Bayn deployment rolls out after that verified handoff.

Before merging this layer, require the `restate-operator-crds`, `restate-operator`, and `restate` Argo applications to
be `Synced` and `Healthy`, and verify the Restate request-identity foundation described in
`argocd/applications/restate/README.md`. The bootstrap `SealedSecret` uses sync wave `-2` and the repository's
current-generation health gate; the `RestateDeployment` follows in wave `-1`, activation runs in wave `0`, and the
read-only status deployment follows in wave `1`. A missing Secret, unregistered worker, previous-binding mismatch, or
activation-verification failure blocks the sync before the public status rollout.

After the normal Argo sync, verify the handoff without printing credentials or invoking the bootstrap handler by hand:

```sh
kubectl get application -n argocd bayn restate-operator-crds restate-operator restate -o wide
kubectl get crd restatedeployments.restate.dev -o name
kubectl get sealedsecret -n bayn bayn-execution-bootstrap -o jsonpath='{.status.conditions[*].type}{" "}{.status.conditions[*].status}{"\n"}'
kubectl get secret -n bayn bayn-execution-bootstrap -o name
kubectl get restatedeployment -n bayn bayn-execution-controller -o wide
kubectl get deployment,pod -n bayn -l app.kubernetes.io/name=bayn-execution-controller -o wide
kubectl get pod -n bayn -l app.kubernetes.io/name=bayn-execution-controller -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.containerStatuses[0].imageID}{"\n"}{end}'
kubectl logs -n bayn -l app.kubernetes.io/name=bayn-execution-controller --since=10m
kubectl get job,pod -n bayn -l app.kubernetes.io/name=bayn-execution-activate -o wide
kubectl logs -n bayn -l app.kubernetes.io/name=bayn-execution-activate --since=10m
kubectl get pod -n bayn -l app.kubernetes.io/name=bayn -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.containerStatuses[0].imageID}{"\n"}{end}'
```

Expected:

- all four Argo applications are `Synced` and `Healthy`;
- the SealedSecret is current and the generated Secret exists before the worker pod starts;
- the operator reports one available worker revision at the committed image digest and drains the previous revision;
- the activation hook completes once for the exact committed plan and source;
- an explicitly bound previous native controller is inactive before its replacement becomes active;
- delayed native ticks project fresh controller status while authority remains read-only with no capital grant;
- the public status pod runs the same immutable image and reports exact reconciliation with zero unresolved mutations.

The expected impact is one active worker pod plus narrowly scoped PostgreSQL, TigerBeetle, ClickHouse, telemetry, DNS,
and broker-proxy network paths. The worker has no service-account token and accepts Restate requests only from the
`restate` namespace. The activation Job has no broker egress and its token-authenticated bootstrap call is made only by
the labeled GitOps hook.

Native controller rotation is available only when the replacement worker and activation hook are both bound to the
exact previous plan hash and source revision. The replacement quiesces previous-binding ticks, verifies and deactivates
that binding through the account-keyed Virtual Object, advances its epoch, and activates the replacement idempotently.
Until the release updater emits that complete reviewed binding, it must continue returning
`native-execution-controller-refresh-required` without changing GitOps. Never promote only the public status image
while execution remains pinned to an older plan.

Rollback is another serialized native-controller rotation, not pruning an active worker. Through a reviewed GitOps
change, bind the replacement to the exact current native plan and source so the bootstrap quiesces and deactivates the
current controller before activating its replacement. Do not delete Restate registrations, CRDs, PVCs, durable state,
or controller pods by hand. Confirm exact reconciliation, zero unresolved mutations, and no broker-ledger advance
before and after the handoff.
