# 117. Jangar Evidence Debt Tranches And Capital Unblock Ledger (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar dependency-quorum blocks, AgentRun ingestion authority, evidence-debt repair dispatch, Torghut
capital unblock, rollout widening, and deployer acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/121-torghut-evidence-debt-tranches-and-profit-unblock-ladder-2026-05-06.md`

Extends:

- `116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`
- `115-jangar-watch-quiescence-and-evidence-renewal-arbiter-2026-05-06.md`
- `113-jangar-contradiction-settlement-and-profit-repair-auction-2026-05-06.md`
- `111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md`

## Decision

I am selecting **evidence-debt tranches with a material-action unblock ledger** as the next Jangar control-plane
architecture step.

The current cluster is healthy enough to make this problem precise. In the read-only sample at
`2026-05-06T13:08Z`, Argo CD reported `agents`, `jangar`, and `torghut` as `Synced` and `Healthy` at revision
`84739fac65e8eaf8d82922ca2f605c262c182ef9`. `deployment/jangar` was `1/1`, `deployment/agents` was `1/1`,
`deployment/agents-controllers` was `2/2`, and the active Torghut live and sim revisions were ready. Jangar
`/health` returned HTTP `200`, the database projection was healthy with `28/28` Kysely migrations applied, execution
trust was healthy, and watch reliability was healthy with `3` streams, `7982` events, `0` errors, and `3` restarts in
the 15-minute window.

That is not enough to widen or activate capital. The same Jangar status reported dependency quorum
`decision=block` because `empirical_jobs_degraded`. Normal dispatch was downgraded to `repair_only` because
`agentrun_ingestion.status=unknown` with message `agents controller not started`. `merge_ready`, `paper_canary`,
`live_micro_canary`, and `live_scale` were held or blocked. Torghut live `/readyz` and `/trading/health` returned
HTTP `503` with `simple_submit_disabled`, `capital_stage=shadow`, `promotion_eligible_total=0`, and
`rollback_required_total=3`. Torghut sim was reachable and paper-mode ready, but its quant proof was degraded because
`latestMetricsCount=0`. Market context for `AAPL` was configured and reachable, but all four domains were stale.

The selected design changes the operating model from "blocked because degraded" to "blocked by named evidence debt
tranches with ranked repair and explicit unblock receipts." Jangar should keep serving, observation, and bounded
repair dispatch open. It should not let stale empirical jobs, empty quant metrics, stale market context, or missing
controller witness receipts remain a single undifferentiated global block. Each material action must name the debt
tranches that hold it, the repair class allowed to run, the closure evidence required, the expiry, and the rollback
target if a tranche reopens.

The tradeoff is one more projection in the control plane. I accept that. The six-month reliability risk is not merely
that Jangar fails closed. It is that repair work cannot be prioritized while capital and rollout widening stay safely
at zero. The control plane needs a ledger that makes the safest next repair obvious and prevents local liveness from
being mistaken for capital authority.

## Evidence Snapshot

All checks for this decision were read-only. I did not mutate Kubernetes resources, database rows, trading flags,
Argo applications, GitHub records, or broker topics.

### Cluster And Rollout Evidence

- Runtime identity was `system:serviceaccount:agents:agents-sa`.
- Branch was `codex/swarm-jangar-control-plane-discover`, based on `main`.
- Argo CD reported `agents`, `jangar`, and `torghut` `Synced` and `Healthy` at
  `84739fac65e8eaf8d82922ca2f605c262c182ef9`.
- `deployment/jangar` was `1/1` available on
  `registry.ide-newton.ts.net/lab/jangar:89d740d3@sha256:c897e060175fd53ae055ad4a4f2f1ceeae5d3ae3e97d130c7d556af096d2e035`.
- `deployment/agents` was `1/1` available on
  `registry.ide-newton.ts.net/lab/jangar-control-plane:89d740d3@sha256:24bf1e805e6026be318ad2659c39bae83de36f3cf6aa47bba4be773da45d37f0`.
- `deployment/agents-controllers` was `2/2` available on the same `89d740d3` Jangar image family.
- The agents namespace still carried retained execution debt: current non-succeeded pods included running discover,
  implement, and verify jobs, plus many Error pods from earlier plan, verify, and Torghut quant attempts.
- Recent agents events showed the current discover job started, while the active `agents` and `agents-controllers`
  pods had recent readiness probe timeouts. Current selected pods were still Running and Ready with zero restarts.
- Jangar namespace pods were Running. Recent events showed the current Jangar rollout started successfully after one
  startup readiness miss, and the daily `jangar-db` backup completed.
- Torghut live revision `torghut-00237` and sim revision `torghut-sim-00326` were running. ClickHouse, Keeper,
  Postgres, live TA, sim TA, options catalog, options enricher, websocket, Alloy, and Symphony pods were running.
- Recent Torghut events showed the sim revision and sim Flink job settling, a successful sim runtime analysis, and
  residual duplicate ClickHouse PodDisruptionBudget warnings.

### Database And Data Evidence

- Direct `kubectl cnpg psql` probes for `jangar-db` and `torghut-db` failed because this service account cannot
  create `pods/exec` in those namespaces. That RBAC boundary is correct; deployer validation must rely on service
  projections unless a higher-privilege read-only path is explicitly granted.
- Jangar control-plane status reported database `configured=true`, `connected=true`, `status=healthy`,
  `latency_ms=10`, and migration consistency `28/28` with latest migration
  `20260505_torghut_quant_pipeline_health_window_index`.
- Jangar execution trust was healthy with no blocking windows.
- Jangar watch reliability was healthy: `observed_streams=3`, `total_events=7982`, `total_errors=0`, and
  `total_restarts=3` in the 15-minute window.
- Jangar dependency quorum returned `decision=block` with reason `empirical_jobs_degraded`.
- Jangar AgentRun ingestion returned `status=unknown`, message `agents controller not started`, and no last watch
  event or resync timestamp.
- Jangar action SLO budgets allowed `serve_readonly`, `dispatch_repair`, `deploy_widen`, and `torghut_observe`.
  `dispatch_normal` was `repair_only`; `merge_ready` and `paper_canary` were held; `live_micro_canary` and
  `live_scale` were blocked.
- Torghut `/db-check` returned HTTP `200`, `schema_current=true`, `schema_graph_lineage_ready=true`, and
  `account_scope_ready=true`. Known parent-fork warnings were present, with no missing or unexpected heads.
- Torghut live `/readyz` and `/trading/health` returned HTTP `503`. Postgres, ClickHouse, Alpaca, scheduler, and
  universe checks were healthy, but live submission was blocked by `simple_submit_disabled` in `capital_stage=shadow`.
- Torghut `/trading/autonomy` showed stale empirical jobs `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`, all tied to `torghut-full-day-20260318-884bec35`.
- Torghut sim `/readyz` returned HTTP `200` in paper mode, but its quant evidence was degraded with
  `latestMetricsCount=0`, `emptyLatestStoreAlarm=true`, and no pipeline stages.
- Jangar typed quant health for live account `PA3SX7FYNUTF`, window `15m`, was routable and returned HTTP `200`, but
  `latestMetricsUpdatedAt=2026-05-05T17:28:03.839Z` and `metricsPipelineLagSeconds=70873`.
- Jangar market-context health for `AAPL` returned HTTP `200` and `overallState=degraded`; technicals, fundamentals,
  news, and regime were all stale even though fundamentals, news, and ClickHouse providers were configured.
- Jangar quant alerts returned `50` open alerts: `37` critical `metrics_pipeline_lag_seconds` alerts, `12`
  warning `ta_freshness_seconds` alerts, and `1` warning `sharpe_annualized` alert.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` composes database status, controller health, rollout health,
  watch reliability, workflow reliability, empirical services, runtime admission, failure-domain leases,
  negative-evidence routing, and execution trust into one status payload.
