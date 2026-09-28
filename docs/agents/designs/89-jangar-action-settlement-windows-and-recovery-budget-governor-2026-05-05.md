# 89. Jangar Action Settlement Windows and Recovery Budget Governor (2026-05-05)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-05
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, rollout safety, schedule dispatch, proof producer pressure, recovery work
admission, and Torghut capital dependency authority.

Companion Torghut contract:

- `docs/torghut/design-system/v6/93-torghut-recovery-budget-profit-ladder-and-session-cost-ledger-2026-05-05.md`

Extends:

- `88-jangar-negative-evidence-arbiter-and-brownout-governor-2026-05-05.md`
- `87-jangar-database-pressure-fuses-and-capital-authority-backplane-2026-05-05.md`
- `86-jangar-query-budgeted-evidence-receipts-and-admission-firebreaks-2026-05-05.md`
- `82-jangar-proof-runway-cutover-and-consumer-authority-2026-05-05.md`

## Decision

Jangar should add **ActionSettlementWindows** and a **RecoveryBudgetGovernor** above the negative-evidence and
database-pressure contracts.

The previous layer decided that material negative evidence must overrule stale positive receipts. The current evidence
shows the next problem: evidence can change faster than our action surfaces settle. During this pass, Jangar reported a
healthy database, healthy agents rollout, and healthy watch reliability through the status route, then the Jangar
service refused connections while the active pod still reported `Running` and later `Ready`. The app had just restarted
after PostgreSQL `53300`, heartbeat write failures, agent-message store query timeouts, ClickHouse freshness timeouts,
and metrics export connection failures.

I am choosing a settlement-window architecture: after rollout, restart, database pressure, route refusal, or controller
probe failure, higher-risk action classes do not regain authority immediately. They must pass a short, explicit,
multi-signal settlement window. Serving and observation can recover quickly. Dispatch, rollout widening, proof-heavy
repair, and Torghut capital require a stable window with a capped recovery budget.

This is not a global freeze. It is a way to keep recovery work alive without letting recovery work become the next
database-pressure incident.

## Evidence Snapshot

All cluster and database assessment for this pass was read-only.

### Cluster, Rollout, and Route Evidence

- The worker ran as `system:serviceaccount:agents:agents-sa`.
- The identity can read pods, services, events, logs, CronJobs, jobs, and AgentRuns. It cannot list Argo Applications,
  list Jangar Deployments, read Jangar endpoints, read EndpointSlices, or exec into Jangar/Torghut database pods.
- `kubectl get pods -n jangar -o wide` showed the current Jangar pod `jangar-749fcf8554-wz8hz` as `2/2 Running` on
  image `registry.ide-newton.ts.net/lab/jangar:4ee1d250@sha256:4ceb975...`.
- `curl /api/agents/control-plane/status?namespace=agents` initially returned healthy database status, 25 registered
  and 25 applied Kysely migrations through `20260418_embedding_dimension_4096`, healthy agents rollout health, and
  watch reliability with 385 events and zero errors.
- The same status payload reported `execution_trust.status=degraded` because discover, plan, implement, and verify
  stages were stale; dependency quorum remained `block` on `empirical_jobs_degraded`; swarm plan, implement, and verify
  admission passports were `hold`.
- Minutes later, `curl http://jangar.jangar.svc.cluster.local/ready`,
  `/api/agents/control-plane/status?namespace=agents`, and the Torghut quant-health route all failed with connection
  refused while Kubernetes still reported the Jangar pod as Running.
- `kubectl get pod -n jangar jangar-749fcf8554-wz8hz` then showed the app container had restarted once. The previous
  app process exited at `2026-05-05T20:41:35Z`; the new app process started at `2026-05-05T20:41:37Z`.
- Previous Jangar app logs showed PostgreSQL `53300`, "sorry, too many clients already", heartbeat read failures,
  heartbeat publish query timeouts, ClickHouse TA freshness timeouts, and the final crash inside
  `agent-messages-store` while inserting workflow communications.
- Jangar events included a fresh DB readiness probe HTTP 500 on `jangar-db-1` and readiness connection-refused
  warnings for the current Jangar pod.
