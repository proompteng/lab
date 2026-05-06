# 118. Jangar Repair Admission Governor And Profit Renewal Bids (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar material-action admission, watch backpressure, repair dispatch, Torghut evidence renewal, rollout
widening, and deployer acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/122-torghut-profit-renewal-bids-and-capital-shadow-ledger-2026-05-06.md`

Extends:

- `117-jangar-evidence-debt-tranches-and-capital-unblock-ledger-2026-05-06.md`
- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`
- `115-jangar-watch-quiescence-and-evidence-renewal-arbiter-2026-05-06.md`
- `111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md`

## Decision

I am selecting a **repair admission governor with Torghut profit-renewal bids** as the next Jangar control-plane
architecture step.

The current system is not in a broad outage. In the read-only sample at `2026-05-06T13:23Z`, Argo CD reported
`agents`, `jangar`, and `torghut` as `Synced` and `Healthy` at revision
`cbf0d72c1fdb27d1f5d9f967b9d64742ff18ddfb`. `deployment/agents` was `1/1`, `deployment/agents-controllers` was
`2/2`, and `deployment/jangar` was `1/1`. Torghut live revision `torghut-00237` and sim revision
`torghut-sim-00326` were running, and Jangar `/health` and `/ready` returned HTTP `200`.

The current system is also not safe to widen or activate capital. Jangar database projection was healthy with `28/28`
Kysely migrations applied, but dependency quorum returned `decision=block` for `watch_reliability_blocked` and
`empirical_jobs_degraded`. Watch reliability was `degraded` with `3` streams, `6894` events, `2` errors, and `6`
restarts in the 15-minute window. `dispatch_normal` was downgraded to `repair_only`; `merge_ready` and `paper_canary`
were held; `live_micro_canary` and `live_scale` were blocked. Torghut live `/readyz` returned HTTP `503` with
`simple_submit_disabled` in `capital_stage=shadow`. Torghut sim `/readyz` returned HTTP `200`, but the typed quant
latest store was empty. Market context for `AAPL` was degraded, and Jangar had `50` open quant alerts.

The selected design adds one decision point above the existing negative-evidence router: a repair admission governor.
It does not replace dependency quorum, action SLO budgets, evidence-debt tranches, or watch quiescence. It consumes
them and answers a narrower question: which zero-notional repair lane may run now, at what concurrency, with which
closure receipt, while material actions remain held.

The tradeoff is an explicit admission step before repair. I accept that. The six-month reliability risk is no longer
"we have no gates." It is that multiple gates hold for true but different reasons, and the system spends scarce
runtime on the wrong repair while stale proof keeps capital at zero. Jangar needs to choose repair work with the same
discipline it uses to block material action.

## Evidence Snapshot

All checks for this decision were read-only. I did not mutate Kubernetes resources, database rows, trading flags,
broker topics, Argo applications, or GitHub records.

### Cluster And Rollout Evidence

- Runtime identity was `system:serviceaccount:agents:agents-sa`.
- Branch was `codex/swarm-jangar-control-plane-plan`, based on `main`.
- Argo CD reported `agents`, `jangar`, and `torghut` as `Synced` and `Healthy` at
  `cbf0d72c1fdb27d1f5d9f967b9d64742ff18ddfb`.
- `deployment/agents` was `1/1` available on
  `registry.ide-newton.ts.net/lab/jangar-control-plane:89d740d3@sha256:24bf1e805e6026be318ad2659c39bae83de36f3cf6aa47bba4be773da45d37f0`.
- `deployment/agents-controllers` was `2/2` available on
  `registry.ide-newton.ts.net/lab/jangar:89d740d3@sha256:c897e060175fd53ae055ad4a4f2f1ceeae5d3ae3e97d130c7d556af096d2e035`.
- `deployment/jangar` was `1/1` available on the same Jangar image family.
- The agents namespace had `8` Running pods, `34` Error pods, and `165` Completed pods. The current plan pod and a
  verify pod were running, but retained failed plan, verify, Torghut discover, Torghut implement, and Torghut verify
  pods remained as audit debt.
