# 137. Jangar Watch Debt Clearing And Profit Repair Leases (2026-05-07)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-07
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, watch reliability, AgentRun ingestion, rollout safety, bounded repair
dispatch, Torghut capital gates, validation, and rollback.

Companion Torghut contract:

- `docs/torghut/design-system/v6/141-torghut-watch-debt-profit-repair-market-and-capital-reentry-gates-2026-05-07.md`

Extends:

- `136-jangar-controller-authority-settlement-and-endpoint-parity-ledger-2026-05-07.md`
- `135-jangar-database-witness-and-schema-authority-exchange-2026-05-07.md`
- `133-jangar-in-flight-stage-renewal-bonds-and-controller-ingestion-settlement-2026-05-07.md`
- `121-jangar-material-action-repair-clearing-lane-and-profit-proof-ledger-2026-05-06.md`
- `115-jangar-watch-quiescence-and-evidence-renewal-arbiter-2026-05-06.md`

## Decision

I am selecting **watch debt clearing with profit repair leases** as the next Jangar control-plane architecture step.

The current system is not down. The Jangar namespace is serving, the database route is healthy, rollout health is green,
recent scheduled cron jobs are completing, and Torghut quant latest metrics are fresh at the global route. The failure
mode is subtler and more dangerous: controller watch reliability is degraded, AgentRun ingestion is still unknown from
the serving process, execution trust is degraded by a stale verify stage, and dependency quorum blocks material action.
At the same time, the system still has a real repair opportunity. Serving and observation can continue, and bounded
zero-notional repair work can reduce the evidence debt that is holding deploy, merge, and capital actions.

The selected direction turns degraded watch reliability into an explicit clearing problem. Jangar will classify
stream-level debt, attach it to material-action receipts, and issue short-lived repair leases for the smallest work that
can retire the debt. The same lease model will feed Torghut gates so stale market context, empty forecast registry, and
open quant alerts become measurable repair bids instead of an indefinite capital freeze.

The tradeoff is more structure in the status route and one more reducer for engineers to test. I accept that. The
six-month risk is not another status field. The six-month risk is a control plane that knows it is blocked but cannot
name the next bounded repair that would unblock safe rollout or profitable trading.

## Runtime Objective And Success Metrics

This contract reduces failure modes by separating three states that are currently too easy to collapse:

- the control plane is serving;
- the controller watch fabric is current;
- material action is safe.

Success means:

- `/health` and `/ready` can remain available for read-only serving while watch debt is visible.
- `/api/agents/control-plane/status` exposes one `watch_debt_clearing_epoch` per status window.
- `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` cite the
  current watch-debt epoch before they can allow.
- `dispatch_repair` can remain available only through a repair lease with bounded runtime, bounded concurrency, and
  zero Torghut notional.
- Watch streams with repeated errors or restarts name their resource, namespace, last event, error count, restart count,
  consumer impact, and required repair action.
- Two consecutive clean watch windows are required before deploy widening or merge-ready can graduate after a degraded
  watch window.
- Torghut paper/live gates can only graduate when the watch-debt epoch, forecast proof, market-context proof, and
  account/window quant proof all agree.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, GitOps state, broker state,
trading flags, or AgentRun records.

### Cluster, Rollout, And Event Evidence

- `kubectl get pods -n jangar -o wide` showed `bumba`, `jangar`, `jangar-alloy`, `jangar-db-1`, Redis, Open WebUI,
  `symphony`, and `symphony-jangar` Running.
- The active Jangar pod was `jangar-74cd8d8fcd-rtjth`, using image
  `registry.ide-newton.ts.net/lab/jangar:1744b973@sha256:fe165d874349d309ae43fdeedd64934f0dde6cd748c92dade8992e86c2dfbaa3`.
- Jangar events showed a recent rollout with one transient readiness refusal while the new pod started.
- `kubectl get deployments -n agents` showed `agents=1/1`, `agents-controllers=2/2`, and `agents-alloy=1/1`.
- `kubectl get pods -n agents -o json` summarized `59 Failed`, `13 Running`, and `170 Succeeded` pods.
- Recent schedule jobs recovered after the older failed cron window. The latest `jangar-control-plane-plan` cron job
  completed, and new plan-stage attempt pods were running during the assessment.
