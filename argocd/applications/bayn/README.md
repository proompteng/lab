# Bayn GitOps rollout notes

## Native Restate execution cutover

The `bayn-execution-controller` `RestateDeployment` is the single execution scheduler. It starts with read-only broker
access and no capital authority. A source-versioned Argo sync hook authenticates to the Restate ingress, verifies the
exact source/image/strategy/account plan, deactivates the legacy lifecycle owner, and only then activates the native
controller. The public Bayn deployment rolls out after that verified handoff.

Before merging this layer, require the `restate-operator-crds`, `restate-operator`, and `restate` Argo applications to
be `Synced` and `Healthy`, and verify the Restate request-identity foundation described in
`argocd/applications/restate/README.md`. The bootstrap `SealedSecret` uses sync wave `-2` and the repository's
current-generation health gate; the `RestateDeployment` follows in wave `-1`, activation runs in wave `0`, and the
read-only status deployment follows in wave `1`. A missing Secret, unregistered worker, legacy-binding mismatch, or
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
- the legacy lifecycle state is inactive before native controller state becomes active;
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

Rollback is another serialized ownership transfer, not pruning an active worker. Through a reviewed GitOps change,
deactivate the native controller and prove its writer fence is clear before activating a compatible legacy or replacement
controller. Do not delete Restate registrations, CRDs, PVCs, durable state, or controller pods by hand. Confirm exact
reconciliation, zero unresolved mutations, and no broker-ledger advance before and after the handoff.

## Legacy Restate registration retirement

`restate-registration-cleanup.yaml` is the final temporary PostSync retirement hook for the legacy
`BaynLifecycle`/`BaynLifecycleBootstrap` registration. The prior reviewed cleanup removed the first 17 immutable
allowlisted deployments. This final layer accepts only two states: the exact singleton
`dp_14g38iazTnn3gWZzr8Ze0i5`, or the fully retired empty set. Any other nonzero subset, unknown lifecycle classifier
member, endpoint/service-set drift, source metadata drift, revision drift, or lifecycle/pinned nonterminal invocation
fails closed before mutation.

For the singleton, the hook also requires the current native deployment
`dp_14MYpEXKeHNXBkzJQMMIHSx` at
`http://bayn-execution-controller-686554d857.bayn.svc.cluster.local:9080/`, exactly
`BaynExecutionController` + `BaynExecutionBootstrap` revision 11, recent completed ticks pinned to that deployment, a
bounded current native nonterminal tick set, and no nonterminal native tick pinned elsewhere. Only after those checks are
repeated immediately before mutation does the hook perform one exact force removal:
`restate deployments remove --force -y dp_14g38iazTnn3gWZzr8Ze0i5`. There is no other force target.

Restate accepts deployment deletion asynchronously, so the hook polls a bounded 30 times at two-second intervals. It
requires the final deployment and both legacy services to disappear, keeps checking zero lifecycle/pinned nonterminal
invocations, and revalidates the native rev11 deployment, services, and tick continuity on every poll. Zombie legacy
invocations, service residue, unexpected partial disappearance, native collateral, or timeout fails the hook. Once both
the deployment and services are absent, that removal transaction completes only while native rev11 continuity still
holds. Later already-empty reruns are idempotent and validate only that no allowlisted/classified legacy deployment,
legacy service, or legacy/pinned nonterminal invocation has reappeared; they deliberately do not pin future legitimate
native execution rollouts to deployment `dp_14MYpEXKeHNXBkzJQMMIHSx`, its endpoint, or revision 11.

The hook has no service-account token, credentials, broker access, or Restate ingress access. Egress is limited to
cluster DNS and Restate admin TCP 9070. Its pod keeps the historical
`app.kubernetes.io/name=bayn-lifecycle-register` label so the already-live Restate admin ingress policy authorizes this
cross-Application retirement without requiring Restate Application ordering. Because Argo hooks themselves do not
contribute to Application sync status, the tracked cleanup NetworkPolicy carries the inert
`bayn.proompteng.ai/retirement-sync=final-legacy-registration-v2` annotation. That one metadata delta makes the current
revision OutOfSync so automated sync naturally runs the PostSync hook; it does not widen network access or alter the
cleanup pod selector. Do not terminate invocations, delete services generically, mutate Restate directly, or apply/sync
cluster state by hand; failures remain GitOps-reviewed.

The first final transaction, `bayn-restate-registration-final-retirement`, failed before mutation on its first read-only
Restate SQL request with `Unable to connect to the Restate server`; its retained pod exited once with restart count zero,
so the force-removal command was never reached. The v2 transaction therefore uses the fresh fixed Job name
`bayn-restate-registration-final-retirement-v2` and retries only an individual read-only `restate sql` probe, bounded to
30 attempts at two-second intervals. This absorbs transient pod-start/admin reachability without retrying the destructive
command or the whole transaction.

The v2 Job retains `backoffLimit: 0`, `restartPolicy: Never`, no finished-Job TTL, and Argo `HookSucceeded` deletion
only. A successful transaction is removed so later already-empty syncs can rerun against future native revisions. A
failed transaction remains under its fixed name; Argo cannot create another named instance and reinterpret a post-force
failure as a clean empty rerun. Advancing after such a failure therefore requires a new reviewed GitOps correction
rather than an automatic Job or sync retry.
