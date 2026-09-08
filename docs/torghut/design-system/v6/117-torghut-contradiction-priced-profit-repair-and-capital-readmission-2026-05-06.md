# 117. Torghut Contradiction-Priced Profit Repair And Capital Readmission (2026-05-06)

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

Torghut will consume Jangar contradiction settlements as a profit-repair market before any paper or live capital
readmission.

The current Torghut state is not a reason to trade. It is a reason to repair the proof system in the order that most
improves future profitable action. Torghut live and sim pods are running, Postgres and ClickHouse pods are running,
`/db-check` is HTTP `200`, and the schema/account projections are current. At the same time, Torghut is `OutOfSync` in
Argo CD, live `/readyz` and `/trading/health` are HTTP `503`, live submission is disabled, live quant health is not
configured as a required route proof, the live account quant-health projection is stale, sim account quant health is
empty, empirical jobs are stale, market context is degraded, and open quant alerts remain.

The selected approach prices repairs by contradiction-reduction value and expected profit option value. This is not a
generic cleanup queue. A repair bid must state which capital gate it can unlock, which stale or contradictory evidence
it closes, how much query/runtime budget it may spend, and why it should increase expected profit without increasing
live risk.

The tradeoff is that Torghut will wait longer before capital readmission. I accept that because capital without fresh
proof is not innovation. The innovative part is converting stale proof into a ranked economic work queue that can
generate better hypotheses under strict guardrails.

## Evidence Snapshot

All checks were read-only.

### Runtime And Data Evidence

- Torghut live revision `torghut-00235` and sim revision `torghut-sim-00319` were running.
- Torghut Postgres, ClickHouse, Keeper, options, TA, websocket, Alloy, and Symphony pods were running.
- Argo CD reported `torghut` as `OutOfSync` and `Healthy`.
- Out-of-sync resources included `torghut-strategy-config`, simulation `AnalysisTemplate` resources, historical
  simulation workflow templates, empirical promotion workflow templates, and Knative services `torghut` and
  `torghut-sim`.
- Recent Torghut events included a failed simulation activity analysis, startup/readiness probe misses during sim
  promotion, duplicate ClickHouse PodDisruptionBudget matches, Keeper PDB `NoPods`, and one `torghut-db-1` readiness
  probe HTTP `500`.
- `/db-check` returned HTTP `200` with `schema_current=true`, `schema_graph_lineage_ready=true`, and
  `account_scope_ready=true`.
- `/readyz` returned HTTP `503`, `status=degraded`, and `live_submission_gate.allowed=false` with
  `simple_submit_disabled`.