- Recent agents events included readiness probe timeouts against the serving `agents` pod and both
  `agents-controllers` pods, plus a `BackoffLimitExceeded` job for a Torghut market-context fundamentals preopen probe.
- Jangar namespace pods were running. Recent Jangar events only showed the Elasticsearch PDB `NoPods` condition.
- Torghut live revision `torghut-00237`, sim revision `torghut-sim-00326`, ClickHouse, Keeper, Postgres, live TA,
  sim TA, options catalog, options enricher, websockets, Alloy, and Symphony pods were running.
- Recent Torghut events showed sim rollout churn settling, a successful sim runtime-ready analysis, one failed sim
  activity analysis, and duplicate ClickHouse PodDisruptionBudget warnings.
- The runtime service account could list core Torghut services and pods, but could not list Knative services or
  FlinkDeployment resources in the `torghut` namespace. That reinforces that admission logic should use published
  service projections, not privileged cluster reads, for routine operation.

### Database And Data Evidence

- Direct `kubectl cnpg psql` probes for `jangar-db` and `torghut-db` failed because this service account cannot
  create `pods/exec` in those namespaces. That RBAC boundary is correct; deployer validation must rely on service
  projections unless a higher-privilege read-only path is explicitly granted.
- Jangar `/api/agents/control-plane/status?namespace=agents` reported database `configured=true`, `connected=true`,
  `status=healthy`, `latency_ms=3`, registered migrations `28`, applied migrations `28`, and no missing or unexpected
  migrations.
- Jangar execution trust was healthy with no blocking windows.
- Jangar AgentRun ingestion was `unknown` with message `agents controller not started`, because the serving process is
  not the controller process.
- Jangar watch reliability was `degraded`: `3` observed streams, `6894` events, `2` errors, and `6` restarts over the
  15-minute window.
- Jangar dependency quorum was `block` with reasons `watch_reliability_blocked` and `empirical_jobs_degraded`.
- Jangar action SLO budgets allowed `serve_readonly`, `dispatch_repair`, `deploy_widen`, and `torghut_observe`.
  `dispatch_normal` was `repair_only`; `merge_ready` and `paper_canary` were held; `live_micro_canary` and
  `live_scale` were blocked.
- Torghut live `/readyz` returned HTTP `503`: Postgres, ClickHouse, Alpaca, database schema, scheduler, and universe
  checks were healthy, but live submission was blocked by `simple_submit_disabled` in `capital_stage=shadow`.
- Torghut `/trading/autonomy` reported stale empirical jobs `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`, all for `intraday_tsmom_v1@prod` and dataset
  `torghut-full-day-20260318-884bec35`.
- Torghut sim `/readyz` returned HTTP `200` in paper mode, but quant evidence was degraded:
  `latestMetricsCount=0`, `emptyLatestStoreAlarm=true`, and `stage_count=0`.
- Jangar typed quant health for live account `PA3SX7FYNUTF`, window `15m`, returned HTTP `200` with
  `latestMetricsCount=108`, `latestMetricsUpdatedAt=2026-05-05T17:28:03.839Z`, and
  `metricsPipelineLagSeconds=71764`.
- Jangar market-context health for `AAPL` returned `overallState=degraded`, `bundleFreshnessSeconds=147901`, and
  `bundleQualityScore=0.4575`. Technicals, fundamentals, news, and regime were stale even though fundamentals, news,
  and ClickHouse ingestion were configured and recently successful as providers.
- Jangar quant alerts returned `50` open alerts: `37` critical and `13` warning.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` composes database status, controller health, rollout health,
  watch reliability, workflow reliability, empirical services, runtime admission, failure-domain leases, negative
  evidence routing, controller witness quorum, and execution trust into one status payload.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` already translates watch degradation,
  AgentRun ingestion ambiguity, stale empirical jobs, market-context debt, quant alerts, workflow failures, and rollout
  ambiguity into action-level budgets.
