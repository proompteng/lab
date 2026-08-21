# Bayn GitOps rollout notes

## Native Restate execution cutover

The `bayn-execution-controller` `RestateDeployment` is the single execution scheduler. It starts with read-only broker
access and no capital authority. A source-versioned Argo sync hook authenticates to the Restate ingress, verifies the
exact source/image/strategy/account plan and current native binding, then idempotently activates or rotates the
account-keyed native controller. The public Bayn deployment rolls out after that verified native binding.

The execution controller runs two ready replicas spread across Kubernetes hostnames. The topology constraint matches the
operator-added `pod-template-hash`, so retained draining ReplicaSets cannot satisfy spreading for the current revision and
leave both current workers on one node. Restate remains the only scheduler and serializes the account-keyed virtual
object; replicas do not become independent execution owners. Every durable cycle-state and authority-state mutation, and
the aggregate execution transaction, acquires the same transaction-scoped PostgreSQL advisory writer fence. A crashed or
disconnected transaction releases that ownership automatically so a healthy replica can take the next durable invocation
without waiting for a process-lifetime lease. A disruption budget keeps at least one controller pod available during
voluntary node maintenance. The controller and activation hook remain architecture-neutral and use the reviewed
multi-architecture image.

The public Bayn process is read-only status/health only and owns no writer fence or scheduler. It runs two replicas,
spreads them across Kubernetes hostnames, and keeps at least one available during voluntary disruption. Its stateless
CONNECT-only Alpaca egress proxy uses the same two-replica, hostname-spread, minimum-one-available contract, so broker
readiness does not collapse back onto a single proxy pod. This gives the status/readiness plane node-failure tolerance
independently of the singleton execution owner and also continuously exercises the same immutable image on whatever
supported architecture the scheduler selects.

Before merging this layer, require the `restate-operator-crds`, `restate-operator`, and `restate` Argo applications to
be `Synced` and `Healthy`, and verify the Restate request-identity foundation described in
`argocd/applications/restate/README.md`. The bootstrap `SealedSecret` uses sync wave `-2` and the repository's
current-generation health gate; the `RestateDeployment` follows in wave `-1`, activation runs in wave `0`, and the
read-only status deployment follows in wave `1`. A missing Secret, unregistered worker, native-binding mismatch, or
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
- the operator reports two ready worker replicas at the committed image digest, spread across eligible hostnames, and
  drains the previous revision;
- the activation hook completes once for the exact committed plan and source;
- zero legacy lifecycle registrations exist and Restate exposes only the account-keyed native controller service;
- delayed native ticks project fresh controller status while the worker's static broker/capital configuration remains
  read-only/none; any effective execution authority must still come only from the separately sealed and validated
  durable capital generation;
- two public status pods and two stateless broker-proxy pods occupy distinct hostnames within each workload when at
  least two eligible nodes are available; both status replicas report exact reconciliation with zero unresolved
  mutations.

The expected impact is two ready execution-worker pods plus two read-only status pods, two stateless broker-proxy pods,
and narrowly scoped PostgreSQL, TigerBeetle, ClickHouse, telemetry, DNS, and broker network paths. The workers have no
service-account token and accept Restate requests only from the `restate` namespace. The activation Job has no broker
egress and its token-authenticated bootstrap call is made only by the labeled GitOps hook.

The reviewed `main` build publishes an immutable image, then the release workflow atomically advances the status,
controller, and activation pins on `codex/bayn-deploy`. Argo watches that generated branch directly, so a second
promotion pull request is neither required nor permitted. A release is held without advancing the branch when strategy
or runtime identity changes require new trading evidence. The durable controller plan identifies the orchestration
protocol rather than a particular worker build; every successful tick records the exact worker source revision, while
strategy, account, market-data, risk, and authority bindings remain validated by the execution pass.

Rollback is another serialized native ownership transfer, not pruning an active worker. Through a reviewed GitOps
change, move the account-keyed binding to a compatible native replacement, or deactivate the native controller so Bayn
returns to OBSERVE-only operation. Never recreate the retired legacy controller. Do not delete Restate registrations,
CRDs, PVCs, durable state, or controller pods by hand. Confirm exact reconciliation, zero unresolved mutations, and no
broker-ledger advance before and after the handoff.

## Legacy Restate registration retirement

The legacy `BaynLifecycle`/`BaynLifecycleBootstrap` Restate registration set is fully retired. The reviewed transaction
removed all 18 immutable legacy deployment registrations and both legacy service rows with zero lifecycle/pinned
nonterminal invocations, while the native `BaynExecutionController`/`BaynExecutionBootstrap` revision remained current
and active.

The destructive one-shot retirement Job, its dedicated Bayn egress policy, and the matching Restate admin-ingress
exception are no longer part of desired state. Any future `BaynLifecycle`, `BaynLifecycleBootstrap`, or
`bayn-lifecycle-*` registration is unexpected drift. Do not recreate the destructive retired hook or mutate Restate
registrations by hand; investigate the producer and correct desired state through a reviewed GitOps change.

### Retired-hook garbage collection complete

The temporary failed-hook tombstone converged naturally at `ecfc682711d9d7e663fe7b0b603538c802699249`. Argo deleted
the historical failed `bayn-restate-registration-final-retirement` Job/pod, ran the tokenless same-name no-op once, and
deleted that successful replacement. The live proof after convergence retained zero legacy
`BaynLifecycle`/`BaynLifecycleBootstrap` deployments, services, and nonterminal invocations; native revision 11 remained
current with its scheduled tick sequence advancing; and the unrelated `Greeter` deployment remained present.

The one-sync tombstone is no longer desired state. This cleanup removes its manifest so Argo naturally prunes the
temporary deny-all `bayn-restate-retirement-hook-gc` NetworkPolicy. Do not recreate the tombstone or the destructive
retirement hook unless a new independently reviewed recovery procedure explicitly requires it.