- `/trading/health` returned HTTP `503`; quant evidence was `not_required` because `quant_health_not_configured`.
- `/trading/autonomy` reported empirical jobs `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and
  `janus_hgrm_reward` as stale.
- Jangar live account quant health returned `latestMetricsCount=108`,
  `latestMetricsUpdatedAt=2026-05-05T17:28:03.839Z`, and `metricsPipelineLagSeconds=64604`.
- Jangar sim account quant health returned `status=degraded`, `latestMetricsCount=0`, and `emptyLatestStoreAlarm=true`.
- Jangar market-context health for `AAPL` was degraded with stale technicals, fundamentals, news, and regime.
- Jangar quant alerts returned `199` open alerts, including `105` critical alerts.

### Source Evidence

- `services/torghut/app/main.py` owns `/readyz`, `/db-check`, `/trading/health`, `/trading/autonomy`, trading status,
  decisions, executions, and data projections. It is the right consumer surface for settlement ids, but not the right
  place to compute Jangar-wide contradiction authority.
- `services/torghut/app/trading/submission_council.py` already derives quant-health status and blocks on degraded
  required quant proof when configured. It should consume Jangar settlement ids before sizing or submission.
- `services/torghut/app/trading/scheduler/pipeline.py` owns signal continuity, market-context observations, rejection
  accounting, LLM decision context, and order-submission preparation. It should publish repair-value metadata, not
  bypass settlement.
- `services/torghut/config/trading/hypotheses/*.json` already gives Torghut a lane-local place to name candidate
  dependencies, expected edge, and guardrail metadata.

## Problem

Torghut has several blocked proof channels, but they are not equally valuable:

1. Empirical jobs are stale and currently block Jangar dependency quorum.
2. Live route quant-health wiring is missing, which prevents live health from acknowledging typed Jangar proof.
3. The live account quant projection is routable but stale.
4. The sim account projection is empty.
5. Market context is stale across all domains in the sample.
6. Argo CD drift means runtime health is not the same as desired-state convergence.
7. Duplicate PDB and readiness warnings reduce rollout confidence but do not directly price a hypothesis.

The old response would be to fix everything or freeze everything. That is too blunt. The next profitable system needs
to know which repair increases the probability of a safe paper canary and which repair only retires low-value audit
debt.

## Alternatives Considered

### Option A: Re-enable Paper Capital After Runtime Health Recovers

Pros:

- Fastest route back to market feedback.
- Uses the fact that live and sim pods are running and DB checks are green.

Cons:

- Ignores stale empirical jobs, stale account quant proof, empty sim proof, and OutOfSync desired state.
- Lets process health substitute for alpha proof.
- Does not reduce the `199` open quant alerts or stale market-context risk.

Decision: reject.

### Option B: Fixed Repair Priority

Pros:

- Simple to run: empirical replay, quant backfill, market context, GitOps drift, rollout hygiene.
- Easy to encode in a runbook.

Cons:

- Cannot distinguish a repair that unlocks a named hypothesis from generic cleanup.
- Does not adapt to market session, account, strategy, or alert severity.
- Can waste scarce runtime and query budget on low-value repairs.

Decision: reject as the target. Keep it as fallback if auction ranking fails.

### Option C: Contradiction-Priced Profit Repair

Pros:

- Prioritizes repairs that close a named Jangar settlement and unlock a measurable capital gate.
- Keeps live notional at `0` while still producing useful replay, paper, and proof-quality evidence.
- Gives Torghut a direct way to increase profitability: rank repairs by expected information value and edge recovery.
- Makes stale proof economically visible instead of treating it as a generic degraded flag.

Cons:

- Requires Torghut to publish repair-value metadata and closure receipts.
- Requires careful controls so expected profit is not treated as realized profit.
- Adds one more consumer contract to `/readyz`, `/trading/health`, and the scheduler.

Decision: select Option C.

## Profit Repair Model

Torghut emits `profit_repair_bid` records for Jangar's auction.

```text
profit_repair_bid
  bid_id
  jangar_settlement_id
  hypothesis_id
  candidate_id
  account
  strategy_id
  window
  market_session_id
  repair_class                 # empirical_replay, live_quant_wiring, quant_latest_backfill,
                               # sim_quant_bootstrap, market_context_refresh, gitops_convergence,
                               # rollout_hygiene
  expected_profit_value         # low, medium, high, critical
  expected_information_gain
  capital_gate_unlocked         # observe, paper_canary, live_micro_canary, live_scale
  max_query_budget
  max_runtime_minutes
  max_notional
  guardrails
  closure_receipt_schema
  expires_at
```

Ranking inputs:

- `empirical_replay` ranks high when it closes `empirical_jobs_degraded` for a candidate with current signal evidence.
- `live_quant_wiring` ranks high because live health currently cannot acknowledge typed Jangar quant proof.
- `quant_latest_backfill` ranks high when it closes stale live account/window proof or reduces critical scoped alerts.
- `sim_quant_bootstrap` ranks high when paper canary depends on sim account proof and current sim latest store is empty.
- `market_context_refresh` ranks high when the target hypothesis depends on symbols with stale technicals, fundamentals,
  news, or regime.
- `gitops_convergence` ranks high when desired state drift affects the route or workflow required by the repair.
- `rollout_hygiene` ranks high when PDB/readiness warnings threaten proof artifact reliability or canary widening.

## Measurable Hypotheses

Hypothesis 1:

- If stale empirical jobs for `intraday_tsmom_v1@prod` are replayed against a current dataset and closure receipts are
  published, Jangar dependency quorum will stop blocking on `empirical_jobs_degraded` for that candidate.
- Success metric: all four empirical jobs fresh within one market session and referenced by a Jangar settlement.
- Guardrail: max notional `0`; no paper or live orders from this repair.

Hypothesis 2:

- If live quant-health wiring is made parity-complete with sim and the live account/window latest store is refreshed,
  live `/trading/health` will stop reporting `quant_health_not_configured` and Jangar will reduce scoped quant-alert
  debt.
- Success metric: live health cites a Jangar quant-health source URL, live account/window lag stays under the configured
  threshold during market hours, and open scoped quant alerts fall by at least `50%` or receive explicit closure debt.
- Guardrail: live submission remains disabled and `TRADING_SIMPLE_SUBMIT_ENABLED=false`.

Hypothesis 3:

- If market-context refresh is ranked after empirical replay and live quant wiring, paper canary eligibility will improve
  without spending repair budget on stale context for hypotheses that still lack empirical proof.
- Success metric: each market-context repair bid names the hypothesis and settlement it can unblock; no context refresh
  runs without a candidate, symbol set, and closure receipt.
- Guardrail: no route may scan heavy quant tables to decide context priority.

Hypothesis 4:

- If Jangar contradiction settlement is consumed by the scheduler before order preparation, Torghut can keep
  zero-notional observation running while holding paper and live capital.
- Success metric: scheduler records settlement ids on observation decisions and refuses paper/live preparation when the
  matching settlement is `hold` or `block`.
- Guardrail: paper notional remains `0` until `paper_canary=allow`.

## Implementation Scope

Torghut engineer scope:

- Add repair-value metadata to `/trading/autonomy`, `/readyz`, and `/trading/health` for empirical replay,
  quant-health wiring, quant latest freshness, market-context freshness, and GitOps drift.
- Add settlement-id fields to readiness, trading health, scheduler observation records, and submission-council verdicts.
- Teach the scheduler to refuse paper/live preparation unless the matching Jangar settlement allows that capital class.
- Emit closure receipts for empirical replay, live quant-health wiring, account/window quant freshness, and market
  context refresh.
- Keep live submission disabled until a Jangar settlement explicitly allows paper canary and then live micro-canary.

Jangar engineer scope:

- Consume Torghut repair bids in the Jangar profit repair auction.
- Publish top repair bid, required closure receipt, and blocked capital gate in the Jangar status projection.
- Keep repair work budgeted by query/runtime limits and settlement expiry.

## Validation Gates

- Unit tests prove `quant_health_not_configured` becomes a live-quant-wiring repair bid, not a capital allow.
- Unit tests prove empty sim account quant health becomes a sim-quant-bootstrap bid.
- Unit tests prove stale empirical jobs outrank market-context refresh when the same hypothesis lacks fresh empirical
  proof.
- Integration tests prove `/trading/health` and scheduler observation records include Jangar settlement ids.
- Regression tests prove paper/live order preparation is blocked when settlement is `hold` or `block`.
- Data validation proves no routine readiness or auction route scans heavy quant series tables.

## Rollout Plan

1. Emit repair bids in shadow mode with `max_notional=0`.
2. Add Jangar settlement ids to Torghut health and scheduler observation records.
3. Run empirical replay and quant-health wiring repairs first because they close the current hard contradictions.
4. Run market-context refresh only for hypotheses whose empirical and quant proof are current enough to make context
   useful.
5. Permit paper canary only after Jangar settlement returns `paper_canary=allow`.
6. Permit live micro-canary only after paper canary closes with clean PnL, TCA, broker reconciliation, and rollback
   rehearsal.

## Rollback Plan

- Disable settlement consumption in Torghut with a feature flag and fall back to existing live-submission and
  dependency-quorum gates.
- Keep repair bids observable but ignored while rollback is active.
- If auction ranking is wrong, use fixed priority: empirical replay, live quant-health wiring, live account quant
  backfill, sim quant bootstrap, market-context refresh, GitOps convergence, rollout hygiene.
- If settlement ids are unavailable, Torghut must hold paper/live capital and continue zero-notional observation only.

## Handoff

Engineer handoff:

- Implement repair bids as data first. Do not couple the first pass to order submission.
- Start with empirical replay, live quant-health wiring, live account quant backfill, sim account bootstrap, and
  market-context refresh.
- Require every repair to declare a closure receipt schema and max budget.

Deployer handoff:

- Do not read pod health as capital readiness.
- Before paper capital, capture the Jangar settlement id, Torghut repair bid ids, empirical replay receipts,
  account/window quant proof, market-context proof, and the paper notional cap.
- Before live capital, require paper canary settlement, TCA freshness, broker reconciliation, rollback rehearsal, and an
  explicit live-micro settlement.