- `services/jangar/src/server/control-plane-watch-reliability.ts` tracks events, errors, restarts, and stream freshness;
  it can tell the governor whether repair can run under a noisy but observable watch fabric.
- `services/jangar/src/server/supporting-primitives-controller.ts` is still the broadest Jangar risk surface at
  `2883` lines and owns schedule generation, runner ConfigMaps, CronJobs, swarm admission, requirements, freezes,
  workspace state, and PVC lifecycle.
- `services/jangar/src/server/primitives-kube.ts` now includes `PersistentVolumeClaim` aliases, and focused tests cover
  PVC read/list/delete paths plus workspace reconciliation. That removes one older primitive gap but leaves the
  supporting controller as the high-blast-radius repair surface.
- `services/torghut/app/main.py` is `4051` lines and assembles readiness, DB checks, trading health, autonomy,
  decisions, executions, and data projections.
- `services/torghut/app/trading/submission_council.py` is `1196` lines and already loads typed Jangar quant health
  before live submission. It is the right Torghut consumer for capital-grade repair receipts.
- `services/torghut/app/trading/empirical_jobs.py` is `561` lines and verifies artifact truthfulness, lineage, stale
  job status, and promotion authority eligibility.
- `services/torghut/app/trading/scheduler/pipeline.py` is `4349` lines and owns signal continuity, market-context
  observations, rejection accounting, LLM decision context, and order preparation.
- Focused tests exist for Jangar status, negative evidence, watch reliability, controller witness, PVC primitives,
  supporting schedule runners, Torghut empirical jobs, market context, typed quant health, submission council, and
  quant readiness. The missing system-level test is repair admission across Jangar watch backpressure, action budgets,
  stale empirical proof, market-context freshness, quant alerts, and Torghut capital state.

## Problem

The current architecture can block unsafe action, but it does not yet allocate repair capacity.

That distinction matters now. Jangar has a healthy database projection and serving path, but dependency quorum is
blocked. Torghut has healthy storage dependencies, but live capital is deliberately disabled and proof is stale. The
negative-evidence router says `dispatch_repair` may run and normal dispatch may only run as repair. It does not say
whether the first repair should stabilize watch streams, publish a controller ingestion witness, rerun empirical jobs,
bootstrap sim quant metrics, refresh market context, close quant alerts, or clean retained execution debt.

A human can infer an ordering from the evidence. The control plane should make that ordering durable. Repair dispatch
is still a material system action: it consumes controller attention, API budget, database capacity, market-data budget,
and engineering review. Without an admission governor, a low-value repair can crowd out the repair that clears
`merge_ready`, paper canary, or live micro-canary.

## Alternatives Considered

### Option A: Freeze All Repair While Watch Reliability Is Degraded

Pros:

- Very conservative.
- Easy to reason about during API-server or controller instability.
- Avoids adding more load to an already noisy watch window.

Cons:

- Prevents the bounded repairs needed to clear stale proof.
- Treats zero-notional empirical replay and market-context refresh as equally dangerous as rollout widening.
- Leaves Torghut capital at zero without a path to earn back evidence.
- Encourages manual bypasses when repair is obviously safe but globally frozen.

Decision: reject as the default. Keep it only for watch data loss, unknown controller authority, or database pressure.

### Option B: Let Torghut Rank And Dispatch All Profit Repairs

Pros:

- Optimizes directly for profit evidence.
- Gives stale empirical jobs and quant freshness a clear owner.
- Avoids building another Jangar projection.

Cons:

- Torghut should not own Jangar controller watch backpressure or merge/deploy admission.
- Expected profit is not a substitute for control-plane authority.
- It cannot safely decide whether a repair lane is allowed while Jangar dependency quorum is blocked.

Decision: reject as the control-plane layer. Torghut should publish bids, not grant admission.

### Option C: Jangar Repair Admission Governor Consuming Torghut Profit-Renewal Bids

