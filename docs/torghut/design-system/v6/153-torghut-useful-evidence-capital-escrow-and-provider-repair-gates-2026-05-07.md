# Torghut useful evidence capital escrow and provider repair gates

Status: Accepted architecture direction

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

I am choosing useful-evidence capital escrow for the next Torghut profitability increment. Torghut should keep observe
and repair lanes moving, but it should not admit paper widening, live micro-canary, or live scale when the proof behind
the decision is wrapper-only, stale, missing, or too expensive to query.

The capital gate will score each hypothesis on post-cost evidence, not on whether a surrounding workflow completed. A
market-context wrapper success without durable evidence rows is not capital proof. A quant pipeline with fresh open
critical lag alerts is not capital proof. A provider timeout that loses the real error while handling bytes is repair
evidence, not alpha evidence.

The goal is profitability, not just safety. Capital should be reserved for hypotheses whose evidence is fresh, measured,
and cheap enough to carry. Repair work should earn its way back into capital eligibility by producing durable receipts
that Jangar can settle.

## Evidence Captured

Cluster evidence on 2026-05-07:

- Torghut market-context wrapper CronJobs completed, but provider child jobs failed. Failed fundamentals and news
  preopen probes logged `Missing repository metadata in event payload`.
- A failed fundamentals batch child timed out after 600 seconds and then raised a secondary `TypeError` while handling
  byte output from the timeout.
- Torghut quant discover, plan, implement, and verify wrapper cron lanes had recent complete jobs after earlier failures,
  which proves the scheduler can recover but does not prove every consumer got useful evidence.

Database evidence from Jangar Postgres on 2026-05-07:

- `public.torghut_market_context_evidence` had zero rows.
- `public.torghut_market_context_runs` had two `fundamentals` rows still in `started`, with latest activity at
  2026-05-06T13:44:12Z for `NVDA`; the latest `news` success was 2026-05-06T19:43:09Z.
- `public.torghut_market_context_run_events` had 52 `finalize` events, 8 `start` events, and only 1 `progress` event.
  That shape suggests coarse run accounting without enough durable per-source evidence.
- `torghut_control_plane.quant_alerts` had fresh open critical `metrics_pipeline_lag_seconds` alerts updated around
  2026-05-07T14:11Z.
- A latest-row query against `torghut_control_plane.quant_pipeline_health` exceeded a 3 second statement timeout. For a
  capital gate, slow proof is degraded proof.

Source evidence:

- `services/jangar/src/server/torghut-market-context.ts` computes provider health and domain freshness, but provider
  health is process-local while the durable evidence table was empty in the production database snapshot.
- `services/jangar/src/routes/api/torghut/market-context/runs/*` already gives start, progress, finalize, evidence, and
  status endpoints. The gap is not endpoint existence; it is durable evidence completeness and provider job truth.
- `services/torghut/app/trading/scheduler/pipeline.py` already blocks or shadows LLM decisions when market context is
  unavailable. The missing contract is how capital re-enters after repair and how the evidence is priced after cost.
- `services/jangar/src/server/torghut-quant-metrics.ts` derives realized PnL and freshness metrics from trading and
  ClickHouse data. That is the right surface for profitability proof, but the current DB evidence shows queryability and
  lag need to be first-class gate inputs.

## Problem

Torghut has moved beyond "does a strategy produce a signal" into "does a strategy deserve capital after data cost,
execution cost, freshness risk, and repair debt." The current evidence path can still confuse activity with proof. A
wrapper can complete while the provider work underneath fails. A market-context run can be recorded without evidence
rows. Quant metrics can be logically present but operationally too stale or slow to trust for a live action.

That creates a profitability failure mode: capital can be spent on hypotheses whose alpha is not current, whose data
cost is unpriced, or whose risk model is using degraded context. Blocking all capital would be safe but would stop
learning. Ignoring the evidence debt would keep activity high while widening loss risk.

## Options Considered

Option A: hard stop all paper and live capital until market-context and quant evidence are green.

This is safe and simple, but it creates no incentive gradient. Provider repair, data-pipeline repair, and hypothesis
triage all become equally urgent. It also blocks paper learning even when the degraded surface is unrelated to the
hypothesis being tested.

