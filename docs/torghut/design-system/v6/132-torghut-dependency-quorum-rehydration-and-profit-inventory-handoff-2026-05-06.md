# 132. Torghut Dependency Quorum Rehydration And Profit Inventory Handoff (2026-05-06)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: typed proof/readiness/repair/capital surfaces exist across API, trading, and Jangar consumer modules; contract text remains broader than runtime.
- Matched implementation area: Proof, evidence, freshness, repair, and capital gating.
- Current source evidence:
  - `services/torghut/app/api/readiness_helpers/trading_health_proof_lane.py`
  - `services/torghut/app/api/proof_floor_payloads/proof_floor_receipts.py`
  - `services/torghut/app/trading/consumer_evidence.py`
  - `services/torghut/app/trading/freshness_carry.py`
  - `services/torghut/app/trading/revenue_repair/repair_queue.py`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- Design drift note: Most May 2026 proof/capital docs are implemented as distributed surfaces, not single resources named after each document.


## Decision

I am selecting **dependency quorum rehydration with active profit inventory receipts** as the Torghut discover handoff.

The live Torghut runtime is running, but it is not capital-ready. On 2026-05-06 at about 19:16 UTC, live Torghut
revision `torghut-00242`, sim revision `torghut-sim-00341`, Postgres, ClickHouse replicas, Keeper, TA, sim TA,
options services, websocket forwarders, and guardrail exporters were running. Torghut live `/readyz` still returned
HTTP 503 degraded because live submission was disabled with `simple_submit_disabled`. Core dependencies were healthy,
database schema was current at Alembic head `0029_whitepaper_embedding_dimension_4096`, and empirical jobs were
healthy.

The capital problem is sharper than readiness. Torghut's runtime alpha readiness reported three source-defined
hypotheses, all in shadow or blocked, all rollback-required, and dependency quorum blocked on
`agents_controller_unavailable` and `workflow_runtime_unavailable`. At the same time, Jangar reported those controller
and runtime surfaces healthy. Torghut's database had current trading data, including `147623` trade decisions and
`13778` executions, but no `strategy_hypotheses`, no `simulation_runtime_context`, and no `simulation_run_progress`.
Jangar's simulation-control rows existed but were last updated on 2026-03-19. Jangar quant health was fresh, but
Torghut live reported `quant_health_not_configured`.

The selected design requires Torghut to rehydrate dependency quorum from Jangar convergence receipts and build an
active profit inventory before moving beyond observe or repair. The tradeoff is slower paper reentry, but that is the
right cost. A running live service, stale execution history, and a fresh global quant stream are not enough to spend
capital. Torghut must name the receipt, hypothesis, simulation proof, and profit inventory item behind every paper or
live decision.

## Runtime Objective And Success Metrics

This contract increases profitability by making paper/live admission depend on current, reconciled evidence rather
than route health alone.

Success means:

- Torghut no longer treats stale controller/runtime blocks as current after Jangar issues a fresh convergence receipt.
- Every paper canary candidate cites an active `profit_inventory_snapshot`.
- Every profit inventory item cites a Jangar convergence receipt and a current hypothesis source.
- Simulation proof must be newer than the current sim revision or explicitly marked stale.
- Live micro-canary remains impossible while live submission is disabled, quant health is not configured, or profit
  inventory is empty.

## Evidence Snapshot

All evidence was read-only. I did not mutate Kubernetes resources, database rows, broker state, trading flags, or
GitOps manifests.

### Cluster And Runtime Evidence

- Torghut namespace phase counts were `Running=27` and `Completed=3`.
- Live revision `torghut-00242-deployment-597bfc8488-d5swx` was `2/2 Running`.
- Sim revision `torghut-sim-00341-deployment-5ff54f8d56-9gr5m` was `2/2 Running`.
- ClickHouse replicas, Keeper, Postgres, live TA, sim TA, options TA, options catalog, options enricher, websocket
  forwarders, guardrail exporters, Alloy, and Symphony were running.
