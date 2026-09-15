# 87. Jangar Database-Pressure Fuses and Capital Authority Backplane (2026-05-05)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-05
Owner: Gideon Park, Torghut Traders
Scope: Jangar control-plane resilience, database backpressure, route authority, schedule dispatch, rollout widening,
and Torghut capital authority.

Companion Torghut contract:

- `docs/torghut/design-system/v6/91-torghut-causal-replay-exchange-and-capital-reentry-governor-2026-05-05.md`

Extends:

- `86-jangar-query-budgeted-evidence-receipts-and-admission-firebreaks-2026-05-05.md`
- `79-jangar-control-plane-proof-runway-and-consumer-gated-rollout-2026-05-05.md`
- `72-jangar-materialized-run-proof-and-storage-backed-admission-contract-2026-05-05.md`

## Decision

Jangar should add a **DatabasePressureFuse** and a **CapitalAuthorityBackplane** between serving routes and material
actions. The current status system already knows a lot. What it does not do yet is downgrade action authority before
database pressure turns into process death or before Torghut treats stale route evidence as capital proof.

The backplane is a small, durable authority layer that separates four classes of work:

1. `serve`: keep the UI/API available when possible.
2. `observe`: collect cheap evidence and expose it to operators.
3. `repair`: allow bounded recovery jobs and proof producers.
4. `act`: dispatch schedules, widen rollouts, or admit Torghut paper/live capital.

The decision is to make database pressure, route timeouts, image-pull failures, and stale proof clocks first-class
fuses for `act`, not side effects buried in request logs. Jangar may keep serving while the backplane holds dispatch or
capital. A green route response is not enough to widen a rollout or clear trading capital unless the corresponding
backplane receipt is fresh and within budget.

## Evidence Snapshot

All Kubernetes and database assessment for this pass was read-only.

### Cluster and Route Evidence

- The worker ran as `system:serviceaccount:agents:agents-sa`; local kube context had to be bootstrapped from the
  mounted service account.
- `kubectl get pods -n jangar -o wide` initially showed `jangar-847d6d7f8d-zx5sq` as `2/2 Running` with six app
  restarts. During the same evidence pass it degraded to `1/2 CrashLoopBackOff` with the app container restarting.
- `GET http://jangar.jangar.svc.cluster.local/ready` returned HTTP 200 before the crash loop. It showed leader election
  healthy, collaboration runtime kit healthy, and execution trust degraded for stale plan/verify stages.
- `GET /api/agents/control-plane/status` returned HTTP 200 before the crash loop. It reported healthy database
  migration consistency, 25 registered and 25 applied Kysely migrations, healthy watch reliability, and configured job
  and workflow runtimes.
- Minutes later, `GET /health` and the market-context route failed with HTTP 000 because the Jangar service was no
  longer accepting connections.
- Jangar app logs showed repeated Postgres connection-slot exhaustion:
  `remaining connection slots are reserved for roles with the SUPERUSER attribute`.
- The same logs showed heartbeat read/publish failures, Kysely `Query read timeout`, and quant freshness checks timing
  out against ClickHouse.
- Jangar namespace events showed DB readiness HTTP 500, Jangar readiness failures, and app restart backoff.
- Agents namespace events showed controller readiness/liveness timeouts, `BackoffLimitExceeded`, unexpected CronJob
  children, missing input ConfigMaps, and stale image digests in `ImagePullBackOff`.

### Torghut Consumer Evidence

- Torghut live revision `torghut-00221` served `/healthz` and `/trading/status`.
- Live `/readyz` and `/trading/health` returned HTTP 503. The payload showed Postgres, ClickHouse, Alpaca, DB schema,
  and Jangar universe checks OK, but live submission blocked by `simple_submit_disabled` and capital stage `shadow`.
- Live status showed three hypotheses, zero promotion-eligible hypotheses, three rollback-required hypotheses, and
  dependency quorum blocked on `empirical_jobs_degraded`.
- Torghut sim `/readyz` and `/trading/health` returned HTTP 200, but sim quant evidence reported
  `quant_health_fetch_failed` because Jangar quant health timed out.
- Direct CNPG SQL was blocked in both `torghut` and `jangar`: `pods/exec` is forbidden for this identity. The smallest
  unblocker for direct SQL assessment is read-only CNPG exec access or an exported read-only query surface.