- Agents events still showed readiness/liveness timeouts for `agents-controllers` and `agents` during the rollout
  window, including `/ready` timeouts and `connection refused` before recovery.
- This service account cannot list StatefulSets in `jangar` or `agents`, so the rollout assessment uses pod,
  deployment, cronjob, job, event, and service-owned status evidence.

### Endpoint And Runtime Evidence

- `GET /health` returned HTTP 200 with `status=ok`, while reporting the serving process local
  `agentsController.enabled=false` and `started=false`.
- `GET /ready` returned HTTP 200 with leader election healthy, memory provider healthy, serving runtime proof cells
  healthy, and execution trust degraded because `jangar-control-plane:verify` was stale.
- `GET /api/agents/control-plane/status?namespace=agents` at `2026-05-07T08:24:26Z` reported:
  - `rollout_health.status=healthy` for `agents` and `agents-controllers`;
  - `watch_reliability.status=degraded`;
  - `watch_reliability.total_events=1268`;
  - `watch_reliability.total_errors=14`;
  - `watch_reliability.total_restarts=17`;
  - `agentrun_ingestion.status=unknown`;
  - `agentrun_ingestion.message="agents controller not started"`;
  - `execution_trust.status=degraded`;
  - `dependency_quorum.decision=block` with `watch_reliability_blocked`.
- The top degraded streams were `orchestrations.orchestration.proompteng.ai` with `11` errors and `13` restarts, and
  `agentruns.agents.proompteng.ai` with `3` errors and `4` restarts.
- Workflow reliability itself was clean in the current window: `active_job_runs=0`, `recent_failed_jobs=0`,
  `backoff_limit_exceeded_jobs=0`, and `data_confidence=high`.
- The status route held or blocked material actions while still allowing observe and repair-shaped paths. That is the
  right policy shape, but the current payload does not yet produce a concrete stream-debt clearing contract.

### Database And Data Evidence

- Jangar database status was service-owned and healthy: `configured=true`, `connected=true`, and `status=healthy`.
- Migration consistency was healthy with `registered_count=28`, `applied_count=28`, `unapplied_count=0`,
  `unexpected_count=0`, and latest registered/applied migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- Direct CNPG SQL was blocked from this runtime:
  `pods "jangar-db-1" is forbidden: User "system:serviceaccount:agents:agents-sa" cannot create resource "pods/exec"`.
- Listing `clusters.postgresql.cnpg.io` in `jangar` was also blocked by RBAC. That boundary is correct for this worker;
  deployer validation must rely on service-owned status or an explicitly granted read-only SQL witness.
- `/api/memories/count` returned `579`, and `/api/memories/stats` showed heavy recent write activity: `138` memories on
  `2026-05-05`, `300` on `2026-05-06`, and `76` on `2026-05-07` at assessment time.
- `/api/torghut/trading/control-plane/quant/health` returned global `status=ok`, `latestMetricsCount=4032`, and
  `metricsPipelineLagSeconds=2`.
- Account/window quant health for strategy `db327e20-4d37-45f3-bf18-5c51e844de31`, account `PA3SX7FYNUTF`, and
  windows `1m` and `5m` returned `status=ok` outside market hours, but lag was still `144` seconds and `138` seconds,
  and `stages=[]` for the 60-second lookback.
- `/api/torghut/trading/control-plane/quant/alerts?state=open` returned `36` open alerts: `23` critical
  `metrics_pipeline_lag_seconds`, `12` `ta_freshness_seconds`, and `1` `sharpe_annualized`.
- `/api/torghut/market-context/health?symbol=NVDA` returned `overallState=degraded`; technicals, fundamentals, news,
  and regime domains were stale. `AAPL` market-context health timed out at 10 seconds from this runtime.
