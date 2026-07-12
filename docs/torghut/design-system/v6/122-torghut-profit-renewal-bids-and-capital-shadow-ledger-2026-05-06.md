# 122. Torghut Profit Renewal Bids And Capital Shadow Ledger (2026-05-06)

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

Torghut will publish **profit-renewal bids** and settle them through a **capital shadow ledger** before any paper or
live capital readmission.

The current Torghut posture is useful but not capital-grade. In the read-only sample at `2026-05-06T13:23Z`, Argo CD
reported Torghut `Synced` and `Healthy` at revision `cbf0d72c1fdb27d1f5d9f967b9d64742ff18ddfb`, and the live,
sim, database, ClickHouse, Keeper, TA, options, websocket, Alloy, and Symphony pods were running. Torghut live
`/readyz` returned HTTP `503` because live submission is disabled by `simple_submit_disabled` in
`capital_stage=shadow`, not because Postgres, ClickHouse, Alpaca, database schema, scheduler, or universe checks were
down. Sim `/readyz` returned HTTP `200` in paper mode.

That green infrastructure does not establish profitability. Empirical jobs for `benchmark_parity`,
`foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward` were stale for `intraday_tsmom_v1@prod`.
Jangar live-account quant health had `108` latest metric rows but a `71764` second pipeline lag. The sim account had
`0` latest metric rows. Market context for `AAPL` was degraded with stale technicals, fundamentals, news, and regime
domains. Jangar had `50` open quant alerts, `37` of them critical.

The selected design makes every Torghut repair compete as a bid. A bid names the stale proof it will renew, the
hypothesis or strategy it can unblock, the expected information gain, the runtime/query budget it consumes, the Jangar
repair lane it needs, and the capital state it may unlock after closure. The capital shadow ledger records what would
have been allowed if the bid succeeded, while keeping live notional at `0` until Jangar and Torghut receipts are both
fresh.

The tradeoff is slower capital reentry. I accept that. Torghut profitability should come from spending repair budget
on the proof most likely to unlock safe future capital, not from turning a degraded readiness surface into a live
trading exception.

## Evidence Snapshot

All checks were read-only.

### Runtime And Data Evidence

- Argo CD reported `torghut` as `Synced` and `Healthy` at revision
  `cbf0d72c1fdb27d1f5d9f967b9d64742ff18ddfb`.
- Live revision `torghut-00237` and sim revision `torghut-sim-00326` were running.
- ClickHouse, Keeper, Torghut Postgres, live TA, sim TA, options catalog, options enricher, websocket, websocket
  options, guardrail exporters, Alloy, and Symphony workloads were running.
- Recent Torghut events showed sim rollout churn, a successful sim runtime-ready analysis, one failed sim activity
  analysis, and duplicate ClickHouse PodDisruptionBudget matches.
- Direct CNPG `psql` probes for `torghut-db` were forbidden by service-account RBAC, so routine validation must use
  service-owned projections unless deployer runs a higher-privilege read-only check.
- Live `/readyz` returned HTTP `503`; scheduler, Postgres, ClickHouse, Alpaca, database schema, and universe checks
  were healthy, but `live_submission_gate.allowed=false` with `reason=simple_submit_disabled`.
- Live `/trading/health` returned `status=degraded`, `capital_stage=shadow`, `promotion_eligible_total=0`, and
  `rollback_required_total=3`.
- Sim `/readyz` returned HTTP `200` with `capital_stage=paper`, but its quant evidence was degraded because
  `latestMetricsCount=0`, `emptyLatestStoreAlarm=true`, and no pipeline stages were present.
- `/trading/autonomy` reported stale empirical jobs `benchmark_parity`, `foundation_router_parity`,
  `janus_event_car`, and `janus_hgrm_reward`, all tied to candidate `intraday_tsmom_v1@prod` and dataset
  `torghut-full-day-20260318-884bec35`.
- Jangar live-account quant health returned `latestMetricsCount=108`,
  `latestMetricsUpdatedAt=2026-05-05T17:28:03.839Z`, and `metricsPipelineLagSeconds=71764`.
- Jangar market-context health for `AAPL` returned `overallState=degraded`, `bundleFreshnessSeconds=147901`, and
  `bundleQualityScore=0.4575`. Technicals, fundamentals, news, and regime were stale.
- Jangar quant alerts returned `50` open alerts: `37` critical and `13` warning.

### Jangar Coupling Evidence

- Jangar database projection was healthy with `28/28` Kysely migrations applied.
- Jangar watch reliability was degraded with `3` streams, `6894` events, `2` errors, and `6` restarts.
- Jangar dependency quorum blocked on `watch_reliability_blocked` and `empirical_jobs_degraded`.
- Jangar action budgets held `paper_canary`, blocked `live_micro_canary`, and blocked `live_scale`.
- The companion Jangar contract defines the repair admission governor that admits one zero-notional repair lane while
  keeping material action held.

