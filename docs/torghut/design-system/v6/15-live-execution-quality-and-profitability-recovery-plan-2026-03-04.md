# 15. Live Execution Quality and Profitability Recovery Plan (2026-03-04)

## Status

- Date: `2026-03-04`
- Maturity: `implementation plan + design`
- Scope: `torghut live decision/execution path`
- Owners: `torghut`, `jangar`, `observability`
- Primary objective: restore clean execution and reach sustained profitable sessions with controlled risk.

## Executive Summary

On **2026-03-03 (America/New_York)**, Torghut was runtime-healthy but trading-outcome unhealthy:

- `trade_decisions`: `582 rejected`, `0 accepted/submitted/filled`.
- Top normalized reject reasons:
  - `llm_error`: `255`
  - `symbol_capacity_exhausted`: `169`
  - `shorts_not_allowed`: `160` (mostly pre-fix window)
  - `qty_below_min`: `158`
- In post-rollout window (`2026-03-03T20:03:00Z` onward), rejects were dominated by:
  - `qty_below_min`
  - `llm_error`
- `llm_decision_reviews` evidence for all `llm_error` rows:
  - `rationale=llm_dspy_live_runtime_gate_blocked`
  - risk flags include `dspy_bootstrap_artifact_forbidden`

This plan addresses all active rejection classes and introduces rollout gates to target:

- `>= 75%` of trading sessions with clean execution and positive net PnL.

Important: profitability cannot be guaranteed for every day; this is a promotion SLO on rolling windows, not a promise of deterministic profit.

## Target Definitions (Hard Contracts)

### Session-level pass/fail

A session is counted as **Clean+Profitable** only if all are true:

1. `filled_executions >= 1`
2. `rejected / total_decisions <= 0.25`
3. Reject-share caps:
   - `llm_error <= 0.02` of total decisions
   - `qty_below_min <= 0.03` of total decisions
   - `shorts_not_allowed == 0` when shorts are enabled
4. `net_realized_pnl_after_costs > 0`

### Program-level SLO

- Rolling 20-session SLO: `>= 15 / 20` sessions (75%) must be Clean+Profitable.
- Breach policy:
  - If SLO drops below `12 / 20`, auto-demote to safe mode and open incident.

## Non-goals

- Not redesigning alpha model families in this document.
- Not relaxing deterministic risk controls to increase fill counts.
- Not widening broker exposure limits solely to suppress rejects.

## Root Cause Groups

## A. LLM Runtime Gate Failures -> `llm_error`

Evidence:

- All 2026-03-03 `llm_error` cases map to DSPy runtime gate block (`dspy_bootstrap_artifact_forbidden`).

Impact:

- Hard-veto behavior converts valid strategy intents into rejects.

## B. Sizing Executability Mismatch -> `qty_below_min`

Evidence:

- For `qty_below_min`, allocator often approves non-trivial notional but final sized quantity becomes `0`.
- Current behavior overuses generic `qty_below_min` instead of constraint-specific reasons.

Impact:

- Reject taxonomy is noisy and masks true capacity/inventory constraints.
- Clean execution ratio remains low even with healthy runtime.

## C. Historical Shorts Gating Regression Risk

Evidence:

- Earlier window contained `shorts_not_allowed;symbol_capacity_exhausted`.
- Post-fix window removed this, but regression guard is still required.

Impact:

- Any configuration drift can recreate deterministic rejects.

## D. Market-context freshness degraded for active symbols

Evidence:

- `market-context/health` reports `overallState=degraded` with stale domains for major symbols.

Impact:

- Weak context quality can reduce strategy confidence and increase safety rejects or low-quality entries.

## Solution Design

## Workstream 1: LLM Availability and Runtime Gate Control

### 1.1 Introduce explicit LLM availability state machine

Add runtime states:

- `ready`
- `degraded_bootstrap_blocked`
- `degraded_model_unreachable`
- `disabled_policy`

When not `ready`, persist structured reason in decision params and metrics labels.

### 1.2 Split fail behavior from observability reason

Current behavior collapses all runtime gate failures into `llm_error` veto.
New behavior:

- Keep strict safety by default.
- Add controlled fallback mode:
  - `llm_fail_mode=veto` for promotion stages requiring LLM.
  - `llm_fail_mode=pass_through_reduced_size` for approved resilience stages (with lower risk budget).

### 1.3 Pre-open bootstrap/warmup contract

Before market open:

1. Validate DSPy artifacts and model policy signatures.
2. Run synthetic no-trade review probe.
3. Publish readiness flag (`torghut_llm_runtime_ready`).
4. Block open-session promotion if probe fails.

### 1.4 Required code paths

- `services/torghut/app/trading/scheduler.py`
- `services/torghut/app/trading/autonomy/gates.py`
- `services/torghut/app/config.py`
- `services/torghut/app/models/entities.py` (if extra persistence columns are needed)

## Workstream 2: Executable Sizing and Rejection Taxonomy Correctness

### 2.1 Replace generic qty rejection with constraint-first classification

In sizing finalization:

1. Compute executable minimum quantity using:
   - asset quantity step
   - fractional setting
   - min notional and lot constraints
2. Evaluate limiting constraints in precedence order:
   - sell inventory
   - per-symbol capacity
   - gross exposure
   - net exposure
3. If executable quantity is `0`, emit constraint-specific reason first:
   - `symbol_capacity_exhausted`
   - `sell_inventory_unavailable`
   - `gross_exposure_capacity_exhausted`
   - `net_exposure_capacity_exhausted`
4. Emit `qty_below_min` only when no hard cap is binding and lot/notional rules alone prevent execution.

