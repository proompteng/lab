# 147. Jangar Hot-Path Witness Cache And Repair Settlement Cells (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane availability, database witness authority, schedule debt settlement, Torghut repair
admission, validation, rollout, rollback, and engineer/deployer handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/151-torghut-repair-alpha-carry-exchange-and-paper-settlement-ledger-2026-05-07.md`

Extends:

- `146-jangar-repair-warrant-exchange-and-schedule-debt-firebreak-2026-05-07.md`
- `143-jangar-route-stable-status-snapshot-escrow-and-repair-actuation-windows-2026-05-07.md`
- `135-jangar-database-witness-and-schema-authority-exchange-2026-05-07.md`
- `120-jangar-material-action-verdict-arbiter-and-clock-budget-parity-2026-05-06.md`

## Decision

I am selecting **a hot-path witness cache with repair settlement cells** as the next Jangar control-plane architecture
step.

The current system is no longer in a simple outage state. At `2026-05-07T13:24Z`, Jangar had `8` Running pods,
Torghut had `28` Running and `5` Completed pods, and the active Torghut live and simulation Knative revisions were
Running. Jangar's status projection said the database was configured, connected, healthy, and migration-current:
`28` registered migrations, `28` applied migrations, `0` unapplied, `0` unexpected, latest registered and applied
`20260505_torghut_quant_pipeline_health_window_index`.

The remaining failure mode is availability ambiguity under evidence load. Agents had `10` Running pods, `173`
Completed pods, and `61` Error pods. The `agents` API pod had restarted twice, and its previous logs showed repeated
Postgres pool connection timeouts. Recent Agents events showed `/ready` probe timeouts against both controller pods and
the API pod during rollout. Direct CNPG and pod-exec database inspection is RBAC-blocked for this runner, which is the
right least-privilege stance, but it means deployers need typed witness evidence rather than ad hoc shell inspection.

The current control plane can produce a rich status document, but the serving path and the evidence path are still too
close. A slow database probe, stale Torghut proof route, or high-latency witness reducer should never make `/ready`
look unavailable if the service has a fresh sealed witness batch proving read-only serving is safe. The system needs a
short-lived authority cache that separates "can serve" from "can widen dispatch or capital."

The selected design introduces signed witness batches and repair settlement cells. Witness producers gather database,
rollout, schedule, route, controller, watch, and Torghut proof-floor evidence off the hot path. `/ready` reads only the
latest sealed serving witness and local leader/runtime checks. Repair settlement cells consume the same witness batches
to admit zero-notional repair warrants, net schedule debt, and publish closure receipts that deployers can trust.

The tradeoff is another authority layer. I accept it because this layer removes a failure mode: expensive evidence
collection no longer competes with readiness, and repair work becomes a settled contract rather than a pile of stale
Error pods and independent Torghut facts.

## Runtime Objective And Success Metrics

Success means:

- `/ready` returns from a local hot-path witness within a fixed budget, without waiting on Postgres, Torghut, or
  Kubernetes list calls.
- Control-plane status exposes `hot_path_witness_cache` with a `serving_witness_id`, `fresh_until`,
  `producer_revision`, `source_snapshot_ref`, `cache_age_ms`, `fallback_mode`, and `reason_codes`.
- Evidence reducers publish `witness_batch` records for database, route, rollout, controller, watch, schedule debt,
  workflow reliability, source schema, and Torghut repair proof.
- A database witness can be `healthy`, `degraded`, `unknown`, or `stale` without making `/ready` block; only stale or
  missing serving witnesses can block readiness.
- The database witness includes migration consistency, query latency, source schema digest, and whether direct CNPG
  inspection was unavailable due to RBAC.
- Schedule debt is reported as netted windows: failed attempts superseded by later success stop counting as active
  negative evidence after the settlement window.
- Repair settlement cells issue at most one active zero-notional repair warrant per account, repair dimension, and
  evidence epoch.
- `dispatch_repair` and `torghut_observe` remain available while a serving witness is fresh and repair witnesses are
  bounded, even when `dispatch_normal`, `deploy_widen`, paper, or live capital remain held.
- `paper_canary` requires a closed repair settlement cell plus a fresh paper settlement ledger entry from the companion
  Torghut contract.
- `live_micro_canary` and `live_scale` remain blocked until paper settlement, live submit quorum, and expected shortfall
  coverage exist.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database records, GitOps resources,
AgentRun objects, trading flags, ClickHouse tables, or empirical artifacts.

### Cluster And Rollout Evidence

- The work branch was `codex/swarm-jangar-control-plane-plan`, at current `main` before changes.
- The Kubernetes identity was `system:serviceaccount:agents:agents-sa`; `kubectl config current-context` was unset, but
  `kubectl auth whoami` succeeded.
- `kubectl get pods -n jangar -o wide` showed `8` Running pods: `bumba`, `jangar`, `jangar-alloy`, `jangar-db-1`,
  `jangar-openwebui-redis-0`, `open-webui-0`, `symphony`, and `symphony-jangar`.
- Jangar events showed the current `jangar-75fd6c7548-ctjpw` rollout started at `13:12Z`, with an initial `/health`
  connection-refused readiness probe before settling.
- `kubectl get pods -n agents --no-headers` counted `10` Running, `173` Completed, and `61` Error pods.
- `kubectl get deploy -n agents` showed `agents` `1/1` and `agents-controllers` `2/2`.
- The `agents-68dddfd444-4tgpq` API pod was Ready but had restart count `2`.
- Previous logs for that API pod showed repeated `pg-pool` connection timeout errors before the restart.
- Recent Agents events showed `/ready` probe timeouts for `agents`, `agents-controllers-59899bcd7d-5w4lm`, and
  `agents-controllers-59899bcd7d-lhmsk`.
- Older scheduled swarm cron jobs still accounted for the retained Error pod pile, while recent plan cron jobs
  completed in seconds.
- `kubectl get pods -n torghut --no-headers` counted `28` Running and `5` Completed pods.
- Torghut deployments showed active live revision `torghut-00259-deployment` `1/1` and active simulation revision
  `torghut-sim-00359-deployment` `1/1`; older Knative revisions were scaled to `0/0`.
- Recent Torghut events still reported duplicate ClickHouse PodDisruptionBudget matches and `torghut-keeper` `NoPods`
  events, plus initial startup/readiness probe failures during the latest revision cutover.

### Source Evidence

- `services/jangar/src/routes/ready.tsx` still constructs execution trust and runtime admission evidence inside the
  request handler. That is acceptable for shadow status, but too much work for a hard readiness path.
- `services/jangar/src/server/control-plane-status.ts` is `764` lines and remains the aggregation boundary for database,
  watch, workflow, rollout, empirical, verdict, and admission evidence.
- `services/jangar/src/server/supporting-primitives-controller.ts` is `3301` lines and owns schedule generation,
  runtime-admission checks, requirement dispatch, workspace PVC status, and swarm status updates.
- `services/jangar/src/server/primitives-kube.ts` now includes `PersistentVolumeClaim` aliases, and focused tests cover
  core object API reads/lists/deletes for workspace storage proof.
- `services/jangar/src/server/control-plane-action-clock.ts` and
  `services/jangar/src/server/control-plane-material-action-verdict.ts` already separate action clocks and verdicts,
  but they do not consume a hot-path serving witness or repair settlement cell.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` already keeps retained audit failures out of
  read-only serving and repair admission, which is the behavior this design formalizes for schedule debt windows.