Pros:

- Separates repair ranking from material-action admission.
- Lets Jangar reserve capacity for watch and controller repair before profit repair when the evidence fabric is noisy.
- Lets Torghut express expected information gain and capital-unblock value without bypassing Jangar gates.
- Keeps notional at `0` while still making proof renewal productive.
- Produces a durable closure receipt for engineer and deployer stages.

Cons:

- Adds another reducer and receipt type.
- Requires careful starvation rules so Torghut profit repair is not indefinitely delayed by retained historical pod
  debt.
- Requires Torghut bid quality to improve over time; early scores will be coarse.

Decision: select Option C.

## Architecture

Jangar adds a `control_plane_repair_admission_epoch` projection.

```text
control_plane_repair_admission_epoch
  epoch_id
  generated_at
  expires_at
  namespace
  dependency_quorum_decision
  watch_reliability_ref
  controller_witness_quorum_ref
  action_slo_budget_refs
  evidence_debt_tranche_refs
  retained_audit_debt_summary
  database_projection_ref
  torghut_profit_renewal_bid_refs
  selected_lane_ids
  denied_lane_ids
  max_concurrent_repairs
  max_api_error_budget_spend
  max_runtime_seconds
  max_notional
  decision                         # allow_repair, hold_repair, emergency_freeze
  reason_codes
  rollback_target
```

Each selected lane becomes a `control_plane_repair_lane_intent`.

```text
control_plane_repair_lane_intent
  lane_id
  epoch_id
  lane_class                       # watch_stabilization, controller_witness, schedule_runner,
                                   # empirical_replay, sim_quant_bootstrap, market_context_rehydrate,
                                   # quant_alert_closure, deploy_convergence, audit_cleanup
  owner_lane                       # engineer, deployer, torghut_quant, platform
  scope
  allowed_actions
  denied_actions
  max_dispatches
  max_runtime_seconds
  max_notional
  evidence_refs
  required_closure_receipt_kind
  expiry
```

A completed lane emits a `control_plane_repair_lane_receipt`.

```text
control_plane_repair_lane_receipt
  receipt_id
  lane_id
  completed_at
  closure_status                   # complete, partial, failed, expired
  retired_debt_tranche_ids
  remaining_debt_tranche_ids
  before_refs
  after_refs
  validation_commands
  rollback_target
  next_allowed_action_classes
```

Initial lane priority:

| Priority | Lane                       | Admission Rule                                                                                        |
| -------- | -------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1        | `watch_stabilization`      | Required when watch errors are non-zero or restart count exceeds the quiescence threshold.            |
| 2        | `controller_witness`       | Required when serving-process ingestion is `unknown` and no fresh controller-process witness exists.  |
| 3        | `empirical_replay`         | Allowed at one zero-notional dispatch when watch data is observable and empirical jobs are stale.     |
| 4        | `sim_quant_bootstrap`      | Allowed after empirical replay or when sim latest metrics are empty and live capital remains blocked. |
| 5        | `market_context_rehydrate` | Allowed when provider and ClickHouse ingestion are configured but domains are stale.                  |
| 6        | `quant_alert_closure`      | Allowed when open critical alerts outlive the latest metrics window.                                  |
| 7        | `deploy_convergence`       | Allowed only after watch/controller repair receipts are fresh.                                        |
| 8        | `audit_cleanup`            | Never blocks material action alone; runs when no higher-value repair is pending.                      |

## Admission Rules

- `serve_readonly` remains allowed when the database projection is healthy.
- `dispatch_repair` may run with `max_concurrent_repairs=1` while dependency quorum is blocked, unless watch errors are
  rising, the database projection is unhealthy, or controller witness debt is stale past its expiry.
- `dispatch_normal` remains `repair_only` until controller witness and watch quiescence receipts are both fresh.
- `merge_ready` stays held while dependency quorum is blocked or any selected lane has an expired required receipt.
- `deploy_widen` may be allowed only when the current admission epoch has no `watch_stabilization` or
  `controller_witness` lane selected.
