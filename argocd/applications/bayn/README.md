# Exception tracking

Bayn's main API, native Restate execution controller and activation job, and
independent research worker send **errors only** to dedicated GlitchTip projects
(`proompteng/bayn`, `proompteng/bayn-execution`, and `proompteng/bayn-research`).
`argocd/applications/bayn/glitchtip-dsns.yaml` contains public Sentry ingestion
identifiers (not credentials) using the cluster-local GlitchTip web service.
Sentry JavaScript requires the 32-character hexadecimal key **without UUID
hyphens**, even though GlitchTip displays it as a UUID in its database.

- Official `@sentry/node` captures uncaught exceptions and terminal Effect
  causes; successful/expected Effect operations do not emit issues and normal
  shutdown interruption is ignored. Terminal Effect failures await a bounded SDK
  flush before process exit, preserving the original failure if delivery fails.
- Committed reconciliation discrepancies emit one error per unchanged discrepancy
  set in each process, including an already blocked account after restart. Exact
  reconciliation resets that suppression. Events include discrepancy kinds and
  the reconciliation hash, without account identities, balances or broker payloads.
- Scrubbing removes request, user, breadcrumbs, contexts, runtime variables,
  source snippets and exception messages. Stack frames retain grouping fidelity.
- No Sentry tracing, profiles or request-body collection. Continue to use
  Effect/OTel to Grafana Tempo for spans, Loki for logs, Mimir for metrics. Runtime
  diagnostics-channel injection and Sentry's OpenTelemetry setup are disabled.
- Network policies permit only TCP 8000 to GlitchTip's in-cluster web pods;
  there is no requirement for Tailscale or external public egress from Bayn.
- The release is the reviewed source SHA, with service role and an optional
  active OpenTelemetry trace ID as tags.

Verify the deployed immutable image first, then execute the dedicated
`dist/glitchtip-smoke-command.js` once per service role with its configured
`BAYN_GLITCHTIP_DSN`. The smoke must finish without SDK DSN warnings and its
synthetic exception must appear in the corresponding GlitchTip project. This
command is **not** run automatically from the trading service at startup.

# Bayn GitOps rollout notes

## Isolated Jev instruction research

The same immutable image includes `bayn-gepa` for bounded native Jev question optimization. Use the
[Jev optimization runbook](../../../docs/bayn/jev-optimization.md) for frozen manifests, durable object-store evidence, restart behavior,
and deployed verification. It uses the worker's existing research API and storage identity. It needs no broker access
or additional network/database grants.

`research-worker.yaml` runs `BaynResearchRun` and the independent public-information jobs. Model research permits one
inference in flight and uses a separate two-connection PostgreSQL pool; public collection uses HTTP and object storage.
The worker receives the existing Jev credential for native probes. It has no broker, capital, Kafka, ClickHouse or TigerBeetle credential. Kargo's
existing `bayn-main` renderer supplies the same verified immutable image as the other Bayn workloads. Research rolls
out after execution activation and the public service, so its initial grants cannot delay their rollout.
Recovery pauses only the research worker through GitOps; it does not change trading authority.

The approved `bayn_research` CNPG-managed role uses `bayn-research-db` for its password and connection URI. It is
neither a superuser nor a role/database creator and has a two-connection limit. After migration 0093 has created the
tables, apply these approved grants through the existing database administration path:

```sql
GRANT CONNECT ON DATABASE bayn TO bayn_research;
GRANT USAGE ON SCHEMA public TO bayn_research;
GRANT SELECT, INSERT ON research_inference_runs, research_inference_receipts TO bayn_research;
```

Verify that it cannot UPDATE receipts, access trading tables, create schema objects or post expenses. Existing
accounting workers own expense posting and verification. The worker fails closed until the tables and grants exist.
The paired source-egress and database-ingress rules permit only the required PostgreSQL connection.

Each run requires HMAC-SHA256 operator approval over its exact canonical identity, including source, study, context,
attempt, deadline/token budget and cost basis. The operator CLI and worker receive the separate 32-byte random
approval key from `bayn-research-authority`, key `run-approval-key`, as `BAYN_RESEARCH_APPROVAL_KEY`. Only the signed proof
travels through Restate. Changed or unsigned runs are rejected before the durable inference step; a signed run can
transmit once. Do not print credentials or put plaintext in source or process arguments.

