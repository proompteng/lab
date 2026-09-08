# 112. Torghut Dual-Key Capital Clearance And Intraday Proof Loop (2026-05-06)

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

Torghut will move to **dual-key capital clearance**: local trading readiness and Jangar action-class clearance must
both agree before Torghut admits paper or live capital. A running route, current schema, fresh universe, or healthy
broker account is necessary but not sufficient.

The current live lane proves the need. At `2026-05-06T09:10Z`, live Torghut `/healthz` returned HTTP `200`, `/db-check`
returned HTTP `200` with Alembic head `0029_whitepaper_embedding_dimension_4096`, and Postgres, ClickHouse, Alpaca,
database schema, and universe dependencies were healthy. At the same time, `/readyz` and `/trading/health` returned
HTTP `503`, capital was `shadow`, promotion-eligible hypotheses were `0`, empirical jobs were stale, and Jangar
dependency quorum was blocked.

There is also a source-level split: the simple live submission helper in `services/torghut/app/main.py` can report
`dependency_quorum_decision=informational_only` while the broader Torghut health path blocks on stale proof and Jangar
quorum. I am not treating that as a production bug to patch in this architecture lane, but it is the reason this
contract exists. Capital admission must consume the same receipt in health, status, and submission, or it is not a
capital gate.

The tradeoff is slower promotion from shadow to paper/live. I accept it because stale empirical proof from
`2026-03-21` and empty sim-account quant evidence should buy repair work, not live risk. The design creates a profitable
path by allowing zero-notional observation and proof refresh under Jangar receipts while keeping broker submission
closed until the proof loop is fresh.

## Current Evidence

No Kubernetes resources, database records, broker settings, runtime flags, or trading state were mutated.

### Cluster And Runtime

- Torghut live revision `torghut-00234` and sim revision `torghut-sim-00315` were running with current pods `2/2`.
- The active live image reported build `v0.568.5-148-gcfeb86f5c` and commit `cfeb86f5cd0d70a74b4d5ed4aecfb4123282a5c9`.
- Options catalog and options enricher pods were running; options catalog `/healthz` returned HTTP `200`.
- Equity TA, sim TA, and options TA Flink jobs were `RUNNING` through their REST APIs.
- Torghut websocket readiness returned HTTP `200` with `alpaca_ws`, `kafka`, and `trade_updates` gates true.
- Recent Torghut namespace events included two failed sim proof teardown-clean jobs and repeated ClickHouse PDB
  ambiguity warnings.

### Database And Data

- Direct DB exec is forbidden for this worker, so DB assessment uses Torghut and Jangar read-only projections.
- Torghut `/db-check` returned `ok=true`, expected/current Alembic head
  `0029_whitepaper_embedding_dimension_4096`, one current head, no unexpected heads, and account scope ready.
- Schema lineage remains usable but reports parent-fork warnings at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Torghut live `/trading/status` reported `last_decision_at=2026-05-04T17:25:57.901670Z`, signal lag around
  `43900s`, `market_session_open=false`, and `expected_market_closed_staleness`.
- Live empirical jobs were stale for `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward`, all tied to dataset `torghut-full-day-20260318-884bec35`.
- Sim empirical jobs were missing for the same four job types.
- Jangar typed quant health was healthy for the unscoped latest-store view with `latestMetricsCount=3780` and
  `metricsPipelineLagSeconds=0`.
- Sim account quant evidence for `TORGHUT_SIM` was empty, with `quant_latest_metrics_empty`,
  `empty_latest_store_alarm=true`, and no stages.
- Live TCA had `order_count=13775` and `avg_abs_slippage_bps=568.6138848199565249`; the value is too high to treat as
  fresh profitability proof without a current TCA decomposition.

### Source

- `services/torghut/app/main.py` builds `/readyz`, `/trading/health`, `/trading/status`, live-submission payloads, DB
  readiness, TCA summaries, and the control-plane contract in one large module.
- `services/torghut/app/trading/submission_council.py` owns the full capital gate for dependency quorum, empirical jobs,
  DSPy readiness, quant health, and promotion certificate evidence.
- The simple pipeline branch in `app/main.py` bypasses the full submission council and returns
  `dependency_quorum_decision=informational_only`, `empirical_jobs_ready=None`, and `dspy_live_ready=None` for simple
  live mode.
