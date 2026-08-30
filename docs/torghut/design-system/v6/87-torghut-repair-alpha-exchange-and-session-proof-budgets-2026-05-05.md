# 87. Torghut Repair Alpha Exchange and Session Proof Budgets (2026-05-05)

Status: Approved for implementation (`discover`)

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: strategy/alpha/discovery/profile modules and tests exist, but research strategy proposals are not all promoted runtime strategies.
- Matched implementation area: Strategy, alpha, TSMOM, regime, portfolio, and sizing.
- Current source evidence:
  - `services/torghut/app/strategies/catalog.py`
  - `services/torghut/app/trading/alpha/tsmom.py`
  - `services/torghut/app/trading/strategy_runtime`
  - `services/torghut/app/trading/discovery/candidate_specs.py`
  - `services/torghut/app/trading/portfolio`
- Design drift note: A research/stress module is not enough to call a strategy live; promotion still depends on proof/readiness gates.


## Decision

Torghut should add a **Repair Alpha Exchange** and **Session Proof Budgets** above the profit-debt ledger. Profit debt
correctly says why capital is held. The next profitable move is to rank repair experiments by expected information
value and by the probability that they close a capital-blocking proof gap before the next market-session opportunity
expires.

I am choosing this because the current evidence says "learn, but do not widen." On 2026-05-05, Torghut was serving and
schema-current, but not capital-ready:

- `/healthz` returned HTTP 200.
- `/db-check` returned HTTP 200 with `schema_current=true`, current head `0029_whitepaper_embedding_dimension_4096`,
  and `schema_graph_lineage_ready=true`.
- `/readyz` and `/trading/health` returned HTTP 503 because `live_submission_gate.ok=false` and
  `simple_submit_disabled`.
- `/trading/status` reported `mode=live`, `execution_lane=simple`, `capital_stage=shadow`, three hypotheses, zero
  promotion-eligible hypotheses, and three rollback-required hypotheses.
- Signal continuity was alerting on `cursor_tail_stable`.
- `/trading/empirical-jobs` reported `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward` as truthful but stale from 2026-03-21.
- `/trading/profitability/runtime` reported an observational 72-hour window with eight decisions, zero executions, and
  zero TCA samples.
- `/trading/tca` reported 13775 historical order samples, but `last_computed_at=2026-04-02T20:59:45.136640Z` and
  average absolute slippage around 568.6 bps.
- Jangar quant-health timed out from this runner, and direct database SQL was blocked by `pods/exec` RBAC.

The correct posture is not to bypass capital holds. The correct posture is to spend session proof budget on the repair
that is most likely to unlock a narrow, measurable hypothesis lane or falsify it quickly.

## Scope and Success Metrics

This contract defines the Torghut-side profitability consumer of Jangar repair warrants. It does not authorize broker
orders. Broker admission still needs fresh profit evidence leases, order warrants, and platform clearance.

Success means:

1. every high-severity profit debt can be converted into one or more `RepairAlphaBid` records;
2. bids are ranked by expected information value, capital-unlock probability, downside risk, and session urgency;
3. selected bids receive a zero-notional `SessionProofBudget` unless a later paper/live warrant explicitly allows
   capital;
4. stale empirical proof, missing quant health, signal-continuity alerts, feature gaps, drift gaps, stale TCA, and
   Jangar platform holds have different repair classes and different acceptance gates;
5. every repair output either closes debt with proof, reduces debt severity, or falsifies a hypothesis;
6. status, health, scheduler snapshots, Jangar projections, and broker admission read the same repair digest.

## Evidence Snapshot

All cluster and database checks were read-only.

### Cluster and Rollout Evidence

Torghut was available but operationally noisy:

- `kubectl get pods -n torghut -o wide` showed Torghut live revision `torghut-00217`, simulation revision
  `torghut-sim-00298`, Postgres, ClickHouse, Keeper, websocket forwarders, options services, TA jobs, exporters,
  Symphony, and Alloy running.