- Agents namespace pods were mostly running, but the primary agents pod had three recent restarts and recent events
  still included controller readiness/liveness failures, stale `ImagePullBackOff` jobs, missing schedule ConfigMaps,
  `UnexpectedJob` warnings, and an `etcdserver: request timed out` CronJob create failure.

### Database and Data Evidence

- Direct CNPG SQL reads were blocked in both `jangar` and `torghut`:
  `cannot create resource "pods/exec"` for `system:serviceaccount:agents:agents-sa`.
- Jangar database route proof can say schema is current while the app is actively failing to obtain or use database
  connections. That makes route projection necessary but insufficient for action authority.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, no missing or unexpected heads, no duplicate revisions, no orphan
  parents, and known parent-fork lineage warnings.
- Torghut `/trading/status` reported `last_decision_at=2026-05-04T17:25:57.901670Z`, stale empirical jobs from
  `2026-03-21`, dataset snapshot `torghut-full-day-20260318-884bec35`, zero promotion-eligible hypotheses, and three
  rollback-required hypotheses.
- Torghut dependency quorum in the hypothesis summary was `unknown` because Jangar status fetch failed with connection
  refused. Local schema correctness did not imply cross-plane capital authority.
- The options catalog was serving `/readyz` as ready during this pass, but prior shared evidence showed the same lane
  had just failed a catalog cycle through an oversized `ANY(symbols)` query. The source still contains that query shape
  in `services/torghut/app/options_lane/repository.py`, so catalog readiness needs a cost and settlement meaning, not
  just a boolean.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is the right projection surface, but it emits positive rollout,
  database, and watch facts beside action holds. Consumers still need a settlement decision that says when those facts
  are stable enough to act.
- `services/jangar/src/server/db.ts` creates a shared `pg` pool with connect and query timeouts but no explicit pool
  `max` or action-class partition in the constructor.
- `services/jangar/src/server/control-plane-heartbeat-store.ts` and
  `services/jangar/src/server/agent-messages-store.ts` call `ensureMigrations(db)` before ordinary reads/writes. Under
  pressure, proof and communication paths participate in the same database pressure they are meant to diagnose.
- `services/jangar/src/server/memory-provider.ts` caches separate Postgres pools by connection string without an
  explicit `max` cap.
- `services/jangar/src/server/supporting-primitives-controller.ts` already has admission passport logic for swarm
  schedule launch and can delete schedule runner resources when admission is not allowed. It is the right enforcement
  point for settlement-window holds.
- `services/jangar/src/server/primitives-kube.ts` still lacks first-class `PersistentVolumeClaim` built-ins while
  workspace reconciliation uses `persistentvolumeclaim` directly.
- `services/torghut/app/main.py::_build_live_submission_gate_payload` still short-circuits simple live mode through a
  local toggle path and returns `dependency_quorum_decision=informational_only`.

## Problem

The current system has become honest but not settled. It can tell us that a route is healthy, that migrations are
aligned, that a controller rollout has ready replicas, and that a stage passport is held. Those statements can all be
true while the app is seconds away from a database-triggered restart.

That creates three concrete failure modes:

1. rollout or schedule code can act immediately after the first positive route sample and miss the crash that follows;
2. proof producers can stampede the same database pool during the recovery window and lengthen the outage;
3. Torghut can observe local schema health and live service health while the Jangar dependency it needs for capital is
   actively unreachable.

The platform needs an action authority that says "this evidence has settled for this action class" rather than "this
route returned once."

## Alternatives Considered

### Option A: Rely on the NegativeEvidenceArbiter Alone

Let negative evidence hold material actions and clear the hold as soon as the negative evidence expires or a positive
receipt appears.

Pros:

- Lowest conceptual cost.
- Builds directly on the accepted brownout design.
- Easy to expose through the existing control-plane status route.

Cons:

- Clears too quickly after restart or rollout churn.
- Does not distinguish first healthy sample from stable recovery.
- Does not allocate scarce recovery query capacity.
- Keeps Torghut guessing whether a fresh positive receipt is settled enough for capital.

Decision: keep as input, but do not treat it as the whole architecture.

### Option B: Fixed Maintenance Freeze After Every Rollout or Restart