- `services/torghut/app/trading/revenue_repair.py` already builds a business-prioritized repair digest from proof-floor
  and readiness evidence, but Jangar does not yet settle those items into control-plane repair cells.

### Database And Data Evidence

- Direct CNPG cluster inspection failed: `clusters.postgresql.cnpg.io "jangar-db" is forbidden`.
- Direct Postgres exec via `kubectl cnpg psql -n jangar jangar-db` failed because the service account cannot create
  `pods/exec` in namespace `jangar`.
- Direct Torghut Postgres exec failed with the same `pods/exec` RBAC limit in namespace `torghut`.
- Jangar status projection for namespace `agents` reported database `healthy`, connected, `latency_ms=10`,
  `registered_count=28`, `applied_count=28`, `unapplied_count=0`, `unexpected_count=0`, latest migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- Torghut live `/readyz` reported Postgres and ClickHouse `ok`, database schema current, expected head
  `0029_whitepaper_embedding_dimension_4096`, one branch, no duplicate revisions, no orphan parents, and lineage ready.
- Torghut schema lineage still warns about historic parent forks at `0010_execution_provenance_and_governance_trace`
  and `0015_whitepaper_workflow_tables`.
- Torghut live `/readyz` was `degraded` because the profitability proof floor was `repair_only` and `zero_notional`.
- Live proof blockers were `hypothesis_not_promotion_eligible`,
  `execution_tca_slippage_guardrail_exceeded`, `market_context_stale`, and `simple_submit_disabled`.