- Recent events showed sim and sim-TA rollout churn, transient readiness and startup probe failures, then a successful
  runtime-ready AnalysisRun.
- The agents service account could not list Knative services or Argo AnalysisRuns in `torghut`, so deployer validation
  must rely on allowed pod, event, route, and database evidence unless RBAC is intentionally widened later.

### Route Evidence

- Live `/readyz` returned degraded. Postgres, ClickHouse, Alpaca, database, universe, empirical jobs, DSPy runtime,
  and quant evidence were non-failing, but `live_submission_gate.ok=false` with `simple_submit_disabled`.
- Live `/trading/status` reported `enabled=true`, `mode=live`, `pipeline_mode=simple`, `capital_stage=shadow`,
  `live_submission_gate.allowed=false`, `simple_lane.submit_enabled=false`, and `quant_health_not_configured`.
- Live alpha readiness reported `hypotheses_total=3`, `state_totals={blocked:1, shadow:2}`,
  `promotion_eligible_total=0`, `rollback_required_total=3`, and dependency quorum blocked for
  `agents_controller_unavailable` and `workflow_runtime_unavailable`.
- Sim `/readyz` returned OK in paper mode with non-live submission gate and quant evidence not required.
- Jangar quant health returned OK with `latestMetricsCount=4032` and zero pipeline lag, but Torghut live did not have
  the typed Jangar quant URL configured.

### Database And Data Evidence

- Torghut read-only SQL connected as `torghut_app` to database `torghut`.
- The public schema had `69` tables and Alembic head `0029_whitepaper_embedding_dimension_4096`.
- Trading inventory counts were: `strategies=16`, `trade_decisions=147623`, `executions=13778`,
  `trade_cursor=1`, and `vnext_empirical_job_runs=20`.
- Latest trade decision time was about `2026-05-06T17:44Z`, while latest execution update was
  `2026-04-03T05:32Z`.
- `strategy_hypotheses=0`, `simulation_runtime_context=0`, and `simulation_run_progress=0`.
- Empirical jobs had `20` completed empirical rows, all promotion-authority eligible, latest updated about
  `2026-05-06T16:27Z`.
- Jangar simulation-control data was stale relative to current runtime: `simulation_runs=58`, `simulation_artifacts=754`,
  `dataset_cache=19`, and `simulation_lane_leases=4`, with latest updates on `2026-03-19`.

### Source Evidence

- `services/torghut/app/trading/submission_council.py` already loads Jangar dependency quorum, empirical jobs, typed
  quant health, active capital stage, and live submission gate payloads.
- `services/torghut/app/trading/hypotheses.py` compiles source-defined hypothesis runtime state, dependency quorum,
  rollback requirements, and capital stage totals.
- `services/torghut/app/trading/empirical_jobs.py` validates empirical proof truthfulness, freshness, lineage, and
  promotion-authority eligibility.
- `services/torghut/tests/test_submission_council.py`, `test_hypotheses.py`, `test_empirical_jobs.py`, and
  `test_trading_api.py` cover current quorum and gate behavior. They do not yet cover receipt rehydration where
  Jangar is fresh and Torghut's cached dependency quorum is stale.

## Problem

Torghut is blocked by evidence inconsistency, not by lack of raw data.

The current gaps are:

1. **Dependency quorum drift.** Torghut reports Jangar controller/runtime unavailable while Jangar reports them
   healthy.
2. **Empty durable hypothesis inventory.** Source manifests produce runtime hypotheses, but the database
   `strategy_hypotheses` table is empty.
3. **Stale simulation inventory.** Current sim pods are running, but durable simulation rows are from March 19.
4. **Unconsumed quant health.** Jangar quant metrics are fresh, but Torghut live has no typed quant health URL
   configured.
5. **Stale execution settlement.** Executions exist, but the latest execution update is from April 3, so live capital
   cannot lean on recent settlement.

## Alternatives Considered

