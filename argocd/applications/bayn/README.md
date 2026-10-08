# Bayn GitOps rollout notes

## Research storage foundation

Research storage uses the standard Rook `ObjectBucketClaim` named `bayn-research-captures` in `rook-ceph`.
Its generated bucket name begins with `bayn-research-captures`; use `BUCKET_NAME` from the generated ConfigMap
rather than assuming the final name. The existing `rook-ceph-bucket` StorageClass targets `objectstore` and uses
`Retain`. The claim and source connection resources also disable Argo pruning and deletion.

Rook generates one ordinary bucket-owner credential. The bucket starts with a private ACL. This credential can
read, write, list, delete, and change sharing inside its bucket; it does not grant access to unrelated private buckets.
It is not a prefix-restricted writer. Application object keys use `captures/v1/` by convention. No actual data deletion
or public sharing is part of this rollout.

The `bayn-research-captures` Secret and ConfigMap in `bayn` reflect Rook's generated resources of the same name.
During first provisioning, the bucket provisioner replaces source metadata. Argo self-heal then restores the declared
reflection annotations while preserving the operator-owned data and owner references. Verify those annotations and
the reflected resources after this reconciliation; a Bound claim alone does not prove reflection is ready. Require both
applications to be Synced and the reflected Secret and ConfigMap data to match their sources without logging credentials.
The Secret supplies `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; the ConfigMap supplies `BUCKET_NAME`,
`BUCKET_HOST`, `BUCKET_PORT`, and `BUCKET_REGION`. Keep credential values in Secret references. No separate
RGW account, additional application user, IAM policy, policy allowlist change, or bootstrap Job is required for this path.
The existing controller-scoped RGW egress permits TCP 8080, the target of service port 80.

Bayn-specific acceptance does not run as a hook of the shared Rook application. The former
`bayn-research-storage-bootstrap` Job, code-only ConfigMap generator, and obsolete scripts are absent from desired state.
Its earlier positive checks did not complete
storage acceptance because its ListBuckets negative check failed. A successful shared Rook sync therefore says
nothing about Bayn capture readiness. Verify the native claim is Bound, its bucket ACL is private, its owner is unique,
the reflected connection resources are current, and a synthetic upload has identical SHA-256 readback before use.
Keep collection disabled until export integrity and sustained capacity qualification also pass.

The previous `bayn-research` account, bucket, users, Secrets, Bayn connection configuration, and retained synthetic fixtures
remain untouched and unused. Do not point the new claim at that existing bucket: provisioning can relink a bucket
that belongs to another owner. Cleanup or ownership transfer needs a separately reviewed migration.
[Rook's account documentation](https://rook.io/docs/rook/v1.20/Storage-Configuration/Object-Storage-RGW/ceph-object-accounts/)
marks the account CRD experimental and supported only with the Ceph main-branch image; the new native OBC path avoids it.

The existing two-instance `bayn-db` cluster retains 100Gi per replica through `rook-ceph-block` online expansion.
**The volumes cannot shrink back to 10Gi in place.** Verify both existing PVCs, their mounted filesystems, and the
primary's `pg_stat_replication`. The standby must be `streaming`, with `sync_state` of `sync` or `quorum`, and included
in `synchronous_standby_names`. CNPG's `ANY 1` configuration uses `quorum`. Keep `synchronous_commit=on`.

The disposable `bayn-wal-canary-v1` Job tests separate WAL storage before changing `bayn-db`. It runs the same
PostgreSQL 18.6 image on the current primary's host, with two isolated 4Gi `rook-ceph-block` claims, no credentials,
no Kubernetes token and no network access. Four shared/separate/separate/shared phases use one transaction client,
five seconds of warmup and twenty measured seconds each. The Job starts after workload readiness and waits another
five minutes for Kafka bootstrap to settle before testing. Verify that bootstrap actually completed before accepting
the comparison. A serialized data writer appends 128KiB of random bytes and calls
`fdatasync` no more than once per 100ms. It therefore adds at most 1.25MiB/s before storage delays. Both layouts retain
`fsync=on`, `full_page_writes=on`, `synchronous_commit=on` and the production `fdatasync` WAL method.

Archive every phase's transaction count, nearest-rank p50/p95/p99/max latency, count above one second, version/settings, WAL path,
filesystem and WAL IO counters. The Job emits raw measured transaction logs to stdout between phase markers,
including partial logs when the benchmark fails. Archive that stdout with `kubectl logs` before Pod or log retention
expires, and stream it from startup for complete diagnostics across log rotation. Raw transaction files and their
relative-path `raw.sha256` manifests are fsynced onto the named data PVC under
`/canary-data/bayn-wal-canary-v1/evidence/<layout>-<phase>`. Completed settings, phase summaries and WAL IO records
are retained there as JSON. Raw logging uses the data filesystem in both layouts; evidence synchronization happens
after the measured interval. Copy each closed phase directory from the running Pod and verify every raw hash and
summary before accepting the comparison. The data claim retains files after the Pod exits; if live collection is
interrupted, recover them through a reviewed read-only mount of that named claim before cleanup. Container stdout
alone may expose only the latest rotated segment. Termination cleanup emits completed samples between `BAYN_WAL_CANARY_FAILURE_RAW_BEGIN` and
`BAYN_WAL_CANARY_FAILURE_RAW_END` when the normal raw output did not complete. Cleanup omits files whose normal
raw output already completed. Treat interrupted output as an incomplete phase. Record simultaneous Ceph scrub and
shared IO conditions. A failed or incomplete Job has no comparative
result; it has no retry and a fifteen-minute active deadline including the settling interval. Startup and benchmark
failures emit their retained local logs. A failed competing writer also rejects the phase. These short local durability
measurements do not include cross-host synchronous replication, S3 verification or original-session receipt capacity. The production
database and its storage remain unchanged. CNPG 1.30.1 supports adding WAL volumes to an existing cluster, but
cannot remove them afterward. Only measured improvement can justify that subsequent reviewed layout change.
See [CNPG's exact-version addition tests](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/tests/e2e/pg_wal_volume_test.go)
and [storage contract](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/docs/src/storage.md).

After archiving and checking the result, remove only the canary Job, NetworkPolicy, generated script ConfigMap,
two named canary claims and their desired-state references through a reviewed GitOps change. The claims contain
only this experiment. Preserve `bayn-db`, all existing PVCs and its backup/replication settings during cleanup.

Bayn overrides CNPG's five-second WAL sender and receiver inactivity deadlines with PostgreSQL's sixty-second
defaults. At 2026-10-06 23:11 UTC, storage stalls exceeded five seconds and caused repeated replication disconnects,
quorum loss and recovery churn. The larger replication heartbeat window prevents that additional churn; it does
not repair storage latency or extend application query, reconciliation, capture or trade deadlines. An inactive
replication connection can now take sixty seconds to terminate. This is scoped to `bayn-db`; operator configuration,
CNPG failover policy and synchronous durability stay unchanged. After GitOps reconciliation, verify both values
on both instances, `pending_restart=false`, one streaming quorum standby, and exact financial readback.
See [PostgreSQL replication settings](https://www.postgresql.org/docs/18/runtime-config-replication.html) and
[CNPG configuration precedence](https://cloudnative-pg.io/docs/1.28/postgresql_conf/).

Apply the reviewed `bootstrap` ApplicationSet change so Argo preserves the new Rook-managed Secret and ConfigMap
fields. Let Rook provision its native claim and Bayn follow normal Kargo promotion. Require the common Rook sync
operation to succeed. Report any pre-existing Ceph deep-scrub health warning separately. Preserve all retained storage
and credentials during recovery, and keep the expanded database size during a code rollback.

## Jev protocol activation

The active implementation uses momentum-first `bayn.jev.protocol.v2` and pinned TypeSafe model `jev-1.13.0`. Its behavior, parameter, and protocol
hashes require a matching sealed research mandate; image promotion alone cannot update that strategy authority.
The mandate binds the published multi-architecture Bayn build, while Kargo updates its activation build lineage for
subsequent reviewed releases. Preserve the existing sandbox broker identity and every limit outside an explicitly reviewed mandate change.

The active entry gate requires exact positive own and SPY-relative 30-minute momentum before Jev. It is bound to
`bayn.jev.momentum-first.behavior.v1`, protocol v2 and batch v4; Jev's probability ranking, questions, sizing and
position management remain unchanged. Its build hashes, sealed mandate and all three runtime lineages change together.
The paired Research mandate selects the approved $1,000,000 sandbox daily gross-turnover budget, with the same account,
credentials, exposure/loss limits and exits. Account/day turnover is retained across the rotation.

Verify strategy protocol hash `3b062274793e0a13b97334dbb38858e7322cc045280d0a8ed36b533aa8f38111` and mandate request hash
`8f85240c1a0f8d54650b0914cbfadf3245311c32c650f2a295cc76dabad7063f` against the runtime and sealed identity annotation.
The image's build-account policy hash is not the account-bound risk hash in the mandate. Retained v1-v3 evidence remains
immutable and decodable. Rollback needs a reviewed source/mandate pair through native drain and fresh flat/exact
preflight; never restore obsolete identity expectations, rewrite evidence or reset turnover to make a binary start.

The Jev mandate preserves the existing published build as its lineage anchor and binds the new strategy explicitly.
Kargo writes the exact newly published source and image into the activation endpoint of every runtime lineage. The
previous strategy cannot execute against the Jev mandate. The activation hook still requires compatible durable
state and exact reconciliation before replacing the account-keyed controller.

Only the execution worker receives `BAYN_JEV_API_KEY` from `bayn-jev-auth`, delivered by the SealedSecrets controller
before worker rollout. Jev uses a scoped HTTP CONNECT client through the existing egress proxy. The allowlist contains
the three exact Alpaca API hosts and `api.typesafe.ai`; direct external worker access remains unavailable. A missing
credential or unavailable provider blocks new entries while deterministic position-reducing management remains active.
The public status service and activation hook do not receive the model credential.

The worker requires Kafka and consumes verified raw-feature joins through the common market-data adapter. Its versioned bootstrap budget is five minutes: the initial 905,542-record
catch-up completed in 223 seconds on the slower worker. Freshness and entry checks apply after catch-up. Verify the sealed request's
content hash, all three build-lineage bindings, the native activation hook, exact reconciliation, and natural controller
progress. Retained-data diagnostics establish observation now; they do not establish historical live availability.

Without a configured research capture, each worker starts its existing read-only Kafka projection when the endpoint
starts. The trading driver, broker session, model client and capital activation remain lazy. The same server-scoped
projection is reused by the first execution runtime and its replacements, without another consumer. Bootstrap remains
asynchronous: an accepting TCP endpoint does not imply complete signal history, and existing snapshot checks still
reject rebuilding, missing or late input. A configured capture retains its existing lazy recorder/consumer lifecycle;
prewarm does not start SQL/S3 recording on standby replicas.

Prewarm moves the eventual per-replica consumption earlier. Both current replicas, and old/new replicas overlapping
during rollout, can consume concurrently; it is not a claim of zero additional aggregate CPU or memory. Keep the
existing resource limits and verify aggregate CPU/RSS, queue/backlog recovery and scoped consumer cleanup. Warming a
replica does not make an upstream bar published outside its permitted finalization window admissible.

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

## Historical evidence after the hard migration

The worker no longer collects archive-reader receipts or falls back to ClickHouse for trading input. Historical
receipts and financial records remain append-only in PostgreSQL. The backtest command consumes frozen datasets
through the common market-data interface and binds each run to its source manifest, clock, and simulated broker.

## Native Restate execution cutover

The `bayn-execution-controller` `RestateDeployment` is the single execution scheduler. It starts with read-only broker
access and no capital authority. A source-versioned Argo sync hook authenticates to the Restate ingress, verifies the
exact source/image/strategy/account plan and current native binding, then idempotently activates or rotates the
account-keyed native controller through its shared `activateDeployment` handler. The public Bayn deployment rolls
out after that verified native binding. The worker advertises exactly `BaynExecutionController` and
`BaynBrokerObservations`; deployment activation does not have a separate service or object.

The activation handler is shared so its wait for native progress cannot block exclusive ticks on the same account.
Only that handler accepts ingress calls, authenticated with the existing activation credential. Controller
`activate`, `deactivate`, `tick` and `status`, and every broker-observation handler, remain private. The activation
result is retained for seven days; the journal is removed at completion to discard the bearer header. The Job reads
`BAYN_EXECUTION_ACTIVATION_ATTEMPT_ID` from its Kubernetes controller UID through the Downward API. Container restarts
and replacement Pods in that Job reuse the same invocation, including after the client's bounded completion wait
expires. Missing or invalid Job identity fails before invocation. A recreated Job has a new UID and can retry a retained
terminal failure after its dependency recovers. This identity does not deduplicate separate Job incarnations.
The acceptance log records the attempt UID, `activationInvocationId`, source revision and receipt status before waiting.
The verified log retains the completed successor proof after the successful hook is removed.

The execution controller runs two ready replicas spread across Kubernetes hostnames. The topology constraint matches the
operator-added `pod-template-hash`, so retained draining ReplicaSets cannot satisfy spreading for the current revision and
leave both current workers on one node. Restate remains the only scheduler and serializes the account-keyed virtual
object; replicas do not become independent execution owners. Every durable cycle-state and authority-state mutation, and
the aggregate execution transaction, acquires the same transaction-scoped PostgreSQL advisory writer fence. A crashed or
disconnected transaction releases that ownership automatically so a healthy replica can take the next durable invocation
without waiting for a process-lifetime lease. A disruption budget keeps at least one controller pod available during
voluntary node maintenance. The controller and activation hook remain architecture-neutral and use the reviewed
multi-architecture image.

Bayn leaves `drainDelaySeconds` unset and uses the
[Restate operator 3.0.1 default five-minute post-drain grace](https://github.com/restatedev/restate-operator/blob/v3.0.1/src/resources/restatedeployments.rs#L321-L330).
The former zero-delay override addressed a process-wide writer fence. Transaction-scoped fencing now allows old and
current workers to coexist while native invocations drain. The operator checks active usage before removal; pinned
invocations, including paused ones, count as active. The grace preserves an inactive endpoint between usage checks,
but does not guarantee protection against every late-arrival race or restore a historical ReplicaSet already at zero.
Argo readiness still requires the current registered generation and ready replicas; it does not wait for old revisions
to reach zero. Activation deadlines and the Pod termination grace remain unchanged.

The public Bayn process is read-only status/health only and owns no writer fence or scheduler. It runs two replicas,
spreads them across Kubernetes hostnames, and keeps at least one available during voluntary disruption. Its stateless
CONNECT-only trading API egress proxy uses the same two-replica, hostname-spread, minimum-one-available contract, so broker
readiness does not collapse back onto a single proxy pod. This gives the status/readiness plane node-failure tolerance
independently of the singleton execution owner and also continuously exercises the same immutable image on whatever
supported architecture the scheduler selects.

Squid runs in the foreground as the container's PID 1, with Kubernetes managing its lifecycle. Its PID file is disabled
so a retained `/run/squid` volume cannot make the restarted process mistake its own reused PID for another instance.
Validate startup with a stale PID file and recovery after an abrupt process kill using the pinned image:

```sh
bash packages/scripts/src/bayn/verify-egress-proxy-restart.sh
```

This Docker regression runs without external networking and also verifies that an unlisted CONNECT destination remains
denied before and after restart.

Before merging this layer, require the `restate-operator-crds`, `restate-operator`, and `restate` Argo applications to
be `Synced` and `Healthy`, and verify the Restate request-identity foundation described in
`argocd/applications/restate/README.md`. The bootstrap `SealedSecret` uses sync wave `-2` and the repository's
current-generation health gate; its name remains `bayn-execution-bootstrap` to preserve the existing credential
identity and ciphertext. Both callers read it through `BAYN_EXECUTION_ACTIVATION_TOKEN`. The `RestateDeployment`
follows in wave `-1`, activation runs in wave `0`, and the
read-only status deployment follows in wave `1`. A missing Secret, unregistered worker, native-binding mismatch, or
activation-verification failure blocks the sync before the public status rollout.

After the normal Argo sync, verify the handoff without printing credentials or invoking activation by hand:

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
- zero legacy lifecycle registrations exist and Restate exposes the account-keyed native controller and private
  `BaynBrokerObservations` object through the existing worker endpoint, with `activateDeployment` as the sole public
  handler;
- migration 87 is applied before endpoint registration; deployment activation drains the predecessor, publishes a fresh
  source-bound `broker_observations` projection, then activates the native controller. PostgreSQL reads prove its
  timestamp advances across background polls and its source revision matches the promoted image. Unavailable,
  expired or invalidated observations block execution instead of issuing broker GETs from normal submission;
- delayed native ticks project fresh controller status while the worker's static broker/capital configuration remains
  read-only/none; any effective execution authority must still come only from the separately sealed and validated
  durable capital generation;
- two public status pods and two stateless broker-proxy pods occupy distinct hostnames within each workload when at
  least two eligible nodes are available; both status replicas report exact reconciliation with zero unresolved
  mutations.

The expected impact is two ready execution-worker pods plus two read-only status pods, two stateless broker-proxy pods,
and narrowly scoped PostgreSQL, TigerBeetle, ClickHouse, telemetry, DNS, and broker network paths. The workers have no
service-account token and accept Restate requests only from the `restate` namespace. The activation Job has no broker
egress and its token-authenticated deployment activation call is made only by the labeled GitOps hook.

### Research mandate rotation

The sealed research mandate is standing authority for its exact strategy, sandbox account, risk policy, and reviewed
build lineage. It has no calendar expiry and does not need a daily rotation. Every exchange session still creates a
separate durable cycle with its own entry cutoff, forced-flatten window, risk budget, reconciliation gate, and terminal
state. Rotate the mandate only when one of its bound identities changes.

A mandate rotation must update the request content hash, build lineage, and activation generation in one reviewed
change. Argo replaces the Secret in wave `-2`, rolls the controller in wave `-1`, runs the idempotent activation hook in
wave `0`, and rolls the read-only status service in wave `1`. The expected impact is one normal controller/status rollout
and a drained Restate worker revision; the activation hook itself cannot reach the broker.

The SealedSecret's `proompteng.ai/bayn.mandate-identity` annotation records the request hash, strategy identity, authored
build, and ciphertext hash without exposing the broker account. The manifest check compares it with the compiled
strategy and all three runtime lineages. Regenerate this annotation from the validated request when sealing it;
changing an annotation does not authorize a different encrypted request. Runtime validation remains authoritative.
Invalid static mandate configuration fails preparation with its specific reason before authority recovery begins.

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
writer of the generated deployment branch. Its activation generation uses the immutable image digest hash; the
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

### Execution activation service migration

This is a hard route migration from `BaynExecutionBootstrap/start` to
`BaynExecutionController/<account-key>/activateDeployment`, with the single
`bayn.execution-deployment-activation.v1` request contract. Worker and activation Job must use the same promoted
image. Native controller state, tick and mutation contracts, account keys and credentials are unchanged. No legacy
handler is served by the replacement endpoint.

Activation follows the [Job-scoped retry contract](#native-restate-execution-cutover). The Job's `OnFailure` container
retries and replacement Pods reuse the same invocation, including a retained terminal failure. A recreated Job supplies
a new identity after its dependency recovers. Native account ownership and controller mutations remain idempotent
across attempts. Successful results retain their invocation ID for inspection; the completed request journal containing
the bearer header is discarded.

Removing a service from discovery does not remove its existing Restate metadata. Operator 3.0.1 keeps an old
deployment while it is latest for any service or has nonterminal invocations; see its
[registration](https://github.com/restatedev/restate-operator/blob/v3.0.1/src/controllers/restatedeployment/registration.rs)
and [cleanup](https://github.com/restatedev/restate-operator/blob/v3.0.1/src/controllers/restatedeployment/cleanup.rs)
contracts. The first rollout therefore needs a separately reviewed registration retirement through the existing
GitOps procedure. Before retiring only `BaynExecutionBootstrap`, prove that no nonterminal invocation targets it,
that both current services point to the exact replacement deployment, and that its authenticated activation has a
completed successor receipt with fresh broker observations. Preserve native state, retained invocation evidence and
registrations still used by either current service. Verify the retired service is absent and the old worker drains
afterward. Do not add a compatibility registration or restore the historical destructive lifecycle hook.

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