- `services/jangar/src/server/control-plane-negative-evidence-router.ts` already converts stale empirical jobs,
  quant alerts, market-context debt, workflow failures, and controller ingestion debt into action-level holds.
- `services/jangar/src/server/control-plane-watch-reliability.ts` proves current watch health, which is why the
  remaining block is evidence debt rather than watch instability.
- `services/jangar/src/server/agents-controller/index.ts` still returns process-local AgentRun ingestion
  `unknown` when the serving process is not the controller process.
- `services/jangar/src/server/supporting-primitives-controller.ts` remains the broadest Jangar risk surface at
  `2883` lines, covering schedule generation, runner ConfigMaps, CronJobs, swarm admission, requirements, freezes,
  workspace state, and PVC lifecycle.
- `services/torghut/app/main.py` remains the broadest Torghut route assembly surface at `4051` lines.
- `services/torghut/app/trading/submission_council.py` assembles live submission gates from dependency quorum,
  empirical jobs, DSPy runtime, quant health, market context, and toggle parity.
- `services/torghut/app/trading/scheduler/pipeline.py` is `4349` lines and owns signal continuity,
  market-context observations, rejection accounting, LLM decision context, and order preparation.
- Focused tests exist for Jangar control-plane status, watch reliability, negative evidence, failure-domain leases,
  Torghut quant metrics, market context, DB checks, and submission gates. The missing system-level test is debt
  tranche settlement across dependency quorum, action budgets, controller witnesses, Torghut live/sim readiness,
  quant freshness, and market-context freshness.

## Problem

Jangar now has enough evidence to make better decisions than a single global readiness bit, but it still lacks the
object that tells engineers which evidence debt should be retired first.