### 2.2 Add sizing debug payload for auditability

Persist in `decision_json.params.portfolio_sizing.output`:

- `limiting_constraint`
- `remaining_room_notional`
- `min_executable_notional`
- `min_executable_qty`
- `fractional_allowed`

### 2.3 Required code paths

- `services/torghut/app/trading/portfolio.py`
- `services/torghut/app/trading/execution_policy.py`
- `services/torghut/tests/test_portfolio_sizing.py`

## Workstream 3: Shorts Safety and Configuration Drift Guard

### 3.1 Startup invariants

On scheduler boot:

- assert live configuration for shorts policy is explicit and logged.
- emit gauge `torghut_trading_shorts_enabled`.

### 3.2 Reject regression tests

Add test matrix:

- `shorts enabled + shortable asset` -> not rejected by local shorts policy.
- `shorts enabled + non-shortable asset` -> explicit local precheck reason.
- `shorts disabled` -> deterministic `shorts_not_allowed`.

### 3.3 Required code paths

- `services/torghut/app/trading/execution.py`
- `services/torghut/app/trading/risk.py`
- `services/torghut/tests/test_order_idempotency.py`

## Workstream 4: Jangar Summary Normalization and Operator Truth

### 4.1 Normalize compound reasons everywhere

Apply semicolon splitting at API summary layer and SQL rollups so operators always see atomic reasons.

### 4.2 Add daily rejection quality view

Create endpoint/report fields:

- top reasons (atomic)
- post-open vs pre-open split
- per-account split
- rolling 5-day trend

### 4.3 Required code paths

- `services/jangar/src/server/torghut-trading.ts`
- `services/jangar/src/server/__tests__/torghut-trading-summary.test.ts`

## Workstream 5: Profitability and Execution Promotion Gates

## Stage gates

1. `Gate A (stability)`: runtime healthy + no `llm_error` spikes.
2. `Gate B (execution quality)`: reject ratio under threshold for 3 consecutive sessions.
3. `Gate C (profitability)`: 15/20 rolling sessions Clean+Profitable.
4. `Gate D (scale-up)`: capital ramp only if drawdown and tail-loss checks pass.

## Capital ramp policy

- Start at reduced notional multiplier (`0.25x`), then `0.5x`, then `1.0x`.
- Promotion blocked if either:
  - `llm_error_ratio > 0.02`
  - `qty_below_min_ratio > 0.03`
  - daily realized PnL negative for 3 consecutive sessions

## Rollout Plan (End-to-End)

## Phase 0: Immediate controls (same day)

1. Confirm live config and revision:
   - shorts enabled
   - LLM runtime mode/flags explicit
2. Add temporary dashboards for:
   - `llm_decision_reviews.rationale`
   - normalized rejection reasons

Exit criteria:

- Observability complete, no unknown runtime modes.

## Phase 1: LLM gate remediation (Day 1)

1. Implement state machine + pre-open warmup.
2. Add resilience fallback mode (feature-flagged).
3. Add unit/integration tests.

Exit criteria:

- `llm_error` reject count reduced by >=80% in next session.

## Phase 2: Sizing taxonomy fix (Day 1-2)

1. Implement constraint-first reason classification.
2. Add debug payload fields.
3. Add regression tests for known March 3 patterns.

Exit criteria:

- `qty_below_min` reduced by >=60%, with replaced explicit capacity reasons where applicable.

## Phase 3: Controlled live canary (Day 2-5)

1. Enable patched logic on one account lane.
2. Track session scorecard for 5 sessions.
3. If pass, expand to full lane.

Exit criteria:

- 4/5 sessions meet Clean+Profitable.

## Phase 4: SLO lock-in (Day 5+)

1. Track rolling 20 sessions.
2. Promote only after `>=15/20` Clean+Profitable.
3. Keep automatic demotion on breach.

## Test and Validation Matrix

## Unit tests

- LLM runtime gate blocked -> correct fallback and reason persistence.
- Sizing with residual cap below lot size -> specific capacity reason, not generic qty.
- Shorts precheck matrix across tradable/shortable/borrow states.

## Integration tests

- End-to-end decision pipeline with mocked LLM unavailable state.
- End-to-end sizing with representative symbol prices and caps.
- Jangar summary reason normalization.

## Production checks (daily)

SQL/metrics checks must include:

- rejection reasons (atomic split)
- `llm_decision_reviews` verdict and rationale
- filled execution count
- realized PnL after cost
- per-account status split

## Risks and Mitigations

1. Risk: relaxing LLM veto can increase bad trades.
   - Mitigation: reduced-size fallback mode, explicit stage gating, fast rollback.
2. Risk: reclassification hides true risk.
   - Mitigation: persist detailed sizing debug fields and audit reports.
3. Risk: apparent profit from low sample size.
   - Mitigation: rolling-window SLO and minimum session count before promotion.

## Rollback Strategy

1. Revert to previous stable revision via Argo CD if reject ratio spikes.
2. Force strict `llm_fail_mode=veto` if resilience mode underperforms.
3. Reduce notional multipliers to `0.25x` and pause further promotion.
4. Trigger incident runbook and preserve evidence set.

## Acceptance Criteria

This plan is complete only when all are true:

1. `llm_error` is no longer a dominant rejection class.
2. `qty_below_min` is either rare or replaced by precise capacity/inventory reasons.
3. `shorts_not_allowed` remains zero when shorts are enabled.
4. Rolling 20-session SLO reaches `>=15/20` Clean+Profitable.
5. All changes are covered by regression tests and runbook checks.