Freeze dispatch, rollout widening, proof jobs, and Torghut capital for a fixed duration after any restart or DB warning.

Pros:

- Simple and conservative.
- Easy to implement with one timestamp.
- Prevents immediate post-restart widening.

Cons:

- Blocks cheap repair and observation even when they are safe.
- Uses time alone instead of evidence.
- Punishes low-risk schedule classes for unrelated failures.
- Creates manual bypass pressure during active recovery.

Decision: use only as emergency fallback.

### Option C: ActionSettlementWindows With RecoveryBudgetGovernor

Require each material action class to pass a short settlement window after negative evidence or rollout churn. Allocate
recovery work through explicit budgets so repair stays open without starving serving or heartbeat paths.

Pros:

- Separates serving recovery from dispatch, rollout widening, proof-heavy repair, and capital admission.
- Turns route refusal, app restart, DB readiness 500, controller probe failure, and query timeout into settlement debt.
- Gives deployers a concrete gate before widening.
- Gives Torghut a platform authority input that is stronger than local schema health.
- Lets cheap observation continue while holding expensive proof or capital.

Cons:

- Adds one more action-authority object.
- Needs careful tuning so stale warnings do not block forever.
- Requires implementation to avoid making settlement itself another expensive proof producer.

Decision: select Option C.

## Chosen Architecture

### ActionSettlementWindow

Jangar emits one settlement window per namespace, release digest, and action class.

```text
action_settlement_window
  window_id
  namespace
  release_digest
  action_class                 # serve, observe, repair_light, repair_heavy, dispatch, widen, paper_submit, live_submit
  trigger_kind                 # rollout, restart, route_refusal, db_pressure, controller_probe, proof_timeout
  trigger_refs
  started_at
  earliest_clear_at
  fresh_until
  required_observations
  current_observations
  decision                     # open, settling, repair_only, hold, block
  reason_codes
  last_negative_evidence_ids
  last_positive_receipt_ids
```

Rules:

- `serve` can reopen on the first healthy `/health` sample when the pod is ready.
- `observe` can reopen when read-only route probes and Kubernetes reads are working.
- `repair_light` can reopen during brownout if it uses a capped query budget and does not create pods or widen rollout.
- `repair_heavy`, `dispatch`, `widen`, `paper_submit`, and `live_submit` require a settlement window with no fresh app
  restarts, no route refusal, no DB readiness 500, no active `53300`, and no controller probe failures for the window.
- A single positive database migration receipt cannot clear a window that was triggered by connection-slot exhaustion.
- If the system cannot read endpoints or Deployments because of RBAC, the window can still clear through pod status,
  service route probes, events, and app logs, but it must mark the proof path as least-privilege.

### RecoveryBudgetGovernor

The governor allocates bounded recovery capacity while a window is settling.

```text
recovery_budget
  budget_id
  namespace
  release_digest
  pool_class                   # heartbeat, workflow_comms, status, memory, quant_mirror, catalog, metrics
  action_class
  max_concurrent_work
  max_query_ms
  max_rows
  max_route_ms
  allowed_producers
  denied_producers
  spent
  decision                     # allow, throttle, deny
  reason_codes
```

Rules:

- Heartbeat and route health receive reserved budget before workflow communications ingest, memory writes, quant
  mirrors, or review worktree refresh.
- Workflow communications ingest must batch below the pool budget and fail closed to durable retry, not crash the app.
- Metrics export failures must not consume recovery budget needed for database proof.
- Torghut quant-health and options-catalog proof can run in `repair_light` or `repair_heavy`, but they cannot clear
  paper/live capital unless the corresponding Jangar settlement window is open.

### SettlementAuthorityResult

Consumers use a compact projection:

```text
settlement_authority_result
  consumer
  action_class
  namespace
  release_digest
  decision                     # allow, observe_only, repair_only, hold, block
  settlement_window_id
  recovery_budget_id
  reason_codes
  observed_at
  fresh_until
```

The result is what schedule dispatch, deploy verification, and Torghut capital cite. `/ready` remains a serving check,
not action authority.

## Engineer Scope