- `paper_canary`, `live_micro_canary`, and `live_scale` require Torghut closure receipts and remain zero-notional until
  the companion capital shadow ledger reports clean settlement.
- Retained historical Error pods increase audit-cleanup priority but do not block repair or material action unless
  their failure reason appears in the current watch, workflow, or debt-tranche window.

## Engineer Scope

The engineer stage should implement this in small, testable pieces:

1. Add a pure reducer that builds `control_plane_repair_admission_epoch` from existing Jangar status inputs.
2. Add lane-intent and lane-receipt TypeScript types to the control-plane data contract.
3. Expose the current admission epoch from the control-plane status payload without changing current action SLO budget
   decisions.
4. Add tests that cover watch-degraded plus empirical-stale, controller-witness split, Torghut sim empty latest store,
   market-context stale, and retained audit debt.
5. Keep enforcement in shadow until the deployer confirms receipts match observed cluster behavior for at least one
   repair window.

The first implementation should not mutate Torghut capital flags, Kubernetes objects, or database records from the
governor. It should publish advice and receipts. Enforcement comes after receipt quality is proven.

## Deployer Gates

Before widening enforcement, the deployer must capture:

- Argo `agents`, `jangar`, and `torghut` `Synced` and `Healthy` at the target revision.
- Jangar database projection healthy with all registered migrations applied.
- Watch reliability at `healthy`, or a repair admission epoch explicitly selecting `watch_stabilization` with
  `dispatch_repair` only.
- Controller witness quorum `allow` or `allow_with_split` with fresh controller-process evidence.
- Torghut live `/readyz` and `/trading/health` explaining any HTTP `503` as a capital hold, not storage failure.
- Torghut sim latest quant store non-empty before paper canary.
- Market-context domains within configured freshness windows before any capital action that uses LLM or contextual
  evidence.
- No open critical quant alerts for the candidate scope, or an explicit bounded-debt waiver attached to the lane
  receipt.

## Rollout

Phase 1 is shadow-only projection. The status API emits repair admission epochs and lane intents while existing action
SLO budgets remain authoritative.

Phase 2 lets `dispatch_repair` cite a lane intent in logs and NATS/Jangar updates. Failed or expired receipts do not
block current behavior yet; they only create audit evidence.

Phase 3 makes `merge_ready`, `paper_canary`, and `deploy_widen` require fresh repair admission when dependency quorum
was blocked in the prior window.

Phase 4 makes `live_micro_canary` and `live_scale` require Torghut profit-renewal receipts plus a clean capital shadow
ledger.

## Rollback

Rollback is to ignore `control_plane_repair_admission_epoch` for enforcement and return to the existing negative
evidence router, action SLO budgets, failure-domain leases, dependency quorum, and controller witness gates. The
projection can keep emitting in observe mode. If it emits bad priorities, deployer disables enforcement and keeps
`dispatch_repair` manually capped at one zero-notional repair.

## Risks

- The governor can starve Torghut profit repair if watch turbulence is frequent. Mitigation: require starvation
  counters and a bounded bypass for zero-error watch restarts.
- Coarse profit bids can over-rank low-quality work. Mitigation: early bids use information-gain classes, not dollar
  PnL claims.
- Retained audit debt can create false urgency. Mitigation: current-window evidence gates material action; historical
  failures only affect audit cleanup priority.
- More receipts can confuse operators. Mitigation: expose one selected lane, one denied reason list, and one next
  closure receipt per action class.

## Handoff

Engineer acceptance gate: a test fixture with Jangar watch degraded, empirical jobs stale, Torghut live shadow, sim
quant empty, market context stale, and `50` open quant alerts must select exactly one zero-notional repair lane and
hold merge, paper, live micro, and live scale.

Deployer acceptance gate: after rollout, the deployer must be able to point to one admission epoch, one lane intent,
and one closure receipt before any blocked material action changes state.