The current state has seven true facts:

1. GitOps and rollout health are green.
2. Jangar serving, database, execution trust, and watch reliability are green.
3. AgentRun ingestion is unknown from the serving process.
4. Dependency quorum blocks on stale Torghut empirical jobs.
5. Torghut live has healthy infrastructure dependencies but live capital is disabled and readiness is HTTP `503`.
6. Torghut sim is paper-ready but quant proof is empty.
7. Market context and quant alerts show stale data that can affect profitability decisions.

Those facts should produce a debt ledger. Today they produce a block plus several action budget decisions. That is
safer than a global green, but it still leaves the engineer lane guessing whether to repair AgentRun ingestion witness
publication, stale empirical jobs, quant metric materialization, market-context rehydration, or live submission
configuration first.

The architecture gap is ranked debt retirement. A material action should cite debt tranches that hold it. A repair
dispatch should cite the debt tranche it is allowed to retire. A deployer should be able to say which unblock receipt
is missing before merge, paper, live micro-canary, or live scale.

## Alternatives Considered

### Option A: Keep Dependency Quorum As The Only Gate

Pros:

- Conservative for capital and rollout widening.
- Reuses the existing `dependency_quorum.decision=block` value.
- Easy for operators to understand during a broad outage.

Cons:

- Does not rank repairs.
- Treats empirical freshness, controller ingestion, quant staleness, and market-context staleness as one block.
- Leaves repair dispatch without a closure contract.
- Encourages manual interpretation during market windows.

Decision: reject as the next architecture step. Dependency quorum remains a hard input, not the repair scheduler.

### Option B: Let The Profit Repair Auction Own All Repair Ordering

Pros:

- Profit-oriented by default.
- Builds on the accepted contradiction-settlement and repair-auction contracts.
- Good for Torghut-specific proof work.

Cons:

- Does not own Jangar controller witness debt.
- Does not map debt to non-trading action classes such as `merge_ready` or `deploy_widen`.
- Can over-rank expected profit when the real first blocker is control-plane authority.

Decision: reject as the sole layer. Profit repair remains a pricing input to the debt ledger.

### Option C: Evidence-Debt Tranches With A Material-Action Unblock Ledger

Pros:

- Names every blocking debt item with owner, expiry, affected action classes, and closure evidence.
- Keeps serving and bounded repair open while capital and rollout widening stay held.
- Gives engineer and deployer stages concrete acceptance gates.
- Lets Torghut attach profit value and hypothesis impact without owning control-plane authority.
- Reduces repeated manual triage when a healthy rollout still has stale consumer proof.

Cons:

- Adds another projection and reducer.
- Requires careful tranche lifecycle rules so old audit debt does not permanently hold new action.
- Requires Torghut to publish repair value consistently for ranking to be useful.

Decision: select Option C.

## Architecture

Jangar adds three projections.

```text
control_plane_evidence_debt_tranche
  tranche_id
  generated_at
  expires_at
  scope                         # namespace, swarm, account, strategy, symbol, dataset, rollout, PR
  debt_type                     # controller_witness_missing, empirical_jobs_stale, quant_metrics_stale,
                                # market_context_stale, live_submission_disabled, paper_settlement_missing
  source_surface                # dependency_quorum, action_slo_budget, torghut_health, quant_health,
                                # market_context_health, controller_witness
  affected_action_classes
  current_decision              # allow, repair_only, hold, block
  repair_action_allowed         # none, observe, dispatch_repair, proof_replay, empirical_refresh, controller_witness
  priority_score
  priority_components           # risk_reduction, profit_unblock_value, age, blast_radius, closure_cost
  required_closure_refs
  rollback_target
  owner_lane                    # engineer, deployer, torghut_quant, platform
```

```text
material_action_unblock_receipt
  receipt_id
  generated_at
  expires_at
  action_class
  scope
  retired_tranche_ids
  still_open_tranche_ids
  evidence_refs
  decision                      # allow, allow_with_cap, repair_only, hold, block
  max_dispatches
  max_notional
  rollback_target
```

```text
evidence_debt_repair_plan
  plan_id
  generated_at
  expires_at
  target_tranche_ids
  proposed_jobs                 # controller witness publish, empirical replay, quant materialization,
                                # market-context rehydrate, paper settlement
  expected_unblocked_actions
  expected_profit_unblock_value
  safety_cap                    # zero_notional, paper_only, micro_live, live_scale
  validation_commands
  operator_notes
```

The ledger must be derived from existing evidence producers before it changes any action. Initial implementation is
observe-only. The first action consumers are deployer and engineer dashboards, then action SLO budgets, then capital
activation.

## Action Semantics