- Live quant evidence was informational but degraded: latest metrics updated at `2026-05-07T13:24:44.656Z` with
  max stage lag `70813` seconds.
- Live execution TCA had `13775` orders, `13571` filled executions, average absolute slippage
  `568.6138848199565249` bps, an `8` bps guardrail, and last computation at `2026-04-02T20:59:45.136640Z`.
- Torghut simulation `/readyz` was HTTP `200`, but its proof floor was still `repair_only` and `zero_notional` with
  alpha, execution TCA, and market-context blockers.

## Problem

The control plane currently has rich evidence but weak isolation between evidence production and serving readiness.

The failure modes are:

1. A slow or unavailable database can restart or probe-fail the API process before a deployer sees a settled witness.
2. The system treats a retained Error pod and a recent successful replacement as separate facts instead of a netted
   schedule debt window.
3. Database confidence depends on privileged checks that normal swarm workers do not have, even though the application
   already has a typed migration projection.
4. Torghut repair facts are visible, but Jangar does not yet settle them into bounded repair cells that survive route
   or database slowness.
5. `/ready` can become an evidence aggregator when it should be a local proof of serving ability.

## Alternatives Considered

### Option A: Tune Readiness Probe Timeouts And Postgres Pool Settings

Pros:

- Small implementation.
- Reduces immediate restart probability.
- Fits the current deployment model.

Cons:

- Keeps heavyweight evidence on the readiness path.
- Does not solve schedule debt netting or repair settlement.
- Longer timeouts make outages slower to detect.

Decision: reject as the main architecture. We should still tune pools and probes if metrics show bad budgets, but that
is a local hardening step, not the six-month control-plane shape.

### Option B: Grant Swarm Workers Direct CNPG And Database Inspection

Pros:

- Gives every architecture and deployer lane direct database evidence.
- Removes reliance on application status projections.
- Useful during incidents.

Cons:

- Breaks least privilege for ordinary workers.
- Encourages ad hoc shell evidence instead of durable, typed witness records.
- Does not protect `/ready` from slow evidence production.

Decision: reject. Direct DB access should remain a break-glass or operator capability, not the runtime contract.

### Option C: Add Hot-Path Witness Cache And Repair Settlement Cells

Pros:

- Decouples readiness from database, Torghut, and Kubernetes evidence latency.
- Preserves least privilege by making application-produced witness records the database authority surface.
- Converts schedule failures and Torghut proof-floor repairs into settled cells with expiry, closure, and rollback
  rules.
- Lets repair stay available while normal dispatch and capital remain conservative.
- Gives deployers one current witness batch instead of several live probes.

Cons:

- Adds a durable witness schema and reducer.
- Requires careful TTLs so stale witnesses do not mask real outages.
- Requires route-level tests for readiness behavior and reducer-level tests for witness freshness.

Decision: select Option C.

## Architecture

The architecture introduces three surfaces.

### 1. Witness Batch

`witness_batch` is the durable evidence unit. It is produced off the readiness path and can be backed by Kysely tables,
Kubernetes status, or both.

```text
witness_batch
  witness_batch_id
  witness_kind
  namespace
  subject_ref
  source_snapshot_ref
  producer_revision
  generated_at
  fresh_until
  decision
  confidence
  reason_codes[]
  evidence_refs[]
  rollback_target
```