- Recent events showed Torghut revision creation, startup and readiness probe failures during rollout, migration and
  backfill jobs completing, and scheduling pressure for backfills.
- Flink events showed checkpoint/fetcher exceptions followed by restarts for `torghut-ta` and `torghut-options-ta`.
- ClickHouse pods matched multiple PodDisruptionBudgets in events.

Interpretation: the platform can run shadow learning and proof repair, but rollout churn and data-plane noise should
remain part of capital proof.

### Runtime API Evidence

Application evidence was consistent with shadow-only capital:

- `/trading/status` returned HTTP 200 and showed the scheduler running, last run and reconcile timestamps fresh, and
  critical toggles aligned.
- The live submission gate was closed with `reason=simple_submit_disabled` and `capital_stage=shadow`.
- Hypotheses were `H-CONT-01` shadow, `H-MICRO-01` blocked, and `H-REV-01` shadow; all had
  `capital_multiplier=0`, `promotion_eligible=false`, and `rollback_required=true`.
- `H-CONT-01` was blocked by Jangar dependency and signal continuity. `H-MICRO-01` was additionally blocked by
  feature and drift gaps. `H-REV-01` was additionally blocked by market-context freshness.
- Runtime profitability had decisions for AAPL, AMD, INTC, and NVDA, all rejected, with no executions or current TCA
  samples in the 72-hour window.

Interpretation: there is enough route evidence to rank repair, and not enough execution evidence to widen capital.

### Database and Data Evidence

Direct SQL was unavailable because the runner cannot create `pods/exec` in the Torghut namespace. The application data
surfaces still gave a clear data-quality picture:

- schema proof is current;
- empirical promotion jobs are stale by more than a month;
- historical TCA is stale by more than a month and too noisy for current promotion thresholds;
- recent runtime decisions have no fill evidence;
- quant evidence is not configured locally and the Jangar quant-health route timed out from this runner;
- evidence-continuity automation is disabled with a one-day interval and no current report.

Interpretation: the data layer is not absent. It is divided between current schema proof, stale historical evidence,
and missing current execution proof. The repair exchange must keep those categories separate.

## Problem

The profit-debt ledger gives Torghut a good safety posture. It records why capital stays in shadow. It does not yet
answer how to spend the next hour of market time.

During a held session, several repairs can compete:

1. refresh empirical jobs for `intraday_tsmom_v1@prod`;
2. wire or repair Jangar quant-health;
3. replay rejected decisions from the current 72-hour runtime window;
4. repair signal continuity for `cursor_tail_stable`;
5. restore feature and drift proof for microstructure hypotheses;
6. refresh market context for event reversion;
7. wait for platform clearance from Jangar.

Treating those as equal wastes opportunity. Torghut needs an exchange that makes repair work compete on measurable
learning value while keeping all broker-bound notional at zero until proof is fresh.

## Options Considered

### Option A: Repair Global Blockers First

Refresh empirical jobs, quant health, TCA, signal continuity, feature rows, drift checks, and market context in a fixed
global order.

Pros:

- simple ordering;
- easy to explain to operators;
- likely to reduce broad red status.

Cons:

- ignores hypothesis-specific unlock value;
- may spend time on blockers irrelevant to the best current lane;
- does not compare repair cost against expected learning;
- can delay narrow paper canary readiness when one lane is nearly ready.

Decision: reject as the primary architecture. It is a safe fallback when scoring is unavailable.

### Option B: Re-Enable Paper Submission to Gather Samples

Use the healthy service and schema routes to re-enable paper submissions and collect fresh execution and TCA samples.

Pros:

- collects real broker and fill data quickly;
- may expose execution regressions faster than replay;
- reduces zero-execution blind spots.

Cons:

- treats liveness as proof;
- ignores stale empirical jobs and timed-out platform proof;
- can create paper samples under a stale or blocked hypothesis;
- makes rejected-decision replay harder to compare with post-reenable behavior.