Worker metrics are exported to Mimir and native/Effect traces to Tempo. `bayn-research.rules` in the existing Mimir
rule source covers missing telemetry, repeated failed attempts and incomplete expense coverage. Verify actual
instruction proposals, cancellation, retained replay, expense recovery and matching Loki/Tempo/Mimir evidence against
the deployed revision. Synthetic acceptance does not establish economic qualification or session latency.

The Bayn worker follows the Bayn Kargo Stage. Verify its promoted source/image and Flamingo's pinned serving image,
model/tokenizer revisions and five response serving-identity fields before the first signed acceptance run.
Flamingo's reviewed GitOps manifests own its deployment; there is no separate Bayn model Stage or provisioner.
An endpoint without the identity header is rejected; research cannot fall back to alias-only provenance.

The CPU-only `bayn-opencode` Deployment shares Bayn's immutable image and Kargo Stage. It receives no financial or
provider credential. Only the research worker can call its proposal Service; its native API and one-call provider relay
remain on loopback. Preserve `bayn-opencode-state`: it contains the study sessions and exclusive claims used to reject
ambiguous retries. `Recreate` keeps one writer. The worker admits explicit policies through
`BAYN_RESEARCH_INFERENCE_POLICIES`; changing a policy requires a reviewed release. Verify a real signed proposal and
retained native receipt after rollout. Neither a healthy pod nor a zero-cost provider response establishes improvement.

Original-session eligibility, preparation expenses and comparison requirements are described in the
[research contract](../../../docs/bayn/jev-optimization.md). Invalidated or unsealed captures cannot establish
complete original coverage; do not manufacture descriptions or later outcomes to make old captures eligible.

Kargo writes activation Job and pod version labels as `sha-<12-character revision>`. The prefix keeps numeric and
exponent-looking commit prefixes as YAML strings, as Kubernetes requires for label values. The activation Job name,
full source revision, immutable image digest and authored research lineage retain their existing contracts.

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
RGW account, additional application user, IAM policy, policy allowlist change, or bootstrap Job is required to retain
these resources.

The execution worker receives no research bucket credential and has no research-specific RGW egress rule.
The in-process capture configuration and recorder are removed. The public status service and activation hook also
receive no research credential. Longer-lived market-data archives must run outside trading through the separate
[market-data archive boundary](../../../docs/bayn/market-data-archive.md).

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