Required witness kinds:

- `serving`: local runtime, leader election, memory provider, route handler, and sealed serving passport.
- `database`: Jangar database probe, migration consistency, source schema digest, direct-inspection availability.
- `rollout`: deployment readiness, image digest, recent probe events, registry/image-pull state.
- `controller`: serving process state, controller heartbeat, ingestion witness, and split-topology authority.
- `watch`: watch stream age, restarts, errors, and event counts.
- `workflow`: active jobs, failed jobs, backoff limit windows, retained audit failure scope.
- `schedule_debt`: failed attempts, later successful attempts, debt window, and net active failures.
- `torghut_repair`: proof-floor repair ladder, quant freshness, TCA freshness, market-context freshness, and expected
  unblock value.

### 2. Hot-Path Witness Cache

The hot-path cache is an in-memory serving authority object derived from the latest `serving` witness. `/ready` reads
this cache plus leader/runtime state only.

```text
hot_path_witness_cache
  serving_witness_id
  status
  generated_at
  fresh_until
  cache_age_ms
  fallback_mode
  source_snapshot_ref
  reason_codes[]
```

Rules:

- `/ready` never performs a fresh database query.
- `/ready` never calls Torghut.
- `/ready` never lists Kubernetes resources.
- If the serving witness is fresh and local runtime checks pass, readiness returns HTTP `200`.
- If non-serving witnesses are stale, status is `degraded` in the body, but readiness stays `200`.
- If the serving witness is stale, missing, or explicitly blocked, readiness returns HTTP `503`.

### 3. Repair Settlement Cell

Repair settlement cells consume `torghut_repair`, `schedule_debt`, `database`, and `rollout` witnesses. They turn a
repair candidate into a bounded zero-notional authorization.

```text
repair_settlement_cell
  repair_cell_id
  warrant_id
  namespace
  account_label
  repair_dimension
  repair_code
  source_witness_batch_ids[]
  admission_state
  max_dispatches
  max_runtime_seconds
  max_notional
  expected_unblock_value
  opened_at
  fresh_until
  closure_requirements[]
  closure_receipt_ref
  rollback_target
```

Rules:

- `max_notional` is always `0` for repair work.
- One active cell is allowed per account, repair dimension, and witness epoch.
- A later successful schedule attempt can close schedule debt for the same stage and epoch.
- A repair cell cannot widen paper or live capital by itself.
- Paper requires the companion Torghut paper settlement ledger.
- Live micro requires paper settlement from a prior clean epoch plus live submit quorum.

## Implementation Scope

Engineer scope:

- Add a pure reducer outside `control-plane-status.ts`, tentatively `control-plane-witness-cache.ts`.
- Add typed data models for witness batches, hot-path cache status, schedule debt windows, and repair settlement cells.
- Add persistence only after the pure reducer is covered; Kysely migration should keep witness records compact and
  retain only short-lived operational rows by default.
- Change `/ready` to consume the hot-path serving witness and local checks only.
- Keep the full `/api/agents/control-plane/status` endpoint as the rich evidence surface.
- Feed repair cells into material-action receipts without allowing them to override stricter SLO budgets or verdicts.
- Keep Torghut scoring in the companion Torghut contract; Jangar owns authority, not trading value.

Tests:

- `/ready` returns without invoking the database checker, Torghut clients, or Kubernetes list calls.
- A fresh serving witness plus stale database witness returns HTTP `200` with degraded body evidence.
- A stale serving witness returns HTTP `503`.
- Database witness reports RBAC-blocked direct inspection without marking the application database unhealthy when the
  typed application probe is healthy.
- Schedule debt nets older failed cron attempts against later successful attempts in the same window.
- Repair settlement cells cap dispatches, runtime, and notional, and do not widen paper/live verdicts.
- Material-action verdicts cite repair cells as evidence but keep the stricter decision when SLO budgets disagree.

## Validation Gates

Local validation before merge:

- `bunx oxfmt --check docs/agents/designs/147-jangar-hot-path-witness-cache-and-repair-settlement-cells-2026-05-07.md docs/torghut/design-system/v6/151-torghut-repair-alpha-carry-exchange-and-paper-settlement-ledger-2026-05-07.md docs/torghut/design-system/v6/index.md`
- If code is added, run the focused Jangar route/reducer tests and any migration tests.

Engineer acceptance gates:

- Unit tests prove `/ready` does not call the database checker on the hot path.
- A fixture with `database=healthy`, `directInspection=forbidden`, and stale Torghut proof keeps read-only serving
  ready while holding capital actions.
- A fixture with one failed cron attempt followed by a successful cron attempt emits zero active schedule debt.
- A fixture with live Torghut proof-floor blockers opens only zero-notional repair cells.

Deployer acceptance gates:

- Current Jangar deployment reports a fresh serving witness after rollout.
- `kubectl get pods -n agents --no-headers` shows no new readiness crash loop after rollout.
- `/ready` is HTTP `200` when serving witness is fresh, even if non-serving witnesses are degraded.
- `/api/agents/control-plane/status?namespace=agents` exposes witness batches and repair settlement cells with fresh
  timestamps.
- Paper/live Torghut verdicts remain held or blocked until the companion Torghut settlement ledger closes.

## Rollout

Phase 0: Shadow reducer.

- Emit witness batches and repair cells in control-plane status only.
- `/ready` continues current behavior.
- Compare witness decisions with current database, route, workflow, and material-action verdicts.

Phase 1: Readiness isolation.

- Enable hot-path serving witness for `/ready`.
- Keep full status route unchanged.
- Alert when serving witness is stale before returning HTTP `503`.

Phase 2: Repair settlement activation.

- Let `dispatch_repair` consume repair settlement cells for max dispatch/runtime budgets.
- Keep `dispatch_normal`, `deploy_widen`, paper, and live capital under existing stricter gates.

Phase 3: Deployer gate integration.

- Require fresh serving, database, schedule debt, and Torghut repair witnesses in post-deploy verification.
- Require closed repair cells plus companion Torghut paper settlement before paper widening.

## Rollback

- Disable `/ready` witness mode and return to the current handler.
- Keep witness batch status projection enabled for forensics.
- Ignore repair settlement cells in material-action receipts.
- If a migration shipped, leave the witness table in place and stop writing new rows; retention can clear stale rows.
- Do not widen paper or live capital during rollback.

## Risks

- A stale serving witness could mask a real outage if TTLs are too long. Mitigation: short TTL, explicit stale counter,
  and HTTP `503` only when the serving witness itself is stale or blocked.
- Witness persistence could become noisy. Mitigation: retain compact rows, use bounded arrays, and store large payloads
  behind evidence refs.
- Repair cells could be mistaken for capital approval. Mitigation: require `max_notional=0` and keep paper/live verdict
  gates stricter.
- The first implementation could overfit current Torghut blockers. Mitigation: model repair dimensions generically and
  let Torghut publish scoring separately.

## Handoff To Engineer

Build the witness reducer and hot-path cache first. Do not start by adding capital behavior. The highest-value first
patch is a pure reducer plus `/ready` isolation tests that prove database and Torghut slowness cannot block read-only
serving while the serving witness is fresh.

Keep code boundaries strict:

- `ready.tsx` should stay small and read a local witness.
- `control-plane-status.ts` should wire the reducer but not own witness business logic.
- Repair scoring stays in Torghut; Jangar owns admission and closure authority.

The regression test that matters most is simple: make the database checker throw a timeout, provide a fresh serving
witness, and prove `/ready` still returns HTTP `200` with degraded non-serving evidence.

## Handoff To Deployer

Treat the serving witness as readiness authority only. A green serving witness means the service can serve read-only
traffic; it does not mean normal dispatch, deploy widening, paper, or live capital is safe.

Before widening any non-serving action, require:

- Fresh serving witness.
- Fresh database witness with migration consistency healthy.
- Fresh schedule debt witness with no active unnetted debt for the target stage.
- Fresh repair settlement cell closure when the action depends on Torghut proof repair.
- Companion Torghut paper settlement ledger for paper widening.
- Existing live submit, paper settlement, and expected shortfall gates for live micro or live scale.