- `serve_readonly` remains allowed while Jangar serving, database, execution trust, and watch reliability are healthy.
- `dispatch_repair` remains allowed with `max_dispatches=1` when the target repair plan cites one open tranche and
  has zero notional exposure.
- `dispatch_normal` remains `repair_only` until a controller-owned AgentRun ingestion witness replaces the serving
  process-local `unknown` value.
- `merge_ready` remains held when any global dependency-quorum tranche is open.
- `paper_canary` remains held until empirical jobs are fresh, sim quant proof is non-empty, and market-context domains
  are fresh for the selected universe.
- `live_micro_canary` and `live_scale` remain blocked until paper settlement is current, live submission is explicitly
  enabled by receipt, and max notional is non-zero in a capital activation receipt.

## Implementation Scope

Engineer stage:

1. Add a Jangar debt-tranche reducer that consumes dependency quorum, action SLO budgets, AgentRun ingestion, Torghut
   health, quant health, market-context health, and controller witness projections.
2. Add a status payload section `evidence_debt` with `open_tranches`, `top_repair_plan`, and
   `material_action_unblock_receipts`.
3. Add unit tests for the current evidence shape: healthy rollout plus empirical debt blocks merge/paper/live, while
   dispatch repair remains allowed.
4. Add a process-topology test where serving-process controller health is unknown but controller deployment and watch
   reliability are healthy; the expected outcome is controller-witness debt, not global serving failure.
5. Add Torghut fixtures for live `503`, sim paper-ready with empty quant metrics, stale empirical jobs, and stale
   market-context domains.

Torghut stage:

1. Publish profit-unblock metadata for stale empirical jobs, quant metrics, market-context domains, and capital-stage
   blockers.
2. Attach the affected action classes and expected unblock value to each debt item.
3. Keep live capital max notional at `0` until a Jangar `material_action_unblock_receipt` references fresh paper and
   live proof.

## Validation Gates

Local validation for the architecture artifact:

- `bunx oxfmt --check` on this document, the companion Torghut document, and the v6 index.
- `git diff --check origin/main...HEAD`.

Engineer acceptance:

- Unit tests prove debt tranche creation for `empirical_jobs_degraded`, `agentrun_ingestion_unknown`,
  `quant_latest_metrics_empty`, `metrics_pipeline_lag_seconds`, and market-context stale domains.
- Jangar status exposes at least one `control_plane_evidence_debt_tranche` for each current block.
- `dispatch_repair` cites the top repair plan and remains zero notional.
- `merge_ready`, `paper_canary`, `live_micro_canary`, and `live_scale` cite the open tranche ids that hold them.

Deployer acceptance:

- Argo CD remains `Synced` and `Healthy` for `agents`, `jangar`, and `torghut`.
- `deployment/jangar`, `deployment/agents`, and `deployment/agents-controllers` remain available.
- Jangar `/api/agents/control-plane/status?namespace=agents` reports healthy database, healthy execution trust, and
  no watch-reliability block before any rollout widening.
- No live capital action is allowed unless the unblock receipt has `max_notional > 0`, fresh empirical jobs, fresh
  quant proof, fresh market context, and a rollback target.

## Rollout

1. Ship the debt-tranche reducer in observe-only mode and compare it against existing action SLO decisions.
2. Publish the top repair plan in Jangar without changing scheduler behavior.
3. Let `dispatch_repair` require a target tranche id.
4. Let deployer merge and paper gates require current unblock receipts.
5. Only after two healthy market sessions, allow live micro-canary receipts to carry non-zero notional.

## Rollback

If the reducer misclassifies debt or blocks safe repair, disable debt-ledger enforcement and fall back to existing
dependency quorum plus action SLO budgets. Keep live capital at `0` while the ledger is disabled. If a deployed
receipt allows an action that later proves unsafe, reopen the tranche, expire the receipt, return `dispatch_normal` to
`repair_only`, and require a new repair plan before widening or capital.

## Risks

- The ledger can become noisy if every stale alert creates a top-level tranche. The reducer must group by blocked
  action and closure evidence.
- Profit-unblock value can be gamed if Torghut estimates are not tied to realized paper settlement. Treat value as
  ranking metadata, not authority.
- Historical Error pods can pollute current debt. Tranche generation must distinguish retained audit debt from active
  blockers.
- Process-local controller unknown values can persist until controller-owned witness publication exists. The ledger
  should make that debt visible without calling the serving path unhealthy.

## Handoff

Engineer owns the debt-tranche reducer, status payload, and tests. Deployer owns read-only validation and rollout
enforcement. Torghut owns profit-unblock metadata and closure receipts for empirical, quant, market-context, and
capital-stage debt.

Acceptance is concrete: every held or blocked material action must cite a current open tranche, every allowed repair
must cite the tranche it retires, and every capital receipt must name fresh empirical, quant, market-context, paper
settlement, and rollback evidence.