- `empirical_services.forecast.status=degraded` with `message=registry_empty`, while empirical jobs were fresh and
  authoritative.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` is `781` lines and is the right aggregation boundary for the
  watch-debt reducer. It already composes database status, rollout health, workflows, execution trust, failure-domain
  leases, action clocks, negative evidence, controller witness quorum, and material-action verdicts.
- `services/jangar/src/server/control-plane-watch-reliability.ts` is `181` lines and records in-memory watch events,
  errors, restarts, and top streams. It degrades on any observed error or on per-stream restart threshold.
- `services/jangar/src/server/control-plane-controller-witness.ts` is `444` lines and already converts watch health,
  rollout health, and AgentRun ingestion into controller witness decisions.
- `services/jangar/src/server/control-plane-material-action-verdict.ts` is `473` lines and is the correct place to make
  watch-debt receipts a mandatory lower bound for material action.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` is `610` lines and already captures current
  runtime negative evidence. It should consume stream-specific watch debt rather than only the aggregate degraded bit.
- `services/jangar/src/server/supporting-primitives-controller.ts` is `3062` lines and owns schedule runner generation,
  runner status reconciliation, swarms, requirements, workspace PVC status, and repair dispatch surfaces.
- `services/jangar/src/server/agents-controller/index.ts` is `1827` lines; the full `agents-controller` module is
  `9830` lines. The architecture should avoid stuffing more policy into the reconciler and instead feed it from a small
  tested reducer.
- `services/jangar/src/server/torghut-quant-metrics-store.ts` is `399` lines and already provides the latest-store and
  pipeline-health projection boundary.
- `services/torghut/app/trading/scheduler/pipeline.py` is `4349` lines and remains too large to be the first place to
  encode cross-plane repair policy.
- Existing tests cover watch reliability thresholds, control-plane status, split-topology rollout substitution,
  material-action verdicts, PVC aliases, and supporting-controller schedule behavior. The missing coverage is a fixture
  that turns degraded watch streams plus Torghut evidence debt into stream-scoped repair leases and material-action
  effects.

## Problem

Jangar can now say "material action is blocked," but it cannot yet say "this is the next bounded repair that retires the
specific watch debt blocking action."

That creates four operational problems:

1. A degraded watch stream becomes a broad material-action blocker even when only one resource stream is noisy.
2. Repair work competes with normal scheduled work instead of being leased, bounded, and tied to the blocking evidence.
3. Torghut capital gates can see Jangar is blocked and Torghut evidence is stale, but they do not get a repair bid that
   explains which proof would unlock observe, paper, or live capital.
4. Deployer validation must manually interpret `/health`, `/ready`, status, events, and Torghut routes during a rollout
   window.

The architecture needs a debt-clearing layer that turns noisy watch streams into receipts, ranks the receipts by
consumer impact, issues bounded repair leases, and forces deploy/merge/capital gates to cite a current debt-clearing
epoch.

## Alternatives Considered

### Option A: Freeze Everything Except Read-Only Serving

This option blocks all dispatch, deploy widening, merge readiness, and Torghut capital whenever watch reliability is
degraded.

Pros:

- Very safe.
- Easy to reason about during incidents.
- Small implementation surface.

Cons:

- Prevents the very repair work needed to restore watch and evidence freshness.
- Turns transient or single-resource watch noise into a global stall.
- Does not prioritize Torghut proof repair even when zero-notional work could improve capital readiness.

Decision: reject.

### Option B: Let Rollout And Database Health Override Watch Debt

This option treats healthy deployments, current workflow data, and healthy database migrations as enough to keep normal
dispatch moving even if watch reliability is degraded.

Pros:

- Keeps throughput high.
- Avoids blocking on in-memory watch counters.
- Uses evidence surfaces that are already present in status.

Cons:

- A healthy rollout is not proof that the controller observed the resources it must reconcile.
- It can hide AgentRun ingestion gaps behind deployment availability.
- It risks widening rollout or releasing capital while controller evidence is stale.

Decision: reject.

### Option C: Watch Debt Clearing And Profit Repair Leases

This option creates a short-lived watch-debt epoch, stream-scoped debts, and bounded repair leases. Material actions
must cite the epoch. Repair is allowed only when it is tied to a specific debt and cannot widen rollout or release
capital.

Pros:

- Keeps read-only serving and observe routes available.
- Allows targeted zero-notional repair while holding unsafe material action.
- Names the watch stream, consumer impact, and repair action that matter.
- Gives Torghut a measurable repair market instead of a binary capital hold.
- Converts deployer checks into a small set of receipts rather than manual route interpretation.

Cons:

- Adds one reducer and status projection.
- Requires two clean windows before some actions can graduate after a watch incident.
- Needs careful bounds so repair leases do not become another source of noisy dispatch.

Decision: select Option C.

## Architecture

Jangar emits one watch-debt clearing epoch per status window.

```text
watch_debt_clearing_epoch
  epoch_id
  generated_at
  fresh_until
  namespace
  window_minutes
  aggregate_status             # clean | degraded | unknown
  clean_window_count
  debt_count
  selected_repair_lease_count
  stream_debts[]
  repair_leases[]
  action_effects[]
  producer_revision
```

Each stream debt is scoped to one resource and namespace.

```text
watch_stream_debt
  debt_id
  resource
  namespace
  state                        # clean | noisy | stale | partitioned | unknown
  events
  errors
  restarts
  last_seen_at
  first_observed_at
  consumer_impact              # controller_ingestion | orchestration | approval | schedule | unknown
  material_action_scope[]      # dispatch_normal, deploy_widen, merge_ready, paper_canary, live_micro_canary, live_scale
  reason_codes[]
  required_repair_action
  evidence_refs[]
```

Repair leases are short-lived and deliberately narrow.

```text
watch_repair_lease
  lease_id
  debt_id
  action_class                 # dispatch_repair | torghut_observe | proof_repair
  max_dispatches
  max_runtime_seconds
  max_notional                 # always 0 for Jangar-originated repair leases
  allowed_until
  required_success_receipt
  rollback_target
```

Action effects are the bridge to the rest of the status route.

```text
watch_debt_action_effect
  action_class
  decision                     # allow | observe_only | repair_only | hold | block
  required_epoch_id
  required_clean_windows
  repair_lease_refs[]
  reason_codes[]
```

Policy:

- `serve_readonly`: allow when route and serving passport are current, even if watch debt is degraded.
- `dispatch_repair`: allow only through one or more repair leases with zero notional and bounded runtime.
- `dispatch_normal`: repair-only while any `agentruns` debt is noisy, stale, partitioned, or unknown.
- `deploy_widen`: hold until the current rollout is healthy and there are two consecutive clean watch windows.
- `merge_ready`: hold for control-plane, schedule, status, Torghut, or deployer changes until the debt epoch is clean.
- `torghut_observe`: allow when it records evidence and does not mutate capital.
- `paper_canary`: hold until watch debt is clean, forecast proof is current, market context is fresh for the candidate
  lane, and account/window quant alerts are cleared or explicitly waived.
- `live_micro_canary` and `live_scale`: block until paper settlement and all paper gates are current.

## Implementation Scope

Engineer stage should implement this in small, reversible slices:

1. Add a pure watch-debt reducer beside `control-plane-watch-reliability.ts`.
2. Extend `ControlPlaneStatus` and the UI data model with `watch_debt_clearing_epoch`.
3. Feed the reducer from the existing `watch_reliability` summary and controller witness inputs.
4. Add debt evidence refs to `negative_evidence_router`, `reconciled_action_clocks`, and
   `material_action_verdict_epoch`.
5. Stamp repair leases onto status only in shadow mode first. Do not create AgentRuns from the reducer in the first
   implementation.
6. Add schedule-runner admission checks so normal scheduled dispatch cites a current clean epoch before launch, while
   repair dispatch cites a repair lease.
7. Add Torghut input fields for candidate account/window proof and market-context claim ids.

No database migration is required for the first implementation if the epoch is computed from in-memory watch summaries
and existing route/database projections. If the team persists historical clean-window counts, use a bounded Kysely
migration and expose migration parity through the existing database status path.

## Validation Gates

Required engineer checks:

- Unit: degraded `agentruns.agents.proompteng.ai` stream produces `dispatch_normal=repair_only`,
  `deploy_widen=hold`, and a `dispatch_repair` lease.
- Unit: degraded `orchestrations.orchestration.proompteng.ai` stream holds deploy/merge but does not block
  `serve_readonly`.
- Unit: two clean windows retire prior debt and allow deploy/merge effects when other gates are healthy.
- Unit: repair leases always have `max_notional=0`, bounded runtime, and at most the configured dispatch count.
- Route: `/api/agents/control-plane/status?namespace=agents` includes `watch_debt_clearing_epoch` and all material
  action receipts cite its `epoch_id`.
