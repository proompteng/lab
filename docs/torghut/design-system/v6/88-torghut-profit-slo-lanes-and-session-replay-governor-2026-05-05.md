# 88. Torghut Profit SLO Lanes and Session Replay Governor (2026-05-05)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: historical simulation, replay, Lean backtest APIs, and local replay scripts exist, but older monolithic simulation assumptions have been split.
- Matched implementation area: Simulation, replay, backtesting, and Lean.
- Current source evidence:
  - `services/torghut/scripts/run_local_simple_lane_replay.py`
  - `services/torghut/scripts/verify_historical_simulation_parity.py`
  - `services/torghut/app/api/trading_misc/lean_backtests.py`
  - `services/jangar/src/routes/api/torghut/simulation/runs.ts`
  - `argocd/applications/torghut/historical-simulation-workflowtemplate.yaml`
- Design drift note: Simulation docs must be checked against current split scripts and Jangar simulation routes.


## Decision

Torghut should add **Profit SLO Lanes** and a **Session Replay Governor** that consume Jangar material-action
settlements. Capital authority should move through measurable lanes: zero-notional replay, shadow probe, paper probe,
live canary, and scaled live. Each lane gets an explicit profitability objective, sample budget, freshness budget,
capital ceiling, and rollback trigger.

I am choosing this because the current system is alive but not profitable enough to deserve capital. Torghut is running
in live mode, schema proof is current, scheduler and dependencies are mostly usable, and the universe is fresh through
Jangar. The trading gate is still closed: live submission is disabled, capital stage is shadow, empirical jobs are
stale from 2026-03-21, the 72-hour profitability window has eight rejected decisions, zero executions, zero TCA samples,
and all three registered hypotheses are shadow or blocked with rollback required.

The right next move is not to bypass the gate. It is to spend blocked market time on replay and shadow evidence that
can actually earn a paper/live lane later. The tradeoff is slower promotion, but the current evidence does not justify
speed. It justifies a better proof machine.

## Scope and Success Metrics

Success means:

1. Torghut reads Jangar's current material-action settlement digest before granting `paper_submit` or `live_submit`.
2. Every hypothesis has a lane, profit SLO, sample target, freshness target, stop-loss trigger, and rollback trigger.
3. Stale empirical jobs open zero-notional replay work instead of ad hoc paper/live pressure.
4. Runtime decisions without executions are treated as proof debt, not profitability evidence.
5. Paper promotion requires fresh empirical jobs, non-empty shadow decisions, route proof, and hypothesis-specific
   post-cost expectancy gates.
6. Live canary requires paper samples, TCA coverage, slippage bounds, rollback dry-runs, and a Jangar settlement that
   allows the active capital stage.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster and Route Evidence

- Torghut live pod `torghut-00219-deployment-5496d7f7dc-qmzhl` and sim pod
  `torghut-sim-00300-deployment-7fc94bffc9-hlf5k` were `2/2 Running`.
- Torghut events showed recent revisions becoming ready, but also startup probe failures, readiness probe timeouts,
  scheduling pressure for backfills, Flink checkpoint exceptions, and repeated ClickHouse multiple-PDB warnings.
- `/db-check` returned `ok=true`, `schema_current=true`, current head `0029_whitepaper_embedding_dimension_4096`,
  and lineage ready, with historical migration parent-fork warnings.
- `/trading/health` returned degraded because `live_submission_gate.ok=false` and `simple_submit_disabled`, while
  scheduler, Postgres, ClickHouse, Alpaca, universe, empirical job route health, DSPy route status, and optional quant
  evidence were usable.
- `/trading/status` reported `mode=live`, `execution_lane=simple`, `capital_stage=shadow`, `promotion_eligible_total=0`,
  `rollback_required_total=3`, and dependency quorum blocked by stale empirical jobs.
- `/trading/empirical-jobs` reported four stale but truthful empirical jobs:
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.
- `/trading/profitability/runtime?hours=72` reported eight decisions, zero executions, zero TCA samples, zero realized
  PnL proxy, and no promotion target.

### Source and Data Evidence

- Jangar already parses Torghut runtime profitability and control-plane summaries in
  `services/jangar/src/server/torghut-trading.ts` and tests the parsing in
  `services/jangar/src/server/__tests__/torghut-trading-summary.test.ts`.
- Jangar dependency quorum blocks on stale empirical jobs in `services/jangar/src/server/control-plane-workflows.ts`.
  That is the correct capital-safety input; Torghut needs to consume it as a settlement digest.