1. Add pure builders for `ActionSettlementWindow`, `RecoveryBudget`, and `SettlementAuthorityResult`.
2. Add tests for route refusal after a healthy status receipt, app restart after `53300`, DB readiness 500 after a
   green migration receipt, controller probe failure after healthy rollout, and successful settlement after a stable
   window.
3. Add first-class `PersistentVolumeClaim` targets to `primitives-kube` so storage proof can be addressed through the
   same resource map as other built-ins.
4. Partition Jangar DB budgets by producer class. Start with configuration and accounting even if the first runtime
   still uses the shared pool underneath.
5. Make agent-message ingestion fail into retry/quarantine when its budget is exhausted. It must not terminate the
   serving app during recovery.
6. Project settlement authority in control-plane status and a dedicated route. Keep `/ready` cheap.
7. Wire `supporting-primitives-controller` schedule dispatch in shadow mode first: record the settlement decision it
   would have enforced before deleting or blocking any runner resources.
8. Add a Torghut consumer field for Jangar settlement authority before any paper/live capital widening.

## Validation Gates

- Unit: a healthy migration receipt plus fresh `postgres_53300` yields `serve=allow`, `observe=allow`,
  `dispatch=hold`, `widen=hold`, and `live_submit=hold`.
- Unit: a route refusal after a healthy status sample opens a settlement window and blocks dispatch until the stability
  observations pass.
- Unit: workflow communications query timeout consumes `workflow_comms` budget but cannot consume heartbeat budget.
- Unit: metrics export connection refusal records negative evidence but cannot block serving by itself.
- Unit: PVC resource aliases support get/list/delete/watch parity in `primitives-kube`.
- Integration: schedule dispatch records a shadow settlement decision and does not create a new runner when the stage
  passport is held.
- Integration: Torghut simple live mode reports Jangar settlement authority and cannot reduce it to
  `informational_only`.
- Deployer smoke: after rollout, query health, status, recent events, app restart count, and settlement authority twice
  across the settlement window before widening.

## Rollout Plan

1. Ship builders and route projection in shadow mode.
2. Run settlement accounting for one Jangar release cycle and one trading session without enforcing new holds.
3. Enforce `dispatch` holds for new non-repair schedules when the settlement result is `hold` or `block`.
4. Enforce rollout-widening holds for deployer workflows after the shadow false-positive rate is reviewed.
5. Let Torghut consume settlement authority in shadow for paper and live capital decisions.
6. Enforce Torghut paper first; enforce live only after two market sessions show no false allows and no blocked
   high-value repair loops.

## Rollback Plan

- Set settlement enforcement to `shadow`; keep observations and route projection.
- If settlement persistence adds database pressure, switch windows to in-memory state with short expiry and no durable
  writes.
- If schedule dispatch is over-held, disable dispatch enforcement and keep deployer/Torghut consumers in shadow.
- If Torghut consumption regresses, keep capital in shadow and continue using local submission-council blocks.

## Risks and Tradeoffs

- Settlement windows add latency after recovery. I accept that because the observed failure is immediate post-restart
  overconfidence.
- The least-privilege path cannot inspect every object. The design intentionally clears through pods, events, route
  probes, and logs instead of requiring privileged Deployment, EndpointSlice, Argo, or SQL reads.
- The budget governor must stay cheap. If it performs deep SQL to decide every action, it recreates the failure mode it
  is meant to prevent.
- The first enforcement target should be schedule dispatch, not serving readiness. Serving needs fast recovery; material
  action needs proof that recovery has settled.

## Handoff Contract

Engineer acceptance gates:

- Builders and tests exist for all trigger classes listed above.
- `supporting-primitives-controller` can run settlement decisions in shadow and records action, reason, release digest,
  and passport id.
- Agent-message ingestion has budget exhaustion behavior that does not crash the Jangar app.
- Torghut receives a typed settlement authority field before paper/live capital evaluation.

Deployer acceptance gates:

- A rollout is not widened until settlement authority is `allow` for `widen` across the configured window.
- If Jangar app restarts, DB readiness returns HTTP 500, or the service refuses connections, deployer holds widening
  and cites the settlement result.
- Rollback is a normal GitOps image/config revert if settlement enforcement causes false holds; no direct cluster
  mutation is required.