Decision: reject for the current state. Paper reentry needs proof budget closure first.

### Option C: Repair Alpha Exchange With Session Proof Budgets

Convert profit debt into repair bids. Rank bids by expected information value, unlock probability, downside risk, and
session urgency. Issue zero-notional proof budgets for selected repairs, then close or falsify debt from the outputs.

Pros:

- turns blocked capital into ranked learning;
- keeps safety and profitability aligned;
- lets each hypothesis compete on its own blockers;
- uses Jangar closure warrants without waiting for broad platform green;
- creates audit evidence for why one repair ran before another.

Cons:

- requires scoring, route parity, and scheduler work;
- expected information value is approximate at first;
- needs strict zero-notional enforcement until broker warrants exist.

Decision: select Option C.

## Chosen Architecture

### RepairAlphaBid

Torghut should materialize bids from profit debt, Jangar external-capital clearance cells, runtime status, and data
quality surfaces:

```text
repair_alpha_bid
  bid_id
  debt_id
  account
  session_window
  hypothesis_id
  strategy_family
  repair_class               # empirical_refresh, quant_health_repair, replay, signal_repair, feature_drift_repair
  blocker_codes
  expected_output_refs
  expected_information_value
  expected_capital_unlock_probability
  expected_edge_bps_if_closed
  downside_risk_score
  session_urgency_score
  required_jangar_warrant_id
  max_runtime_minutes
  max_compute_budget
  max_notional               # zero unless a separate broker warrant permits paper/live
  priority_score
  expires_at
```

Early scoring should be ordinal. The implementation should rank "global proof refresh that blocks all hypotheses"
above speculative experiments, but it should never let a score bypass capital warrants.

### SessionProofBudget

Selected bids receive a budget:

```text
session_proof_budget
  budget_id
  bid_id
  account
  session_window
  hypothesis_id
  allowed_repair_class
  max_runtime_minutes
  max_compute_budget
  max_notional
  allowed_artifact_roots
  success_condition
  falsification_condition
  stop_condition
  issued_at
  expires_at
  state                     # issued, running, proven, falsified, expired, revoked
```

The default `max_notional` is zero. A proof budget can run replay, empirical refresh, route repair, feature diagnostics,
or drift checks. It cannot submit broker orders unless a later paper/live warrant explicitly permits it.

### Hypothesis-Specific Repair Classes

Initial repair mapping:

- `H-CONT-01`: prioritize empirical refresh, signal-continuity repair, and rejected-decision replay for AAPL, AMD,
  INTC, and NVDA. Paper canary remains blocked until fresh empirical proof and runtime or paper execution evidence
  exist.
- `H-MICRO-01`: prioritize feature and drift proof only after global empirical and platform proof are no longer
  blocking. It should not receive canary budget while microstructure rows are absent.
- `H-REV-01`: prioritize market-context freshness and quant-health repair after global empirical proof, because its
  edge depends on timely context.

### Closure Rules

A repair budget can close debt only when it produces the expected proof:

- empirical refresh closes `empirical_jobs_stale` only for the matching candidate, dataset window, and job types;
- quant-health repair closes `quant_health_missing` or `quant_health_timeout` only when the typed Jangar route returns
  fresh proof inside the expected window;
- replay closes `no_runtime_execution_samples` only as `counterfactual_only`, never as paper/live authority;
- signal repair closes `signal_continuity_alert_active` only after the alert clears for the configured recovery
  streak;
- feature and drift repair closes microstructure blockers only for the required feature set and strategy family;
- Jangar platform holds close only from matching Jangar proof closure warrants.

## Implementation Scope

Engineer-stage implementation should land in bounded slices:

1. Add pure builders for `RepairAlphaBid`, `SessionProofBudget`, and repair digest computation from existing status
   and debt inputs.
