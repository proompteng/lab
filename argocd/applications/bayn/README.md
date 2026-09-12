# Bayn GitOps rollout notes

## Streaming protocol activation

The streaming implementation uses `bayn.intraday-momentum.protocol.v3`. Its reviewed behavior, parameter, and protocol
hashes require a matching sealed research mandate; image promotion alone cannot update that strategy authority.
The mandate binds the published multi-architecture Bayn build, while Kargo updates its activation build lineage for
subsequent reviewed releases. Preserve the existing sandbox broker identity, risk policy, and limits when rotating it.

The worker selects `streaming` after Kafka compatibility, exact raw-feature joins for all strategy symbols, and
real-source strategy parity passed. Its versioned bootstrap budget is five minutes: the initial 905,542-record
catch-up completed in 223 seconds on the slower worker. Freshness and entry checks apply after catch-up. Verify the sealed request's
content hash, all three build-lineage bindings, the native activation hook, exact reconciliation, and natural controller
progress. Retained-data diagnostics establish observation now; they do not establish historical live availability.

## Regular-session trading boundaries

Migration 59 admits zero session-boundary offsets while retaining calendar ordering, exact offset bindings, and
historical cycle contracts. It changes constraints without rewriting cycle or execution evidence. Apply it through
normal worker startup before activating the new strategy identity. The submission window can start at market open;
the strategy still waits for its complete rolling lookback and decision delay.

The active day-trading policy admits entries until five minutes before the actual calendar close and starts forced
flattening at that same boundary. Close submissions remain eligible until the closing bell. Verify both regular and
early-close windows; unresolved exits must stay visible and cannot complete the cycle as flat.

This strategy change requires a reviewed research mandate rotation delivered through Kargo. Verify the exact image,
activation identity, stored cycle boundaries, natural controller progress, and unchanged broker/accounting state.
After zero-offset cycles exist, rollback must retain a runtime that can decode them. Do not restore the old positive-only
constraints or delete cycles to make an incompatible binary start.

## Archive reader availability evidence

Migration 58 adds the append-only `intraday_archive_availability` evidence table. The execution worker records the
first retained completed observation of each exact source record; historical replay only reads it. This rollout does
not alter strategy parameters, behavior identity, broker access, or the standing research mandate. Deliver it through
the existing Bayn build/release/GitOps path. Startup migrations must finish before the new execution worker runs.

Verify the exact worker source/image, successful migration, fresh controller progress, and unchanged reconciliation
and authority. Natural read receipts require an actual eligible session/read and must not be inferred from pod health.
Replay without historical receipts must remain incomplete in default recorded-reader mode. A compatible source rollback
may stop new collection but must retain the additive table and all receipts; never backfill receipt timestamps, delete
evidence, or submit a broker order as rollout proof.

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

### Research mandate rotation

The sealed research mandate is standing authority for its exact strategy, sandbox account, risk policy, and reviewed
build lineage. It has no calendar expiry and does not need a daily rotation. Every exchange session still creates a
separate durable cycle with its own entry cutoff, forced-flatten window, risk budget, reconciliation gate, and terminal
state. Rotate the mandate only when one of its bound identities changes.

A mandate rotation must update the request content hash, build lineage, and activation generation in one reviewed
change. Argo replaces the Secret in wave `-2`, rolls the controller in wave `-1`, runs the idempotent activation hook in
wave `0`, and rolls the read-only status service in wave `1`. The expected impact is one normal controller/status rollout
and a drained Restate worker revision; the activation hook itself cannot reach the broker.

After sync, require the SealedSecret to be current, the hook to succeed for the committed generation, the controller
sequence to advance naturally, `/readyz` and `/v1/status` to report the intended effective authority, and reconciliation
to remain exact with zero unresolved mutations. While the market is closed, also require zero new broker orders or
fills. If validation fails before activation, revert the complete request/hash/generation change through reviewed GitOps.
If activation has succeeded, first deactivate the native controller through reviewed GitOps and prove OBSERVE authority,
exact reconciliation, and no broker-ledger advance before replacing the mandate. Never roll back only the Secret or
invoke the activation handler manually.

The reviewed `main` build publishes the multi-architecture image and immutable `kargo-sha-<source>` alias. The
`lab-delivery/bayn` Warehouse correlates that tag with its exact main commit; the automatic Stage copies that source,
updates the status, worker, and activation bindings, and pushes `kargo/bayn`. Argo tracks that branch. The Stage also
updates the activation endpoint of the existing research build lineage while preserving its authored request and
build. The native hook still verifies the exact controller binding before the status service rolls out.

The `bayn-release` workflow, manifest-promotion command, and source-eligibility script are removed. Kargo is the only
writer of the generated deployment branch. Its bootstrap generation uses the immutable image digest hash; the
existing runtime idempotency key also binds source revision, account controller key, plan, and previous binding.

For the first cutover, merge the Warehouse, automatic Stage, immutable publisher, and ApplicationSet branch change
together. Argo may briefly report a missing `kargo/bayn` branch until the first build creates Freight and Kargo pushes
it; existing workloads remain running. If the root Application uses manual sync, sync only the reviewed `product`
ApplicationSet from the merged source to install Bayn's branch target and authorized-stage annotation. Workload
promotion and sync remain owned by Kargo. Verify the selected Freight digest, successful promotion, exact generated
commit, both workers and status replicas, natural controller progress, and fresh exact reconciliation. Recover a
failed promotion through Kargo; do not resume the retired workflow or introduce another deployment writer.

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