- Torghut `/db-check` reported schema current at Alembic head `0029_whitepaper_embedding_dimension_4096` with known
  parent-fork warnings and no duplicate revisions or orphan parents.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` composes controller health, database status, rollout health,
  watch reliability, execution trust, empirical services, dependency quorum, and runtime admission. It is the right
  projection surface, but today it is also asked to be action authority.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` calls `ensureMigrations` on read paths such as quant
  health. Under pressure, that turns a route probe into another DB participant.
- `services/jangar/src/server/primitives-kube.ts` still lacks a built-in PersistentVolumeClaim target while
  `supporting-primitives-controller.ts` reconciles workspace PVCs with `persistentvolumeclaim`.
- `services/torghut/app/main.py::_build_live_submission_gate_payload` still short-circuits simple live mode through
  local toggles before using the proof-aware submission council.
- `services/torghut/app/trading/submission_council.py::build_live_submission_gate_payload` already has the right
  proof vocabulary: dependency quorum, empirical jobs, quant health, certificate evidence, capital stage, and reason
  codes. It needs a Jangar backplane receipt, not another direct route guess.

## Problem

Jangar can currently report a healthy status route and then die from database pressure inside the same operating
window. That is the failure mode to eliminate. The control plane is not missing facts; it is missing isolation between
fact collection, serving, repair, dispatch, rollout widening, and trading capital admission.

The existing design family introduced proof runways and query-budgeted receipts. This design makes the next step
explicit: database pressure itself must be a release-scoped fuse that changes action authority before it causes
CrashLoopBackOff. A route that cannot be queried because the process is down is not an unknown; it is negative evidence
for new dispatch and capital.

## Alternatives Considered

### Option A: Increase Postgres Pools and Route Timeouts

Raise pool sizes, extend Kysely query timeouts, and retry failed route reads.

Pros:

- Fast to implement.
- May reduce false timeouts during normal load.
- Easy to roll back.

Cons:

- Can worsen connection-slot exhaustion during an incident.
- Does not separate heartbeat, memory, status, review ingest, and quant reads.
- Lets an expensive route remain the authority for action.
- Does not help least-privilege deployers prove safety.

Decision: use only as tactical relief after measuring current pool pressure. Reject as the architecture.

### Option B: Freeze Everything on Jangar Degradation

Stop all Jangar stages and Torghut capital whenever status, DB, memory, or quant routes degrade.

Pros:

- Conservative.
- Simple operator story.
- Prevents unsafe widening during ambiguity.

Cons:

- Blocks repair jobs that would restore proof freshness.
- Treats serving, observe, repair, and act as the same risk.
- Encourages manual bypasses because the freeze is too broad.
- Does not prioritize the next proof to collect.

Decision: keep as an emergency brake only.

### Option C: DatabasePressureFuse and CapitalAuthorityBackplane

Materialize database pressure and proof freshness into action-scoped receipts. Serving and repair stay available when
their own receipts allow them. Dispatch, rollout widening, paper submit, and live submit must cite fresh receipts.

Pros:

- Reduces repeated failure modes before they produce pods or orders.
- Keeps bounded repair open while holding unsafe action.
- Converts DB exhaustion and route timeout into typed evidence.
- Gives Torghut one authority surface to consume for capital.
- Works under least-privilege Kubernetes access.

Cons:

- Adds a durable authority object and expiry rules.
- Requires shadow comparison before enforcement.
- Requires careful dedupe so every timeout does not become noisy durable state.

Decision: select Option C.

## Chosen Architecture

### DatabasePressureFuse

Jangar emits one current fuse per namespace, release digest, and pool class.

```text
database_pressure_fuse
  fuse_id
  namespace
  release_digest
  pool_class              # heartbeat, status, memory, review_ingest, quant_mirror, route_probe
  observed_connections
  configured_pool_limit
  server_rejection_count
  query_timeout_count
  latest_error_code       # 53300, query_timeout, route_timeout, unavailable
  observed_at
  fresh_until
  decision                # allow, degrade, hold, block
  allowed_action_classes
  repair_hints
```

Rules:

- `serve` may stay allowed on `degrade` when the process is up and readiness dependencies are bounded.
- `dispatch`, `widen`, `paper_submit`, and `live_submit` are held on `hold` or `block`.
- `repair` stays allowed when the repair plan has its own query budget and does not increase the failing pool class.
- A CrashLoopBackOff or HTTP 000 route sample is a `block` until a fresh healthy fuse is emitted.

### CapitalAuthorityBackplane

The backplane joins Jangar receipts and Torghut consumer receipts into one projection.

```text
capital_authority_backplane
  authority_id
  release_digest
  target_namespace
  target_stage
  consumer               # jangar_dispatch, jangar_widen, torghut_paper, torghut_live
  database_pressure_fuse_id
  runtime_kit_digest
  image_platform_digest
  schedule_materialization_digest
  route_probe_digest
  torghut_profit_receipt_digest
  observed_at
  fresh_until
  decision               # allow, observe_only, repair_only, hold, block
  reason_codes
```

The backplane is not a dashboard. It is the object an engineer cites before creating a schedule job and the object
Torghut cites before changing capital state.

## Engineer Scope

1. Add first-class PVC targets to `primitives-kube` and tests for aliases, get/list/delete/watch parity.
2. Add a pure `DatabasePressureFuse` builder with fixtures for connection-slot exhaustion, query read timeout, route
   timeout, CrashLoopBackOff, and healthy recovery.
3. Partition Jangar DB query budgets by pool class in configuration, even if all classes initially share the same
   underlying Postgres pool.
4. Persist the latest fuse and expose a compact projection in control-plane status without making `/ready` perform
   deep proof scans.
5. Add the `CapitalAuthorityBackplane` builder and route projection.
6. Wire schedule dispatch and rollout widening in shadow mode so they record the decision they would have enforced.
7. Add Torghut consumer receipt fields to the backplane after the companion Torghut router exists.

## Validation Gates

- Unit test: Postgres `53300` maps to `database_pressure_fuse.decision=block` for `dispatch`, `widen`, and capital,
  while `repair` can remain allowed with a separate budget.
- Unit test: HTTP 000 from Jangar route probe creates a block receipt rather than `unknown`.
- Unit test: `/ready` can be HTTP 200 only for serving while the backplane holds `dispatch`.
- Integration test: a fake Torghut quant-health timeout holds `torghut_paper` and `torghut_live` but allows zero-notional
  repair proof.
- Kubernetes test: workspace PVC proof is resolvable through `primitives-kube`.
- Deployer smoke: query the backplane route after rollout and verify it includes release digest, fresh fuse, action
  decision, and reason codes.

## Rollout Plan

1. Ship fuse builder and route projection in shadow mode.
2. Record fuses for at least one full trading day and one Jangar schedule cycle.
3. Enforce `dispatch` holds for new non-repair schedules when DB pressure is `block`.
4. Enforce rollout widening holds after deployer smoke proves the route is stable.
5. Let Torghut consume the backplane in shadow for paper and live capital decisions.
6. Enforce Torghut paper first, then live only after no false allows occur across two market sessions.

## Rollback Plan

- Set backplane enforcement to `disabled`; keep fuse writes and route projections.
- If route projection causes readiness regression, remove the compact projection from `/ready` and keep the dedicated
  route.
- If DB writes amplify pressure, switch the fuse to in-memory hold mode with short expiry and no persistence.
- If Torghut consumption regresses, keep capital in shadow and continue using local submission-council blocks.

## Risks

- Pool partitioning must be measured before hard limits are enforced, or the first rollout may starve legitimate repair.
- The backplane must not become a second unbounded event stream.
- Manual overrides require actor, reason, expiry, release digest, action class, and max capital scope.
- Least-privilege deployers still need route access even when Kubernetes Deployment and CNPG exec reads are blocked.

## Handoff

Engineer acceptance gate: a DB connection-slot failure, Kysely read timeout, HTTP 000 Jangar route, missing PVC proof,
and Torghut quant-health timeout each produce deterministic action-scoped decisions with repair hints.

Deployer acceptance gate: do not widen a Jangar rollout or clear Torghut capital from pod readiness alone. Widen only
when the backplane route shows the target release digest, a fresh non-blocking DB fuse, no unresolved image/storage
negative evidence, and the requested action class allowed.