### Option A: Resume Paper From Core Dependency Health

Pros:

- Fastest path to fresh paper decisions.
- Uses the currently running live and sim services.
- Avoids new persistence.

Cons:

- Ignores dependency quorum drift.
- Ignores empty strategy hypothesis persistence.
- Ignores stale simulation-control rows.
- Treats fresh global quant metrics as scoped capital evidence.

Decision: reject.

### Option B: Freeze All Capital Until Every Data Surface Is Perfect

Pros:

- Strong capital safety.
- Simple operational rule.
- Avoids false paper/live admission.

Cons:

- Blocks zero-notional learning and repair.
- Gives no priority order for fixing evidence debt.
- Wastes healthy runtime capacity.
- Does not solve stale dependency quorum by itself.

Decision: reject.

### Option C: Rehydrate Dependency Quorum And Profit Inventory From Receipts

Pros:

- Allows observe and repair while notional remains zero.
- Separates stale control-plane claims from current receipt-backed claims.
- Creates a direct path from source hypotheses to durable profit inventory.
- Forces quant health and simulation proof to be scoped before capital use.

Cons:

- Requires Torghut to consume a new Jangar receipt route.
- Requires careful TTL handling during rollout churn.
- Adds persistence work before paper canary widening.

Decision: select Option C.

## Architecture

Torghut builds one profit inventory snapshot per account, strategy, hypothesis, and window.

```text
profit_inventory_snapshot
  snapshot_id
  generated_at
  account_label
  strategy_id
  hypothesis_id
  window
  source_manifest_ref
  jangar_convergence_receipt_id
  dependency_quorum_decision
  quant_health_ref
  simulation_run_ref
  empirical_job_refs
  latest_trade_decision_ref
  latest_execution_ref
  capital_stage
  decision        # observe_only, repair_only, paper_allowed, live_micro_allowed, hold, block
  reason_codes
  rollback_target
```

Dependency quorum rehydration rules:

- If Jangar receipt is current and Torghut still reports stale controller/runtime unavailability, classify the block as
  `stale_dependency_quorum` and allow only observe or repair.
- If Jangar receipt is missing, expired, or contradictory, classify the block as `dependency_quorum_unproven`.
- If Jangar receipt is current and Torghut has consumed it, replace stale controller/runtime reasons with the current
  receipt decision.
- If receipt consumption fails, preserve the existing block and surface `receipt_consumer_failed`.

Capital gates:

- `shadow_observe`: allowed with running scheduler, healthy core dependencies, and zero notional.
- `repair_trade`: allowed only when the repair target is a named evidence gap and notional remains zero.
- `paper_canary`: requires current convergence receipt, durable active hypothesis inventory, fresh scoped quant health,
  current sim proof or explicit sim exemption, empirical proof, and no stale dependency quorum.
- `live_micro`: requires paper settlement, current execution/TCA evidence, live submission enabled, and deployer
  approval.
- `live_scale`: requires post-cost live micro evidence and a fresh rollback target.

## Measurable Trading Hypotheses

H-DQR-01, receipt-rehydrated paper has fewer false blocks:

- Hypothesis: replacing stale controller/runtime blocks with current Jangar receipts increases zero-notional repair
  throughput without increasing paper admission.
- Measurement: stale dependency block count, receipt age, repair decision count, paper decision count.
- Guardrail: paper and live notional remain zero while `profit_inventory_snapshot` is missing.

H-DQR-02, durable hypothesis inventory improves candidate quality:

- Hypothesis: persisting active hypothesis snapshots before paper reduces rollback-required candidates by at least 50%.
- Measurement: rollback-required total, promotion eligible total, paper candidates per session, post-cost paper return.
- Guardrail: source-only hypotheses can observe, but cannot enter paper without durable inventory.

H-DQR-03, scoped quant health reduces unproductive data carry:

- Hypothesis: requiring account/window quant health before paper keeps Jangar quant freshness useful without broad table
  scans.