- Route: `/ready` remains a serving readiness endpoint and does not perform expensive watch-debt recomputation.
- Integration: schedule runner fails closed for normal dispatch when the current schedule stamp does not match the
  current clean debt epoch.

Suggested local commands:

```bash
bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-watch-reliability.test.ts
bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-status.test.ts
bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-material-action-verdict.test.ts
bun run --filter jangar test -- services/jangar/src/server/__tests__/supporting-primitives-controller.test.ts
```

Required deployer checks:

```bash
curl -fsS http://jangar.jangar.svc/api/agents/control-plane/status?namespace=agents | \
  jq '.watch_debt_clearing_epoch,.material_action_verdict_epoch'
curl -fsS http://jangar.jangar.svc/ready | jq '.status,.execution_trust'
kubectl get pods -n agents -o wide
kubectl get jobs -n agents --sort-by=.metadata.creationTimestamp | tail -40
```

Promotion is blocked until the status route shows a fresh epoch, material action receipts cite the epoch, and deployer
evidence shows no new controller watch errors across two status windows.

## Rollout Plan

1. **Shadow projection:** expose `watch_debt_clearing_epoch` without changing action decisions.
2. **Receipt wiring:** require material-action receipts and action clocks to cite the epoch while preserving current
   decisions.
3. **Repair leases:** allow only bounded `dispatch_repair` leases for one debt per resource class per window.
4. **Deploy and merge holds:** enforce two clean windows for `deploy_widen` and `merge_ready`.
5. **Torghut paper gate:** require watch-debt clean state, market-context freshness, forecast proof, and account/window
   quant alert clearance for paper canaries.
6. **Live capital gates:** keep live micro and live scale blocked until paper settlement receipts prove the gate.

## Rollback Plan

- Disable enforcement by setting the watch-debt clearing mode back to `shadow` or `off`; keep the status fields visible
  so deployers can still inspect debt.
- If the reducer is wrong, remove its action effects first and leave the aggregate watch reliability status unchanged.
- If schedule-runner stamping blocks legitimate repairs, disable normal-dispatch enforcement while preserving repair
  lease citation in status.
- If Torghut capital gates become too strict, fall back to `torghut_observe` only and require human approval for paper
  until the reducer is fixed.

Rollback must not delete evidence refs, migration records, memories, or historical watch counters.

## Risks And Mitigations

- **In-memory watch state resets on pod restart.** Treat unknown debt after restart as `repair_only` for normal dispatch
  until one clean window is observed.
- **Repair leases could create more work during an incident.** Keep max dispatch low, require zero notional, and bind
  each repair to one stream debt.
- **Endpoint latency could grow.** Build the reducer from already-collected status inputs; do not add per-request wide
  Kubernetes or database scans.
- **Torghut stale evidence may hold capital longer than expected.** That is acceptable; observe remains open, and the
  companion contract defines measurable repair bids to retire the debt.
- **RBAC blocks direct SQL validation.** Use service-owned status for routine validation and request a narrow read-only
  SQL witness only if deployer acceptance requires direct database proof.

## Handoff Contract

Engineer acceptance gates:

- A pure reducer creates deterministic watch debts, repair leases, and action effects.
- Status, action clocks, material verdicts, and negative evidence cite the same debt epoch.
- Schedule runner normal dispatch fails closed when the clean epoch is stale or missing.
- Repair dispatch remains available with bounded zero-notional leases.
- Tests cover degraded AgentRun watch, degraded orchestration watch, clean-window recovery, and Torghut capital holds.

Deployer acceptance gates:

- The status route exposes `watch_debt_clearing_epoch`.
- Two consecutive status samples show clean watch debt before deploy widening.
- `dispatch_repair` receipts name a repair lease; `dispatch_normal`, `deploy_widen`, and `merge_ready` cite a clean
  epoch.
- Torghut paper/live gates remain held until forecast, market-context, account/window quant, and watch-debt evidence are
  current.

Done means Jangar can keep serving, keep observing, and launch bounded repair while proving why broad dispatch, deploy
widening, merge readiness, or Torghut capital should wait.