The disposable WAL comparison completed on 2026-10-08 at source `9bb51b5c1fc38033cacd4c1d732d81a08fd7c460`
([PR #14855](https://github.com/proompteng/lab/pull/14855)). PostgreSQL 18.6 measured four twenty-second phases on
isolated `rook-ceph-block` volumes on the primary host, after Kafka bootstrap completed. One transaction client
ran alongside a bounded data writer. Both layouts retained `fsync=on`, `full_page_writes=on`,
`synchronous_commit=on` and `wal_sync_method=fdatasync`.

| Phase | Layout | Transactions | p95 (ms) | p99 (ms) | Maximum (ms) | Above 1 second |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Shared | 975 | 88.359 | 445.288 | 1425.809 | 1 |
| 2 | Separate | 2522 | 23.163 | 97.308 | 329.558 | 0 |
| 3 | Separate | 2221 | 26.805 | 105.383 | 962.324 | 0 |
| 4 | Shared | 2323 | 27.000 | 112.975 | 342.442 | 0 |

All 8,041 samples, nearest-rank percentiles, settings and WAL IO records were independently verified against
streamed logs and retained PVC files with SHA-256 manifests before cleanup. Time-aligned Ceph, host, RBD,
PostgreSQL and CPU-throttling queries were available. The repeated shared phase was comparable to the separate
phases, so the first shared spike does not establish a reproducible layout benefit. These short local durability
measurements do not qualify cross-host replication, S3-plus-SQL capture capacity or profitability.
`bayn-db` retains its existing storage layout. The canary Job, policy, script ConfigMap and two isolated claims are
removed from desired state after archival; production database volumes and backup/replication settings are preserved.

Bayn overrides CNPG's five-second WAL sender and receiver inactivity deadlines with PostgreSQL's sixty-second
defaults. At 2026-10-06 23:11 UTC, storage stalls exceeded five seconds and caused repeated replication disconnects,
quorum loss and recovery churn. The larger replication heartbeat window prevents that additional churn; it does
not repair storage latency or extend application query, reconciliation, capture or trade deadlines. An inactive
replication connection can now take sixty seconds to terminate. This is scoped to `bayn-db`; operator configuration,
CNPG failover policy and synchronous durability stay unchanged. After GitOps reconciliation, verify both values
on both instances, `pending_restart=false`, one streaming quorum standby, and exact financial readback.
See [PostgreSQL replication settings](https://www.postgresql.org/docs/18/runtime-config-replication.html) and
[CNPG configuration precedence](https://cloudnative-pg.io/docs/1.28/postgresql_conf/).

Bayn sets `monitoring.metricsQueriesTTL: 1s` so the existing five-second metrics scrape obtains fresh catalog
observations. CNPG otherwise caches query results for thirty seconds, even when the exporter is scraped more often.
The one-second cache still coalesces closely spaced scrapes; this setting applies only to `bayn-db` and changes no
database durability or application deadline. Verify the live Cluster field, both exporters' collection errors and
scrape durations, and changes in the retained replication reply-age or active walsender query-age samples after
GitOps reconciliation. A five-second scrape timestamp alone does not prove a fresh database observation.
See [CNPG output caching](https://cloudnative-pg.io/docs/1.28/monitoring/#output-caching).

Apply the reviewed `bootstrap` ApplicationSet change so Argo preserves the new Rook-managed Secret and ConfigMap
fields. Let Rook provision its native claim and Bayn follow normal Kargo promotion. Require the common Rook sync
operation to succeed. Report any pre-existing Ceph deep-scrub health warning separately. Preserve all retained storage
and credentials during recovery, and keep the expanded database size during a code rollback.

## Jev protocol activation

The checked-in capital activation uses `bayn.jev.protocol.v20`, `bayn.jev.executable-profit-limit.behavior.v1`,
trading-signal state v17, batch v6 and pinned `jev-1.13.0`. Jev separately classifies the current setup and judges a complete funded entry/stop/target trade after costs within its holding deadline. Both answers must support entry; either judgment can abstain. Its options label hypothetical future order prices
separately from observed market evidence. The selected complete plan binds those terms to the order and existing account
limits. [Strategy protection](../../../docs/bayn/strategy-protection.md) defines the model contract, venue capabilities
and remaining economic assumptions. Native children and protective disposals share ordinary reconciliation and accounting.

The source implementation now defines protocol v21 and trading-signal state v18 with market-specific holding limits:
15 minutes for equities and 60 minutes for crypto. The observation window stays at 30 minutes, and the selected
funded plan owns the holding deadline. Migration 144 preserves financial history and native protection/commitment
guards, requires a flat, settled, fully accounted and freshly reconciled cutover, and restricts prior PAPER authority
to OBSERVE. Do not replace the v20 activation with a v21 mandate until strategy validation, required release gates
and the matching published image are verified. Source tests or image promotion alone establish no natural trade.
The candidate runtime metadata matches the v21 image; the sealed capital request and its authored lineages still
bind v20. The required PAPER identity check rejects this mismatch. Keep the source change in draft until the
qualified cutover can retire that request and its lineages through explicit OBSERVE, then seal the matching
same-account mandate against the published image. Do not change identity annotations without matching ciphertext
or relax the PAPER identity check to promote this candidate.

Migration 143 requires terminal mutation cycles, flat settled inventory, complete accounting and fresh exact
reconciliation. It rotates prior PAPER authority through native OBSERVE recovery while preserving loss and turnover
history. The strategy protocol hash is `f4a4ea1fff4aaba7ebfeb7a2a40b7a1823880f948bd8000cbb99db29187fbd5e`.
The protocol cutover uses OBSERVE authority. The source cutover intentionally removes the retired request and its runtime lineages. After the v20 image is
published and verified, the matching same-account PAPER request is sealed and reviewed through GitOps against that image. Its sealed identity, activation generation and all three runtime build lineages move
together through Kargo. The request retains the existing broker account, monetary limits and risk-policy hash;
account losses, peak equity and turnover history remain in place.

The authored v20 PAPER request is `933a611d7eebc8a1348cb615550b3374eddec41f64cb90b3a2be23ea39ea838a`.
It binds reviewed source `0bd754692dc5c281fb77725ddd47d704237c9098` and verified image
`sha256:b015e9ec3c22dfda4c21b19a4278c79938a8440a76d942b9c16c292dcdda828a` after the completed OBSERVE cutover.
The native hook still requires fresh flat/exact accounting before PAPER activation.

Image promotion does not grant capital authority. The existing sealed PAPER request carries its authored activation
through subsequent compatible image promotions; it does not require another rotation after each build. A future
strategy or risk-policy change requires a fresh OBSERVE cutover and a new reviewed same-account mandate.
The new mandate retains the reviewed $1,000,000 daily gross-turnover budget and exposure limits. The PAPER-only
cumulative drawdown cap is $10,000 and the daily loss cap remains $5,000. Live limits remain unchanged. Account losses,
peak equity and daily turnover are preserved when the mandate is rebound.
Account/day turnover survives the rotation. A strategy or mandate mismatch rejects activation.

The native activation hook validates the sealed request, all three runtime build lineages, compatible durable state
and fresh flat/exact reconciliation before replacing the account-keyed controller. Kargo writes each subsequent
reviewed published source and image into all runtime activation lineages. Retained evidence remains immutable.
Rollback requires a reviewed source/mandate pair and fresh flat/exact preflight; never rewrite evidence or reset turnover.

Only the execution worker receives `BAYN_JEV_API_KEY` from `bayn-jev-auth`, delivered by the SealedSecrets controller
before worker rollout. Jev uses a scoped HTTP CONNECT client through the existing egress proxy. The allowlist contains
the three exact Alpaca API hosts and `api.typesafe.ai`; direct external worker access remains unavailable. A missing
credential or unavailable provider blocks new entries while deterministic position-reducing management remains active.
The public status service and activation hook do not receive the model credential.

The worker requires Kafka and consumes verified raw-feature joins through the common market-data adapter. Its versioned bootstrap budget is five minutes: the initial 905,542-record
catch-up completed in 223 seconds on the slower worker. Freshness and entry checks apply after catch-up. Verify the sealed request's
content hash, all three build-lineage bindings, the native activation hook, exact reconciliation, and natural controller
progress. Retained-data diagnostics establish observation now; they do not establish historical live availability.

Each worker starts its existing read-only Kafka projection when the endpoint
starts. The trading driver, broker session, model client and capital activation remain lazy. The same server-scoped
projection is reused by the first execution runtime and its replacements, without another consumer. Bootstrap remains
asynchronous: an accepting TCP endpoint does not imply complete signal history, and existing snapshot checks still
reject rebuilding, missing or late input. Research does not claim storage, acquire clients, hash or copy records,
or wait for persistence in this startup or consumption path.

Prewarm moves the eventual per-replica consumption earlier. Both current replicas, and old/new replicas overlapping
during rollout, can consume concurrently; it is not a claim of zero additional aggregate CPU or memory. Keep the
existing resource limits and verify aggregate CPU/RSS, queue/backlog recovery and scoped consumer cleanup. Warming a
replica does not make an upstream bar published outside its permitted finalization window admissible.

## Regular-session trading boundaries

Migration 59 admits zero session-boundary offsets while retaining calendar ordering, exact offset bindings, and
historical cycle contracts. It changes constraints without rewriting cycle or execution evidence. Apply it through
normal worker startup before activating the new strategy identity. The submission window can start at market open;
the active strategy admits the first completed observed minute after its decision delay, with up to thirty minutes
of actual observed history as context.

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

The v2 request names only the target plan, source revision and account key. Its private `prepareActivation` RPC
validates the target against the latest worker before reading durable controller state. A pinned stale coordinator
cannot stop a newer owner. The authenticated handoff deactivates that exact recorded epoch, plan and source before
activating the replacement. GitOps does not guess or carry a predecessor source, and ticks cannot adopt another
source revision. Controller plan v3 makes this ownership transition explicit; retired activation requests are rejected.

The activation handler is shared so its wait for native progress cannot block exclusive ticks on the same account.
Only that handler accepts ingress calls, authenticated with the existing activation credential. Controller
`activate`, `deactivate`, `prepareActivation`, `tick` and `status`, and every broker-observation handler, remain private. The activation
result is retained for seven days; the journal is removed at completion to discard the bearer header. The Job reads
`BAYN_EXECUTION_ACTIVATION_ATTEMPT_ID` from its Kubernetes controller UID through the Downward API. Container restarts
and replacement Pods in that Job reuse the same invocation, including after the client's bounded completion wait
expires. Missing or invalid Job identity fails before invocation. A recreated Job has a new UID and can retry a retained
terminal failure after its dependency recovers. This identity does not deduplicate separate Job incarnations.
The acceptance log records the attempt UID, `activationInvocationId`, source revision and receipt status before waiting.
The verified log retains the completed successor proof after the successful hook is removed.

## 100G host placement

All Bayn components require `network.proompteng.ai/100g=true`, supplied by Omni on Turin and Altra. Ryzen is reserved
for compute and local CI scratch. Status, the current execution revision, and egress each retain two replicas with
`minDomains: 2` and strict hostname spreading, so each pair uses both eligible hosts. Retained execution revisions
must finish draining through Restate; their replicas cannot satisfy the current revision's spread constraint.

The two PostgreSQL instances require separate hostnames and use the pinned PostgreSQL 18.6 multi-architecture image.
The architecture restriction is removed. Before migration, the existing Buzz cluster demonstrated streaming/quorum
replication across Altra ARM64 and Turin/Ryzen AMD64 with the exact same image, control-file layout, glibc and ICU
versions. Verify Bayn's actual synchronous replication and data/index behavior after its move. Preserve the existing
PVCs, synchronous replica count and writer fences. Switch over to the healthy Turin instance before moving Ryzen's
former primary to Altra through CNPG maintenance.

TigerBeetle retains its cluster ID, three replica identities, three local PVCs and a minimum-two disruption budget.
Its placement is two-plus-one across the 100G hosts. The target is replicas 0 and 1 on Turin and replica 2 on Altra.
Losing the host with two replicas loses quorum. Moving replica 1 requires an offline, checksum-verified handoff of its
existing ledger file before rebinding local storage; never let a replacement format an empty ledger. A reviewed
placement commit alone does not complete that data handoff. Keep the two healthy peers available throughout it.
Follow the [replica 1 local-volume handoff](../../../devices/galactic/scheduling/tigerbeetle-ledger1-handoff.md)
for the offline copy, retained PV metadata replacement, and unchanged-PVC acceptance.

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
  source-bound Valkey materializations and `broker_observations` references, then activates the native controller. PostgreSQL reads prove its
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

### Continuous cash-spot cutover

Equities and `BTC/USD`, `ETH/USD`, `SOL/USD` use one account controller, planner, intent store, mutation coordinator,
broker adapter and accounting pipeline. Market profiles select the recorded producer contract and instrument rules.
The crypto profile consumes `bayn.market-data.crypto.v1` and `bayn.market-data.crypto.features.v1` continuously,
including weekends and UTC midnight. Crypto candidates require fresh executable quotes and actual trades within the verified lookback window; the retained trade age remains contextual evidence. Crypto benchmarks require matching verified completed bars and native features, using the last completed close without an executable benchmark quote or trade. Missing required benchmark bars or features reject the entire observation, including when that symbol is also a candidate. Continuous cycles have a one-minute entry lease, at most fifteen minutes of
holding, and three minutes of close recovery. Finished cycles rearm against the next admitted market window;
the account risk day remains America/New_York for both markets. An unused continuous lease that expires without snapshot or decision evidence can rearm after its deadline and cooldown under the same approved account, strategy and execution policy. Each successor repeats fresh data, reconciliation and risk admission.

Migration 97 changes all current quantities to billionth-unit atoms and executed prices to billionth-dollar atoms.
USD ledgers remain in millionths of a dollar. It archives the original immutable records and hashes, preserves
broker event and TigerBeetle transfer identities, and rewrites the current projection atomically. It requires flat
broker and accounted inventory, settled orders, complete fill accounting and no bound unfinished cycle. An unsafe
cutover fails without changing the schema. There is no mixed-unit runtime or retired order encoder.

Migration startup has a dedicated fifteen-minute database budget and a twenty-minute worker startup probe. The
thirty-minute Kargo deployment budget covers that startup and native handoff. These limits accommodate the retained
immutable history rewrite; readiness and native authority still require completed migrations and verified state.

The first reviewed promotion has no capital activation request: all three runtimes use read-only broker access and
no capital authority. The migration clamps the previous PAPER authority. After the native handoff, verify migrations
97 and 140, fresh exact reconciliation, zero positions and unresolved mutations, and the immutable promoted source/image.
Activate a new PAPER mandate for the same verified sandbox account, authored against a reviewed published image
containing this migration and the current Jev v18 strategy/risk identities. Its sealed request and PR may be prepared
while the OBSERVE rollout finishes; hold the activation merge until migration 140, the source-bound controller plan v3
handoff and flat, fresh exact reconciliation are verified. Restore the request, its identity annotation, all three
build lineages and the Kargo lineage assignments together through reviewed GitOps. The existing native activation hook grants
PAPER authority only after validating the complete binding.

Acceptance requires actual BTC, ETH and SOL orders and fills through the account controller while equities are
closed, exact quantity and order-duration readback, ledger receipts and reconciliation, and continued rearm.
Automated Sunday and midnight tests establish boundary behavior; a short PAPER run does not establish a completed
24-hour or weekend soak, profitability, or live liquidity capacity. Broker FEE/CFEE activities retain their native
cash/coin distinction; pending fee publication remains a cost-evidence gap.

### Trace export buffering

The two-replica `bayn-telemetry` Alloy relay accepts Bayn traces before forwarding them to the existing Tempo
distributor. Each replica has a 16 MiB byte-bounded queue, two export consumers, a 384 MiB process memory limiter
and a 120-second retry budget. It holds no broker credentials, performs no trading work and does not change
PostgreSQL, ledger or Kafka durability. Native exporter queue, refusal and delivery metrics are sent to Mimir
under `job="bayn-telemetry"`. The pod has a 512 MiB memory limit; the native local retry fixture reached about
213 MiB peak process RSS before production traffic, so the lower initial 256 MiB limit was not retained.

This absorbs brief Tempo/Kafka outages rather than allowing each application exporter to discard its buffer and
enter its native 60-second disabled interval. It is not durable or lossless: collector restarts, queue overflow
and exhausted retries can still lose traces. Readiness alone is not proof of delivery. Verify an identifiable
trace at Tempo and inspect accepted, failed and sent span counters. Do not restart collectors to conceal a backlog.

The standalone regression uses the same configuration with only local endpoints and a deliberately rejecting sink:

```sh
python3 services/bayn/tools/verify-telemetry-relay.py --binary /path/to/pinned/alloy \
  --config argocd/applications/bayn/telemetry.alloy
```

It requires no cluster, broker or model access. It proves acceptance while the sink returns 503, actual retries,
and delivery of the original fixture after recovery. ConfigMap hashing rolls collector configuration changes;
sync waves install the relay before changing application endpoints.

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
to remain exact with zero unresolved mutations. While equities are closed, equity orders and fills must remain unchanged; eligible crypto cycles may continue. If validation fails before activation, revert the complete request/hash/generation change through reviewed GitOps.
If activation has succeeded, first deactivate the native controller through reviewed GitOps and prove OBSERVE authority,
exact reconciliation, and no broker-ledger advance before replacing the mandate. Never roll back only the Secret or
invoke the activation handler manually.

The reviewed `main` build publishes the multi-architecture image and immutable `kargo-sha-<source>` alias. The
`lab-delivery/bayn` Warehouse selects the newest eligible immutable image and validates its source/revision annotations.
The automatic Stage checks out that image revision, updates the status, worker, and activation bindings from the same
image, and pushes `kargo/bayn`. Argo tracks that branch. The Stage also updates the activation endpoint of the existing
research build lineage while preserving its authored request and build. The native hook still verifies the exact
controller binding before the status service rolls out.
Image and source bindings always update. Mandate lookup and lineage updates run only when the reviewed source contains
that lineage, so an OBSERVE-only deactivation can use the same Stage without fabricating a mandate.

The `bayn-release` workflow, manifest-promotion command, and source-eligibility script are removed. Kargo is the only
writer of the generated deployment branch. Its activation generation uses the immutable image digest hash; the
runtime idempotency key binds that generation, the activation Job UID, source revision, account controller key and
target plan. The predecessor comes from durable controller state and is not part of the request or retry identity.

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
`bayn.execution-deployment-activation.v2` request contract. Worker and activation Job must use the same promoted
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


## Restate public information collection

The existing `bayn-research` RestateDeployment hosts independent SEC filings and macro-calendar virtual objects.
`BAYN_PUBLIC_INFORMATION_ENABLED=true` starts their signed asynchronous activations after endpoint registration.
No additional Kubernetes Job or CronJob is involved. The trading worker and its readiness remain independent.

The prepared worker mounts the canonical reflected `bayn-research-captures` OBC credential and generated bucket name.
This is an additional credential destination and needs approval under the repository scope rule before rollout.
The existing bucket-owner permissions remain unchanged; application code uploads immutable content-derived keys.
Only the research worker receives RGW egress. Its public HTTPS requests use the existing proxy with the SEC, BLS and
Federal Reserve host allowlist; credentials never pass through that client. Its internal Restate egress only submits
public-job activations. Verify the OBC ownership/private ACL and exact synthetic object SHA-256 readback before live
collection, then inspect source-keyed Restate status, artifact readback and source metrics. A source failure cannot
fail the trading endpoint or delay a protective closure.

### Available-history hard cutover

The current protocol removes the 30-minute admission requirement for equities and crypto. Equities first evaluate
at the first completed minute plus two seconds. Crypto uses its current completed history continuously. Both retain
up to 30 minutes of actual context, expose gaps, and require fresh quotes and the latest completed bar.

Migration 108 introduced the available-history cutover with terminal mutation cycles, fee-net flat inventory,
settled orders, fresh exact reconciliation and complete fill accounting. Later migrations preserve those safeguards. Migration 140 and the [v18 activation procedure](#jev-protocol-activation)
own the current economic-plan cutover. Retired feature and strategy contracts cannot authorize execution.
The broker account and order-risk limits remain the same.

Migration 109 introduced capital-weighted sizing. Equities use LIMIT/DAY extended-hours orders and crypto uses
LIMIT/IOC through the shared planner, coordinator and generic completion proof. Market profiles retain equity
entry spreads at 5 bps and crypto spreads at 25 bps. A canceled partial entry can complete only after an exact flat
reconciliation consumes the same timestamped broker cut. Its trusted flat observation must remain strictly newer
than entry terminalization, with complete fills and settled orders. Quantities follow the approved capital weight
and instrument precision. Current PAPER authority requires a new mandate bound to the published v18 strategy after
the migration-140 OBSERVE cutover proves flat inventory, settled orders and fresh exact reconciliation. The 20%
target weight and broker risk limits remain enforced. Broker fills, fee-net inventory, ledger transfers and exact
reconciliation remain required runtime evidence.

Migration 110 recognizes the capital-sizing cutover restriction in the native terminal-generation recovery path.
The same path retires bound, unused cycles left by the previous worker even after their admission window expires;
cycles with snapshot, decision or intent evidence still block cutover recovery.
The worker creates an OBSERVE successor only after fresh exact reconciliation and settled, flat account evidence.
Unavailable reconciliation retains the restriction. The old PAPER generation and all financial evidence remain immutable.

### Jev-selected trade-plan cutover

Protocol v20, signal state v17, batch v6, entry target v6 and exit target v5 require an upward current setup and a
supported complete economic trade. Either judgment can abstain. The stop and target remain one complete plan. Hypothetical order prices remain distinct from observed market evidence.
Migration 143 requires flat, settled and fully accounted inventory with fresh exact reconciliation before
retiring the prior PAPER generation. The initial source rollout carries no capital mandate. After the
published image and OBSERVE cutover are verified, restore the same-account PAPER mandate through the
existing sealed GitOps path with the new exact strategy and image bindings. Preserve the existing account,
loss, drawdown, exposure, order and turnover limits and all financial history.

See [strategy protection](../../../docs/bayn/strategy-protection.md) for model choices, validation and broker
lifecycle details. Model choices are unqualified research decisions; deployment does not establish an edge.