- Measurement: quant route latency, latest metrics age, scoped health status, row estimate trend.
- Guardrail: global quant health alone is informational.

H-DQR-04, fresh simulation inventory predicts repair usefulness:

- Hypothesis: simulation rows newer than the active sim revision reduce failed repair loops versus stale March inventory.
- Measurement: sim proof age, failed simulation run count, repair-to-paper latency, paper gate pass rate.
- Guardrail: stale sim inventory permits repair only, not paper.

## Implementation Scope

Engineer stage:

- Add a Torghut receipt consumer for the Jangar runtime convergence route.
- Add pure reducers for dependency quorum rehydration and profit inventory snapshots.
- Persist active hypothesis inventory before any paper canary logic depends on it.
- Wire typed Jangar quant health URL consumption in shadow and expose missing configuration as a named fuse.
- Add fixtures for the current evidence: fresh Jangar receipt, stale Torghut dependency quorum, empty
  `strategy_hypotheses`, stale simulation inventory, current decisions, and stale executions.
- Do not enable broker live submission, change notional, or bypass the simple submission gate in the first PR.

Deployer stage:

- Verify Torghut live readiness, trading status, Jangar convergence receipt, Jangar quant health, and both database
  summaries after rollout.
- Keep live submission disabled until the full receipt and profit inventory set is current.
- Treat stale dependency quorum as repair debt, not as paper admission.
- Document the rollback flag and expected post-rollback route payloads.

## Validation Gates

Required checks:

- Unit tests for dependency quorum rehydration from current, stale, missing, expired, and contradictory receipts.
- API tests proving `/readyz`, `/trading/status`, and `/trading/health` expose the same receipt decision.
- Database tests proving empty `strategy_hypotheses` blocks paper even when source manifests produce shadow hypotheses.
- Quant tests proving unconfigured Jangar quant health is informational in shadow and blocking for paper/live.
- Simulation tests proving stale simulation inventory blocks paper unless an explicit deployer exemption is present.

Operational checks:

- `kubectl get pods -n torghut` shows live and sim pods running.
- Torghut live `/readyz` no longer reports stale controller/runtime blocks after receipt consumption.
- Jangar quant health is queried with account and window.
- Read-only SQL shows non-empty active hypothesis inventory before paper canary.
- Rollback disables receipt consumption and returns to current shadow/simple-gate behavior.

## Rollout Plan

1. Ship receipt consumption in shadow and emit diagnostics only.
2. Persist active profit inventory snapshots with no capital effect.
3. Require receipts for paper canary while live submission stays disabled.
4. Require fresh simulation and execution settlement before live micro-canary.
5. Allow deployer-approved live micro only after paper settlement and rollback proof are current.

## Rollback Plan

Rollback is explicit:

- Disable Torghut receipt consumption.
- Leave source-defined hypothesis compilation and current live submission gate behavior unchanged.
- Keep persisted snapshots for audit, but stop using them in admission.
- Keep live submission disabled until a new deployer proof says otherwise.

## Risks

- Rehydration can hide a real new Jangar outage if receipt TTL is too loose.
- Tight TTLs can block paper during normal rollout churn.
- Persisting hypothesis inventory without pruning can create stale candidates.
- Quant health can become another broad scan if engineers ignore account/window scope.
- Live execution evidence is stale; no live micro path should open until execution/TCA proof is current.

## Handoff Contract

Engineer acceptance:

- Torghut has a receipt consumer, rehydration reducer, and profit inventory reducer with regression tests.
- Source-only hypotheses stay shadow until durable inventory exists.
- Scoped quant health and simulation freshness are part of the same paper gate payload.

Deployer acceptance:

- A rollout report captures route status, receipt status, database inventory, and rollback switch state.
- Paper remains blocked until stale dependency quorum, empty hypothesis inventory, unconfigured quant health, and stale
  simulation inventory are closed or explicitly exempted.
- Live remains blocked until paper settlement, current execution/TCA proof, and deployer approval are present.