### Source Evidence

- `services/torghut/app/main.py` owns readiness, DB checks, trading health, autonomy, decisions, executions, and data
  projections. It should expose bid and ledger state, not own Jangar admission authority.
- `services/torghut/app/trading/submission_council.py` already validates typed Jangar quant health and capital-stage
  requirements before live submission.
- `services/torghut/app/trading/empirical_jobs.py` verifies artifact truthfulness, lineage completeness, stale job
  status, and promotion authority eligibility.
- `services/torghut/app/trading/scheduler/pipeline.py` owns market-context observations, signal continuity, rejection
  accounting, LLM decision context, and order preparation. It should produce bid inputs and repair closure receipts.
- Tests exist for empirical jobs, market-context evaluation, typed quant health, submission council, trading health,
  simulation parity, and quant readiness. The missing system-level test is bid ranking plus capital shadow settlement
  under a Jangar repair-admission hold.

## Problem

Torghut currently has multiple truthful blockers:

1. Live submission is disabled in shadow.
2. Empirical promotion proof is stale.
3. Live quant metrics are old enough to be economically suspect.
4. Sim quant metrics are empty.
5. Market context is stale across all domains.
6. Open critical quant alerts remain unresolved.
7. Jangar dependency quorum blocks material action.

Running a generic repair sequence treats all blockers as equal. They are not equal. A stale empirical replay for
`intraday_tsmom_v1@prod` may be the highest-value repair because it can unlock paper eligibility. A sim quant bootstrap
may be cheaper and necessary before paper canary. Market-context rehydration may be essential before LLM-backed
decisions but less urgent for deterministic replay. Quant alert closure may be expensive and only meaningful after the
latest store is fresh.

Torghut needs a durable way to express that ordering to Jangar without granting itself capital authority.

## Alternatives Considered

### Option A: Keep Capital Disabled Until Every Health Surface Is Green

Pros:

- Simple and safe for live notional.
- Easy to explain during incident response.
- Does not require new schemas.

Cons:

- Does not rank repairs.
- Can leave high-value empirical proof stale while lower-value cleanup runs first.
- Gives no audit record for why capital was readmitted later.
- Does not help Jangar allocate repair capacity under dependency-quorum block.

Decision: reject as the operating model. Keep it as the live safety baseline.

### Option B: Run A Fixed Repair Ladder

Pros:

- Predictable: empirical replay, sim quant bootstrap, market context, live quant, alert closure.
- Easy to implement with existing scripts and jobs.
- Better than waiting for every surface to turn green.

Cons:

- Ignores current Jangar watch backpressure.
- Wastes budget when a cheaper repair would unlock the same gate.
- Cannot adapt to market-session value, hypothesis priority, or route-specific alert scope.

Decision: reject as the target. It is acceptable as fallback when bid scoring is unavailable.

### Option C: Profit-Renewal Bids With Capital Shadow Settlement

Pros:

- Makes repair work compete on expected information gain, capital-unblock value, risk reduction, and cost.
- Keeps all bids zero-notional until Jangar grants a lane and closure receipts are complete.
- Gives paper and live readmission a durable evidence trail.
- Lets Torghut innovate on repair value without bypassing Jangar authority.

Cons:

- Requires new bid and ledger records.
- Requires conservative scoring until enough closure history exists.
- Adds one more status surface for operators to inspect.

Decision: select Option C.

## Architecture

Torghut emits `torghut_profit_renewal_bid` records.

```text
torghut_profit_renewal_bid
  bid_id
  created_at
  expires_at
  hypothesis_id
  candidate_id
  account
  strategy_id
  market_session_id
  stale_evidence_refs
  requested_jangar_lane_class       # empirical_replay, sim_quant_bootstrap, market_context_rehydrate,
                                    # live_quant_refresh, quant_alert_closure
  expected_information_gain         # low, medium, high, critical
  capital_unblock_class             # observe, paper_canary, live_micro_canary, live_scale
  risk_reduction_score
  expected_profit_value_class       # low, medium, high, critical; never treated as realized PnL
  runtime_budget_seconds
  query_budget_units
  max_notional
  guardrails
  bid_decision                      # proposed, selected, denied, expired, closed
  denial_reasons
```

Selected bids create `torghut_profit_renewal_receipt` records.

```text
torghut_profit_renewal_receipt
  receipt_id
  bid_id
  completed_at
  lane_class
  closure_status                   # complete, partial, failed, expired
  before_refs
  after_refs
  empirical_artifact_refs
  quant_health_refs
  market_context_refs
  alert_delta_refs
  jangar_repair_lane_receipt_ref
  next_capital_gate
```

Capital state is tracked in `torghut_capital_shadow_ledger`.