Option B: continue shadow-only market-context handling and rely on downstream PnL.

This preserves momentum, but it treats stale proof as a cost of doing business. That is unacceptable for live
admission. The current evidence shows missing durable market-context evidence and open critical quant lag alerts. PnL
after the fact is too late as the primary capital brake.

Option C: capital escrow with useful-evidence receipts and repair dividends.

This is the selected direction. It lets observe and bounded repair continue, prices each data/proof gap against a
hypothesis, and returns capital eligibility only when the repaired evidence clears measurable gates. The tradeoff is
that Torghut must maintain a small capital ledger and a repair queue. I accept that complexity because it connects
engineering repair directly to profit eligibility.

## Architecture

Introduce `CapitalEscrowReceipt` as the Torghut-side consumer of Jangar useful-evidence receipts. Each receipt is scoped
to one account, hypothesis, action class, and evidence window.

Required fields:

- `receipt_id`: deterministic hash of account, hypothesis, action class, source revision, and evidence window.
- `hypothesis_id`: strategy or research hypothesis being considered for capital.
- `account`: paper or live account label.
- `action_class`: `observe`, `repair`, `paper_canary`, `live_micro_canary`, or `live_scale`.
- `evidence_window`: start and end timestamps used for market context, quant metrics, fills, and TCA.
- `freshness_score`: minimum domain freshness score across technicals, fundamentals, news, regime, and quant metrics.
- `post_cost_edge_bps`: expected edge after data cost, spread, fees, slippage, borrow or option premium cost, and repair
  reserve.
- `drawdown_budget_bps`: maximum allowed loss before automatic deallocation.
- `provider_debt`: normalized provider failures, timeouts, missing repository metadata, and missing durable evidence.
- `quant_debt`: open lag alerts, stale metrics, slow queries, and missing windows.
- `capital_decision`: `observe_only`, `repair_only`, `paper_allowed`, `live_hold`, or `live_allowed`.
- `repair_dividend`: explicit evidence product that, if produced, can restore capital eligibility.

The escrow decision is computed with three gates.

Proof gate:

- Market-context evidence must have durable rows or an explicit source-bound waiver.
- Provider jobs must produce start, progress, finalize, and evidence events for capital-bearing domains.
- Missing repository metadata in provider event payloads blocks capital because it prevents source binding.

Profit gate:

- `post_cost_edge_bps` must exceed the action-class hurdle after data and execution costs.
- Metrics pipeline lag cannot be critical and open for the account/hypothesis window.
- A slow proof query counts as degraded unless the gate has a cached receipt fresh enough for the window.

Repair gate:

- Failed providers create repair-only tickets with bounded notional zero.
- Repair work earns a dividend only when it produces durable evidence rows and a settled Jangar useful-evidence receipt.
- Repeated repair timeouts reduce the hypothesis capital budget until a clean provider run closes the debt.

## Measurable Trading Hypotheses

Hypothesis 1: Fresh market-context evidence improves LLM-assisted decision selectivity enough to offset data cost.

- Metric: delta in accepted decision precision versus shadow baseline.
- Gate: 7-day paper window with positive post-cost edge and no domain freshness breach in admitted decisions.
- Failure condition: market-context blocks increase opportunity cost without improving realized or simulated precision.

Hypothesis 2: Quant lag alerts are predictive of poor capital timing and should reduce notional before PnL confirms it.

- Metric: drawdown and adverse selection during open `metrics_pipeline_lag_seconds` alert windows.
- Gate: alert windows must show statistically worse or at least non-improving outcomes before promotion from hard hold
  to dynamic haircut.
- Failure condition: lag alerts have no predictive value after controlling for symbol liquidity and session time.

Hypothesis 3: Provider repair dividends create higher return on engineering time than blind reruns.

- Metric: repair job count per restored capital-eligible hypothesis and restored post-cost edge.
- Gate: a repair lane is only promoted if it restores at least one hypothesis to paper eligibility within two trading
  days and does not increase failed provider job rate.
- Failure condition: repair jobs improve wrapper success but not durable evidence rows or capital eligibility.

## Guardrails