2. Expose open bid count, selected budget count, top blockers, and digest on `/trading/status` and `/trading/health`
   without changing broker admission.
3. Add scheduler snapshot fields for selected zero-notional proof budgets.
4. Add causal replay budget fixtures for rejected decisions in the current runtime-profitability window.
5. Add Jangar external-capital warrant fixtures and route parity tests.
6. Add broker-admission tests proving no repair budget can authorize paper or live orders without a fresh order
   warrant and profit evidence lease.
7. Add deployed read-only validation that the May 5 state ranks stale empirical jobs, quant-health repair, and
   signal-continuity repair ahead of paper/live capital.

## Validation Gates

Required local validation for implementation PRs:

- `uv run --frozen pytest services/torghut/tests/test_trading_api.py -k "live_submission_gate or empirical_jobs"`
- `uv run --frozen pytest services/torghut/tests/test_submission_council.py`
- `uv run --frozen pytest services/torghut/tests/test_trading_scheduler_safety.py`
- `uv run --frozen pytest services/torghut/tests/test_empirical_jobs.py`
- all three Torghut Pyright profiles when runtime code changes touch `services/torghut`

Required deployed validation:

- `/trading/status`, `/trading/health`, scheduler snapshots, and broker admission expose the same repair digest.
- The current May 5 state produces zero-notional repair budgets and `capital_stage=shadow`.
- A selected empirical refresh cannot open paper/live capital by itself.
- A selected replay budget produces counterfactual proof only.
- Closing one hypothesis blocker does not clear unrelated Jangar platform holds or unrelated hypothesis debt.

## Rollout Plan

1. **Shadow exchange:** emit repair bids and session proof budgets with no scheduler behavior change.
2. **Route parity:** expose the same repair digest through status, health, readyz dependency detail, scheduler
   snapshots, and Jangar projections.
3. **Repair scheduling:** allow zero-notional proof budgets to launch bounded empirical refresh, replay, route repair,
   feature, and drift jobs.
4. **Debt closure:** close or falsify debts only from matching proof outputs.
5. **Capital integration:** require no high-severity open debt and no missing platform closure before paper/live order
   warrants.

## Rollback Plan

Rollback preserves learning:

- disable repair-budget scheduling before disabling bid emission;
- keep status and health projections visible;
- keep historical bids, budgets, and closure/falsification records;
- return broker admission to the prior profit evidence lease and order warrant policy;
- publish a rollback note listing any high-severity debt ignored by the rollback.

## Risks and Tradeoffs

The main risk is false precision. Early information-value scores should be ordinal and conservative. A stale empirical
refresh that blocks all hypotheses should outrank a speculative microstructure experiment, but no score is a capital
permission.

The second risk is session overfitting. Repair budgets must distinguish replay proof from executable paper or live
proof. Replay can rank hypotheses and estimate opportunity cost; it cannot authorize broker orders.

The tradeoff is slower paper/live reentry. I accept that because current evidence shows zero recent executions and stale
TCA. Reentry should be earned by proof closure, not by impatience with shadow mode.

## Handoff Contract

Engineer acceptance gates:

- implement shadow repair alpha bids and session proof budgets from current status, debt, and Jangar warrant inputs;
- add route parity tests for status, health, scheduler snapshots, and broker admission;
- add fixtures for stale empirical jobs, quant-health timeout, signal-continuity alert, feature gap, drift gap, stale
  TCA, and Jangar platform hold;
- prove all selected budgets default to zero notional.

Deployer acceptance gates:

- do not promote paper/live capital while high-severity debt is open or repair budgets are only counterfactual;
- capture repair digest, top bids, selected budgets, and closure state in release handoffs;
- verify enforcement can be disabled without hiding repair bids or historical budget outcomes.

Jangar handoff:

- publish external-capital repair warrants and closure proofs with stable digests;
- keep least-privilege route proof available for Torghut repair scoring;
- treat Torghut debt closure as economic proof, not platform clearance by itself.