- Tests exist for readiness, empirical jobs, quant evidence, submission council, promotion truthfulness, DSPy workflow,
  and options lane. The missing system test is parity across `/readyz`, `/trading/health`, `/trading/status`, and the
  submission path for the same capital-clearance receipt.

## Problem

Torghut currently mixes four states that need different actions:

1. **Alive**: the service can answer health checks.
2. **Operationally ready**: DB, ClickHouse, broker, universe, scheduler, and websocket dependencies are reachable.
3. **Proof-ready**: empirical jobs, sim account quant evidence, TCA, market-context data, and signal continuity are
   fresh enough to evaluate a hypothesis.
4. **Capital-ready**: proof-ready state plus Jangar action-class clearance, no contradiction cases, rollback target,
   and broker-submission guardrails.

The live lane is alive and operationally ready in several respects, but it is not proof-ready or capital-ready. The sim
lane is alive and ready, but missing sim-account quant evidence and empirical jobs. If Torghut only waits, it does not
generate the evidence needed to become profitable. If it promotes locally, it can skip control-plane proof. The right
system lets Torghut learn in zero-notional and repair modes while capital remains locked.

## Alternatives Considered

### Option A: Keep Simple Submit Disabled Until All Existing Gates Are Green

Pros:

- Safest immediate capital posture.
- Requires no new integration.
- Keeps live broker risk at zero.

Cons:

- Does not refresh stale empirical proof.
- Does not fill the empty sim account quant-health view.
- Leaves options and microstructure evidence unused during market hours.

Decision: reject as the target architecture. Keep it as the default rollback state.

### Option B: Promote From Torghut Local Health Alone

Pros:

- Fastest path to paper and live experimentation.
- Uses Torghut status, TCA, and broker checks directly.
- Avoids a new Jangar receipt dependency.

Cons:

- Does not reduce control-plane failure modes.
- Lets the simple lane drift from the full submission council.
- Gives deployers no single receipt tying route, proof, and capital admission together.

Decision: reject. It optimizes speed over trust.

### Option C: Dual-Key Capital Clearance With Intraday Proof Loops

Pros:

- Uses Jangar receipts as the second key for action-class capital admission.
- Allows zero-notional observation and proof repair while capital remains held.
- Converts stale empirical jobs and empty sim quant evidence into measurable repair work.
- Gives profitability work a market-session loop instead of waiting for manual proof refresh.
- Forces `/readyz`, `/trading/health`, `/trading/status`, and submission admission to agree.

Cons:

- Requires Torghut to plumb receipt ids through multiple surfaces.
- Adds one more gate before paper/live capital.
- Needs deployer discipline so observe-only receipts are not treated as broker permission.

Decision: select Option C.

## Profitability Hypotheses

Hypothesis 1: **Sim account proof fill**. During the next market session, Torghut sim should produce account-scoped
quant evidence for `TORGHUT_SIM` every minute for at least `30` consecutive minutes. Success is
`latest_metrics_count > 0`, `stage_count > 0`, `metrics_pipeline_lag_seconds <= 15`, and no broker submissions.

Hypothesis 2: **Options shadow spread edge**. When options catalog/enricher are ready, Torghut should collect
zero-notional options observations for the highest-liquidity underliers in the current universe. Success is at least
`20` observations per candidate group per session, median quoted spread below the configured ceiling, and no promotion
unless empirical jobs are fresh.

Hypothesis 3: **Microstructure TCA repair**. The high live `avg_abs_slippage_bps` value must be decomposed by order
class before any capital reentry. Success is a current TCA proof that separates stale historical orders from current
shadow decisions and demonstrates post-cost expectancy above the hypothesis hurdle.

Hypothesis 4: **Market-closed stale signal discipline**. Signal lag during market-closed windows should create observe
or repair work, not capital permission and not false operational failure. Success is that market-closed stale signals
remain classified as expected staleness while any market-open lag over the threshold blocks `paper_canary` and
`live_micro_canary`.

## Architecture

Torghut adds `capital_clearance` to all capital-facing surfaces:

```text
capital_clearance
  requested_action_class
  receipt_id
  receipt_decision
  proof_clock_id
  fresh_until
  local_readiness_decision
  local_blocked_reasons
  jangar_blocked_reasons
  empirical_job_refs
  quant_health_ref
  sim_account_ref
  tca_ref
  rollback_ref
  submission_admission_decision
```