```text
torghut_capital_shadow_ledger
  ledger_id
  generated_at
  expires_at
  account
  hypothesis_id
  candidate_id
  current_capital_stage
  shadow_decision                  # keep_shadow, allow_paper_shadow, eligible_for_paper, eligible_for_live_micro
  live_notional_ceiling
  paper_notional_ceiling
  required_receipt_refs
  missing_receipt_refs
  rollback_target
```

Initial bid scoring:

```text
priority_score =
  information_gain_weight
  + capital_unblock_weight
  + risk_reduction_weight
  + evidence_age_weight
  - runtime_cost_weight
  - query_cost_weight
  - uncertainty_penalty
```

The first implementation should keep scores ordinal. It should not claim dollar PnL until closed receipts can be tied
to realized paper or live outcomes.

## Measurable Hypotheses

Hypothesis 1: rerunning stale empirical jobs for `intraday_tsmom_v1@prod` should retire the
`empirical_jobs_degraded` block for paper canary if all four required job types are fresh, truthful, and lineage
complete.

Hypothesis 2: bootstrapping `TORGHUT_SIM` latest quant metrics should move sim quant health from `degraded` to `ok`
and reduce paper-canary uncertainty before any live setting changes.

Hypothesis 3: rehydrating `AAPL` market context should move all four domains inside freshness thresholds and reduce
LLM decision shadow blocks, but it must not by itself unlock live capital.

Hypothesis 4: live-account quant lag repair should reduce open critical `metrics_pipeline_lag_seconds` alerts before
any candidate can request live micro-canary.

## Guardrails

- `max_notional` is always `0` for bids selected while Jangar dependency quorum is blocked.
- `simple_submit_disabled` remains a hard live-submission block until GitOps explicitly changes live submission
  configuration and the capital shadow ledger has all required receipts.
- Expected profit value is an ordering signal, not realized PnL.
- A failed bid cannot immediately retry without a new stale-evidence snapshot and a higher expected information gain
  or lower cost.
- Market-context renewal may feed LLM advisory paths only after domain freshness and citation quality receipts exist.
- Quant alert closure can carry bounded debt only when the candidate scope is explicit and the alert is not critical
  for the requested capital gate.

## Engineer Scope

The engineer stage should:

1. Add bid and capital-shadow-ledger data contracts near the existing Torghut control-plane status contracts.
2. Build a pure bid scorer over empirical job status, typed quant health, market-context health, alert counts, and
   capital stage.
3. Expose bid summaries from Torghut health/autonomy surfaces without changing live submission behavior.
4. Add submission-council tests proving live submission ignores expected profit value unless required receipts exist.
5. Add scheduler tests proving failed market-context or quant repair bids keep decisions in shadow.

## Deployer Gates

Before capital moves beyond shadow, deployer must capture:

- Torghut `/readyz` and `/trading/health` with storage dependencies healthy.
- Fresh empirical receipts for all required job types for the candidate.
- Non-empty sim latest quant metrics for the requested window.
- Live-account quant lag within the accepted threshold for the candidate scope.
- Market-context domain freshness for the symbol set used by advisory decisions.
- No open critical quant alerts for the candidate scope, or an approved bounded-debt waiver.
- Jangar repair lane receipt and material-action activation receipt for the same account, candidate, and window.

## Rollout

Phase 1 emits bids and the shadow ledger in observe mode.

Phase 2 lets Jangar select one bid as a repair lane but keeps Torghut live notional at `0`.

Phase 3 allows paper canary only when selected bid receipts close stale empirical, sim quant, and market-context debt.

Phase 4 allows live micro-canary only after paper settlement and live quant alert closure receipts are complete.

## Rollback

Rollback is to ignore bid ranking and keep the existing Torghut submission council, empirical-job health, market
context, typed quant health, and live submission toggles as authority. The bid stream can continue as audit-only
evidence. If bid scoring is noisy, fall back to the fixed repair ladder with `max_notional=0`.

## Risks

- Bid scores can look more precise than they are. Mitigation: use ordinal classes and show uncertainty.
- Jangar can deny high-value bids during watch turbulence. Mitigation: bids remain queued with expiry and starvation
  counters.
- Market-context repairs can consume provider quota. Mitigation: query budget is part of the bid and must be visible.
- Capital shadow decisions can be mistaken for live permission. Mitigation: live notional ceiling remains `0` until
  all receipts and GitOps flags are present.

## Handoff

Engineer acceptance gate: a fixture with stale empirical jobs, empty sim quant latest store, degraded market context,
open critical quant alerts, and live submission disabled must produce ordered bids with `max_notional=0` and a capital
shadow ledger that keeps live disabled.

Deployer acceptance gate: no paper or live capital gate may change state unless the selected bid has a closure receipt,
Jangar has a matching repair lane receipt, and the capital shadow ledger lists no missing required receipts.