- Torghut scheduler governance already has promotion, drift, and actuation plumbing in
  `services/torghut/app/trading/scheduler/governance.py`, but current runtime status shows autonomy disabled and
  live submission blocked.
- Historical TCA on `/trading/status` reports 13,775 orders with average absolute slippage around 568 bps. That is not
  a green light. It is a reason to demand small paper samples and strict slippage gates before any live canary.

## Problem

Torghut has many useful controls, but the profitable path is still too indirect. A blocked gate can sit idle while the
market session moves on. A schema-current service can still have no fresh empirical proof. A live-mode process can
still produce only rejected decisions. A historical TCA table can look deep while the current 72-hour window has no
executions.

The result is opportunity cost without a measurable repair program. The system needs to turn blocked capital into
session replay and shadow evidence, then promote only hypotheses that meet explicit post-cost objectives.

## Alternatives Considered

### Option A: Promote Paper Immediately Once Schema and Runtime Are Healthy

Use Torghut's healthy schema, running pods, fresh universe, and disabled live gate as enough proof to begin paper
trading.

Pros:

- quickly generates fresh execution and TCA data;
- exercises live routing without real capital;
- reduces idle time.

Cons:

- ignores stale empirical jobs;
- ignores Jangar dependency quorum block;
- gives paper authority without fresh hypothesis evidence;
- can create noisy TCA samples from an unproven lane.

Decision: reject. Paper is cheap, but it is not free if it pollutes evidence.

### Option B: Backtest-Only Until All Empirical Jobs Are Fresh

Hold all market-session activity until the empirical job set is fresh and all gates are green.

Pros:

- clean statistical posture;
- protects capital;
- simple to audit.

Cons:

- wastes live market-session signal windows;
- does not validate route latency, data availability, or scheduler behavior;
- delays TCA and rejection attribution;
- creates pressure to bypass when evidence remains stale.

Decision: reject as default. Backtest refresh is required, but market-session replay should continue at zero notional.

### Option C: Profit SLO Lanes and Session Replay Governor

Create bounded lanes that consume Jangar settlement authority and advance only when measurable proof is fresh.

Pros:

- keeps capital safe while using market time productively;
- gives each hypothesis a measurable promotion contract;
- separates replay evidence from paper/live authority;
- makes stale empirical jobs generate repair work;
- binds Torghut capital to the same Jangar settlement digest deployers use.

Cons:

- requires more route and ledger plumbing;
- promotion will be slower until fresh samples accumulate;
- needs careful distinction between observational replay and executable profitability.

Decision: select Option C.

## Chosen Architecture

### Profit SLO Lane

Each hypothesis moves through one lane at a time:

```text
profit_slo_lane
  lane_id
  hypothesis_id
  strategy_family
  capital_stage              # zero_notional_replay, shadow_probe, paper_probe, live_canary, scaled_live
  jangar_settlement_digest
  dataset_snapshot_ref
  session_window
  min_sample_count
  max_evidence_age_seconds
  min_post_cost_expectancy_bps
  max_avg_abs_slippage_bps
  max_drawdown_bps
  max_rejection_rate
  tca_required
  rollback_trigger_ref
  decision                   # allow_replay, allow_shadow, allow_paper, allow_live_canary, hold, block
```

Lane authority is capped by Jangar settlement. If Jangar says `paper_submit=hold`, Torghut can still replay and shadow,
but cannot paper-submit.

### Initial Hypothesis Contracts

The current registry has three hypotheses. Initial contracts should match existing route evidence:

- `H-CONT-01`, continuation:
  - start in `zero_notional_replay` while empirical jobs are stale;
  - require at least 40 paper samples before live canary;
  - require post-cost expectancy at or above 6 bps;
  - require average absolute slippage at or below 12 bps;
  - block on signal lag or Jangar dependency quorum.
- `H-MICRO-01`, microstructure breakout:
  - remain blocked until feature coverage and drift governance are present;
  - require at least 60 paper samples before live canary and 120 before scale-up;
  - require post-cost expectancy at or above 10 bps;
  - require average absolute slippage at or below 8 bps.
- `H-REV-01`, event reversion:
  - start in `zero_notional_replay` and require market-context freshness inside 120 seconds;
  - require at least 30 paper samples before live canary;
  - require post-cost expectancy at or above 8 bps;
  - require average absolute slippage at or below 12 bps.

These are not profit guarantees. They are admission standards for spending more capital.

### Session Replay Governor

The governor runs while paper/live authority is held:

- Ingest current market-session signals, decisions, rejection reasons, universe source, and route freshness.
- Recompute each hypothesis as a zero-notional replay with deterministic fills and recorded assumptions.
- Write a replay evidence record with dataset snapshot, code digest, Jangar settlement digest, and reason codes.
- Trigger empirical job refresh when replay evidence is blocked by stale job age.
- Promote to shadow probe only when replay evidence is fresh and non-empty.
- Promote to paper only when Jangar settlement permits `paper_submit` and all hypothesis gates pass.

### Capital Guardrails

Paper and live stages must enforce:

- kill switch not active;
- live submission gate allowed for live stages;
- Jangar settlement digest current and action class allowed;
- fresh empirical jobs for the same candidate and dataset window;
- TCA coverage present for paper-to-live;
- route-level database proof current;
- rollback dry-runs complete before live canary;
- capital multiplier zero unless the lane is `paper_probe`, `live_canary`, or `scaled_live`.

## Implementation Scope

Phase 0, route and ledger shape:

- Add a Torghut route projection for profit SLO lanes and the active Jangar settlement digest.
- Persist lane decisions as evidence records, not mutable dashboard state.
- Keep capital authority unchanged while the route runs in observe mode.

Phase 1, replay governor:

- Run zero-notional replay during market sessions when empirical jobs or Jangar settlement block capital.
- Emit replay artifacts with hypothesis id, dataset snapshot, route freshness, rejection attribution, and expected
  post-cost metrics.
- Trigger empirical refresh requests for stale job blockers.

Phase 2, shadow and paper:

- Allow shadow probes for hypotheses with fresh replay evidence and no fatal data-quality blockers.
- Allow paper probes only when Jangar settlement permits `paper_submit` and empirical jobs are fresh.
- Add test coverage for stale empirical jobs, zero executions, stale market context, missing TCA, and settlement hold.

Phase 3, live canary:

- Require paper sample counts, TCA coverage, slippage SLO, rollback dry-runs, and explicit live authority.
- Start live canary with the smallest capital multiplier and automatic rollback on any guardrail breach.

## Validation Gates

Engineer acceptance:

- Unit tests prove stale empirical jobs produce `zero_notional_replay` and block paper/live.
- Unit tests prove `H-CONT-01`, `H-MICRO-01`, and `H-REV-01` apply their own sample, expectancy, slippage, and data
  freshness gates.
- Route tests prove the active Jangar settlement digest is required for paper/live authority.
- Replay tests prove decisions without executions are not counted as realized profitability.

Deployer acceptance:

- `/trading/status` exposes active lane decisions, settlement digest, and blocked reasons.
- `/trading/profitability/runtime?hours=72` still reports zero executions as no realized proof until paper/live samples
  exist.
- `/trading/empirical-jobs` is fresh before any paper authority is granted.
- A live canary cannot start unless rollback dry-runs and kill-switch checks are current.

## Rollout and Rollback

Rollout:

1. Ship lane route projection in observe mode.
2. Run zero-notional replay during at least five market sessions.
3. Refresh empirical jobs and require fresh artifacts before paper probes.
4. Enable paper probes per hypothesis, one at a time.
5. Enable live canary only after paper evidence clears all gates.

Rollback:

- Set all lanes back to `zero_notional_replay`.
- Disable paper/live submission through existing trading toggles.
- Revoke the current Jangar settlement digest for `paper_submit` or `live_submit`.
- Preserve replay and TCA artifacts for audit; do not delete evidence.
- If lane logic misclassifies proof, revert the route/consumer PR and fall back to the existing live submission gate.

## Risks

- Replay can overfit if it is treated as paper evidence. The governor must mark replay as zero-notional and require
  separate paper samples.
- Slippage gates may be too strict for sparse early samples. Use minimum sample counts and confidence bands before
  promotion.
- A fresh Jangar settlement can prove platform readiness but not strategy profitability. Torghut must keep its own
  post-cost gates.
- Historical TCA is useful for guardrails but not enough for current promotion. Current-window samples must drive
  capital movement.
- Market-session replay adds load. It should run under explicit budget and stop when route freshness or data quality is
  below the lane threshold.

## Handoff to Engineer and Deployer

Engineer stage should implement the observe-mode lane route, the replay governor's evidence record, and tests for the
three current hypotheses before any paper/live behavior changes.

Deployer stage should validate five market-session replay windows, fresh empirical jobs, matching Jangar settlement
digests, and zero false paper/live allowances before enabling paper probes.