Dual-key invariant:

```text
capital_allowed =
  local_readiness_decision == allow
  and receipt_decision == allow
  and receipt_id is fresh
  and receipt_id is echoed by /readyz, /trading/health, /trading/status, and submission admission
```

Observe and repair modes are allowed to be useful:

- `torghut_observe` may run zero-notional options and microstructure collection.
- `dispatch_repair` may refresh empirical jobs, sim quant stages, and TCA decomposition.
- `paper_canary`, `live_micro_canary`, and `live_scale` require dual-key clearance.

## Implementation Scope

Engineer stage:

- Add Torghut configuration for the Jangar capital-clearance endpoint.
- Load the Jangar receipt next to the existing quant-health and dependency-quorum calls.
- Extend `/readyz`, `/trading/health`, `/trading/status`, and `/trading/autonomy` with the same
  `capital_clearance` payload.
- Route the simple pipeline through the same receipt-aware admission helper used by the full submission council.
- Add a zero-notional intraday proof loop for sim account quant-health fill, options observations, and current TCA
  decomposition.
- Persist proof-loop outputs as empirical job candidates before any paper promotion.

Deployer stage:

- Keep `TRADING_SIMPLE_SUBMIT_ENABLED=false` until a `live_micro_canary` receipt is fresh and echoed by Torghut.
- Wire `TRADING_JANGAR_QUANT_HEALTH_URL` for both live and sim account scopes.
- Treat observe-only and repair-only receipts as non-capital permissions.
- Promote paper before live, and live micro-canary before scale.

## Validation Gates

- Unit: simple pipeline and full submission council return the same capital-clearance decision for identical evidence.
- Unit: missing Jangar receipt blocks `paper_canary`, `live_micro_canary`, and `live_scale`.
- Unit: `torghut_observe` permits zero-notional options observations while broker submission remains blocked.
- Unit: empty `TORGHUT_SIM` quant evidence blocks `paper_canary`.
- Unit: stale empirical jobs block capital and list all four stale or missing job types.
- Integration: `/readyz`, `/trading/health`, `/trading/status`, and submission admission echo the same receipt id.
- Data: empirical proof jobs refresh inside `24h` before paper promotion.
- Profit: paper promotion requires current TCA coverage, post-cost expectancy above the configured hurdle, and no open
  Jangar contradiction case.

## Rollout And Rollback

Phase 0: expose `capital_clearance` in shadow. No behavior change.

Phase 1: enable observe-only proof loops. Rollback is to disable the proof-loop scheduler; no broker state changes are
possible.

Phase 2: require `paper_canary` receipts before paper account promotions. Rollback is to force all paper receipts to
`hold` and continue observation.

Phase 3: require `live_micro_canary` receipt before live broker submission can be enabled. Rollback is
`TRADING_SIMPLE_SUBMIT_ENABLED=false`, receipt decision `hold`, and strategy family deallocation to shadow.

Phase 4: require sustained `live_micro_canary` proof across consecutive market sessions before `live_scale`. Rollback
is capital multiplier zero and receipt class demotion to `paper_canary` or `torghut_observe`.

## Risks

- The new receipt can become another stale field if it is not checked at submission time. Submission admission must
  revalidate `fresh_until`.
- Zero-notional options evidence can overstate fill quality if it records quotes without simulated execution quality.
  Observations must include spread, depth, age, and simulated fill assumptions.
- TCA repair can overfit stale historical orders. The first repair should separate historical live orders from current
  shadow and paper candidates.
- Market-closed expected staleness is subtle. The classifier must block market-open lag without turning normal closed
  sessions into false incidents.

## Handoff Contract

Engineer acceptance gate:

- Implement receipt consumption and simple/full gate parity tests.
- Add proof-loop outputs for sim quant evidence, options observations, and TCA decomposition.
- Keep all capital actions blocked when receipt ids are missing, stale, or mismatched.

Deployer acceptance gate:

- Do not enable paper or live capital unless Torghut and Jangar cite the same fresh receipt id for the requested action.
- Verify `/readyz`, `/trading/health`, `/trading/status`, and submission admission agree before widening.
- Roll back by disabling submit, forcing capital receipt decisions to `hold`, and leaving observe/repair work running
  only if their own action-class receipts remain valid.