- No paper or live widening when `public.torghut_market_context_evidence` is empty for the required domain and window.
- No live action when critical quant lag alerts are open for the account/hypothesis window.
- No capital-bearing action when a provider child job failed from missing repository metadata, because source binding is
  part of evidence validity.
- No capital-bearing action when proof queries exceed the configured statement timeout and no fresh cached receipt
  exists.
- Observe-only remains allowed when the order path is physically unable to submit notional exposure.
- Repair-only remains allowed with zero notional, one bounded dispatch, and a concrete repair dividend.

## Implementation Scope

Engineer stage:

- Add `CapitalEscrowReceipt` calculation in Jangar's Torghut control-plane server code and expose it through the
  existing Torghut quant/control-plane API surface.
- Persist capital escrow receipts with indexes on account, hypothesis, action class, evidence window, and decision.
- Fix provider runner timeout handling so byte output is decoded before writing errors, preserving the original timeout
  cause.
- Require provider event payloads to include repository, source revision, provider, domain, and request ID before they
  can count as capital evidence.
- Add market-context evidence completeness tests for start/progress/finalize/evidence event sequences.
- Add quant lag tests proving open critical alerts hold paper/live capital but still admit observe and repair.

Deployer stage:

- Start with observe-only escrow summaries in the Torghut control-plane UI.
- Enable repair-only holds for missing provider metadata and empty durable evidence tables.
- Enable paper-canary capital gates after one full trading day of escrow receipts.
- Enable live micro-canary gates only after paper receipts prove positive post-cost edge and no unresolved critical
  quant lag.

## Validation Gates

- Provider runner regression: a timed-out provider writes a string error, preserves timeout category, and does not throw
  a secondary `TypeError`.
- Market-context persistence regression: a successful provider run writes at least one durable evidence row or marks the
  run `partial` with a blocking reason.
- Escrow regression: empty evidence rows plus wrapper success yields `repair_only`, not `paper_allowed`.
- Quant regression: open critical `metrics_pipeline_lag_seconds` yields `live_hold` and zero live notional.
- DB performance: latest escrow receipt lookup and latest quant-alert lookup complete under 500 ms with statement
  timeout enabled.
- Trading validation: paper promotion requires positive post-cost edge, bounded drawdown, and no unresolved freshness
  breach for the evidence window.

## Rollout And Rollback

Rollout sequence:

1. `shadow`: compute receipts and show capital decisions without changing order admission.
2. `repair-hold`: hold capital on missing provider metadata, empty evidence rows, and provider timeouts, while admitting
   repair.
3. `paper-gate`: require `paper_allowed` escrow receipts for paper canaries.
4. `live-gate`: require `live_allowed` receipts for live micro-canary, with explicit deployer approval.

Rollback is staged. Disable live-gate first, then paper-gate, then repair-hold. Keep shadow receipt calculation running
unless it is the source of production load, because the receipts are the evidence needed to repair the gate safely. If
the receipt table or queries cause DB pressure, revert to cached read-only summaries and block capital rather than
allowing stale proof to pass.

## Risks

- The escrow ledger can become another report nobody uses. It must be wired into action admission, not just displayed.
- Strict provider metadata requirements will initially hold capital more often. That is acceptable because source-bound
  evidence is a prerequisite for controlled widening.
- Query timeout treatment can be too conservative during transient DB pressure. The fallback is observe-only and repair,
  not live capital.
- Post-cost edge estimates can be noisy. Early gates must use paper windows and bounded notional until the metric proves
  it is predictive.

## Handoff Contract

Engineer acceptance:

- Wrapper success with empty market-context evidence creates `repair_only` escrow.
- Missing repository metadata in provider payloads blocks capital and emits a specific repair dividend.
- Open critical quant lag alerts hold paper/live capital and leave observe-only available.
- Timeout handling preserves the primary provider failure instead of replacing it with a secondary bytes/string error.

Deployer acceptance:

- Shadow receipts are visible before any order-admission gate is enabled.
- Repair-hold, paper-gate, and live-gate are enabled as separate releases.
- Live micro-canary requires a fresh escrow receipt, positive paper evidence, and no open critical quant lag.
- Rollback returns to observe-only or repair-only without deleting receipt history.
