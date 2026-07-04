# 193. Torghut Repair Outcome Dividend Ledger And Capital Reentry Frontier (2026-05-13)

Status: Accepted for Jangar engineer and deployer handoff

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

I am selecting a **repair outcome dividend ledger** as Torghut's companion contract for Jangar terminal debt compaction.

Torghut now exposes the right admission surface. `/trading/consumer-evidence` returns
`torghut.consumer-evidence-status.v1`, current receipt `torghut-consumer-evidence:9cdb5760d9d786dd`, route warrant
state `repair_only`, and three dispatchable zero-notional lots. Jangar reads that route and can see exact blockers:
`quant_health_not_configured`, `forecast_registry_degraded`, `execution_tca_stale`, `market_context_evidence_missing`,
`research_candidates_empty`, and `simple_submit_disabled`.

The open problem is outcome accounting. A repair lot is only valuable if it retires a reason code, improves a measured
profit-evidence frontier, or proves that the lot produced no delta and should not consume another runner slot. Today the
repair-bid settlement ledger selects compacted lots and Jangar admits bounded dispatch. The next control-plane boundary
is to require each repair lot to return a typed outcome receipt and price it as a dividend against the repair queue.

The tradeoff is that Torghut may show fewer dispatchable lots after this lands. That is intentional. I want fewer repair
runs that merely re-state known blockers and more runs that produce receipts tied to profitability evidence,
routeability, or execution quality. Capital remains closed: `max_notional=0`, active capital stage `shadow`, and
`simple_submit_disabled` stay in force until separate capital proof contracts are satisfied.

## Governing Runtime Requirements

This contract follows the Jangar swarm validation contract:

- every run must cite the governing design or runtime requirement before changing code;
- implement stages must produce production PRs with tests or report the exact blocker to code;
- verify stages must merge only green PRs and prove Argo, workload readiness, and service health after rollout;
- final handoff must name the control-plane metric improved or the smallest blocker preventing improvement.

Torghut value gates for this contract:

- `zero_notional_or_stale_evidence_rate`
- `routeable_candidate_count`
- `fill_tca_or_slippage_quality`
- `post_cost_daily_net_pnl`
- `capital_gate_safety`

## Current Evidence

Evidence was collected read-only on 2026-05-13.

- Argo reported `torghut=Synced/Healthy`.
- Torghut root returned HTTP `200` with version `v0.569.1-187-g0a4ce485e` and commit
  `0a4ce485e3e336468839d3650e8ea1d2145a3779`.
- `/db-check` returned `ok=true`, schema current, current/expected head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, no missing or unexpected heads, lineage ready, and only known
  migration parent-fork warnings.
- `/readyz` and `/trading/health` returned HTTP `503` with `status=degraded`.
- Postgres, ClickHouse, Alpaca, universe, database, empirical jobs, and quant evidence optionality were healthy.
- Live submission was blocked by `simple_submit_disabled`; profitability proof floor was `repair_only`; capital state
  was `zero_notional`; active capital stage was `shadow`.
- `alpha_readiness` showed `3` shadow hypotheses, `0` promotion eligible, and `3` rollback required.
- `/trading/consumer-evidence` returned HTTP `200`, schema `torghut.consumer-evidence-status.v1`, route warrant state
  `repair_only`, and three dispatchable compacted lots:
  `compacted-repair-lot:2edc31d21cbc94fb253b`,
  `compacted-repair-lot:a08351ec1aad00caedd2`, and
  `compacted-repair-lot:9970ac2122ec7b969061`.
- Held lots remained `compacted-repair-lot:ecc587106a0eb9c89326`,
  `compacted-repair-lot:a1d3c14c98322c3d74cb`, and
  `compacted-repair-lot:e94036a15bb8e5741608`.
- Jangar repair-bid admission mirrored those lots and kept material action status `block`.

## Problem

Torghut can now present repair work to Jangar, but it does not yet price whether the work helped.

The concrete failure modes are:

1. A zero-notional repair lot can complete without retiring a reason code.
2. A failed repair AgentRun can be counted as both a control-plane failure and a Torghut blocker without a shared
   settlement record.
3. Repair selection can keep presenting the same lot when no current outcome receipt exists.
4. Capital safety is preserved, but repair throughput can drift away from profit evidence.
5. Jangar deployers cannot tell whether retained failed AgentRuns are old audit debt or failed repair outcomes that
   should block the next dispatch.
6. Trading hypotheses remain shadow-only because the routeability and execution-quality frontier is not tied to repair
   dividends.

## Alternatives Considered

### Option A: Keep Repair Dispatch Selection As The Outcome

This path treats a selected and dispatchable repair lot as sufficient proof that Torghut is moving forward.

Advantages:

- Simple.
- Matches the current repair-bid settlement payload.
- Keeps dispatch volume high.

Disadvantages:

- Does not prove the repair changed a value gate.
- Allows repeated no-delta work.
- Gives Jangar no terminal settlement for failed repair AgentRuns.
- Does not improve promotion eligibility.

Decision: reject. Selection is not an outcome.

### Option B: Require Full Paper-Profit Readiness Before Any More Repair

This path blocks all repair dispatch until Torghut is ready for paper canary.

Advantages:

- Very conservative.
- Avoids wasted runner slots during degraded readiness.
- Keeps capital safety simple.

Disadvantages:

- Blocks the zero-notional work needed to become paper-ready.
- Treats repair-only as deadlock instead of a controlled lane.
- Forces manual exception workflows.

Decision: reject. Torghut needs bounded repair lanes while capital stays closed.

### Option C: Repair Outcome Dividend Ledger

The selected path requires every admitted repair lot to produce an outcome receipt. The receipt prices the lot against a
value gate and tells Jangar whether to release credit, burn credit, roll the lot forward, or hold.

Advantages:

- Keeps repair dispatch zero-notional and measurable.
- Converts failed or no-delta repair runs into explicit terminal debt.
- Lets Jangar active-debt compaction classify old failures accurately.
- Focuses Torghut work on blockers that can improve routeability and profit evidence.

Disadvantages:

- Adds schema and test work to every repair lot class.
- Can reduce apparent repair throughput by refusing lots without measurable outcomes.
- Requires deployers to check one more receipt before widening.

Decision: select Option C.

## Architecture

Torghut emits `repair_outcome_dividend_ledger` from `/trading/consumer-evidence` and, where useful, `/trading/health`
and `/readyz`.

```text
repair_outcome_dividend_ledger
  schema_version = torghut.repair-outcome-dividend-ledger.v1
  generated_at
  fresh_until
  account
  window
  capital_stage = shadow
  max_notional = 0
  ledger_id
  source_repair_bid_settlement_ledger_id
  outcome_receipts[]
  open_escrows[]
  no_delta_lots[]
  retired_reason_codes[]
  preserved_reason_codes[]
  next_repair_frontier
```

Each outcome receipt records:

```text
repair_outcome_receipt
  receipt_id
  repair_lot_id
  dispatch_ticket_id
  launched_agentrun_ref
  lot_class
  value_gate
  expected_reason_code_delta[]
  terminal_state
  receipt_schema
  receipt_ref
  retired_reason_codes[]
  preserved_reason_codes[]
  evidence_before_ref
  evidence_after_ref
  measured_delta
  dividend = positive | zero | negative | invalid
  next_action = release_credit | burn_credit | roll_forward | hold
```

The ledger must be compact. Full details stay in the owning receipt routes, object storage, or Jangar artifacts. The
consumer-evidence route carries enough to make admission decisions without forcing Jangar to query the database.

## Measurable Trading Hypotheses

This contract does not authorize trading. It defines how zero-notional repair work earns the right to ask for paper
evidence later.

### Hypothesis 1: Quant Pipeline Currentness

If the `quant_pipeline` repair lot produces `torghut.quant-pipeline-current-receipt.v1`, then
`quant_health_not_configured` should retire and `zero_notional_or_stale_evidence_rate` should fall for the active
account/window.

Guardrails:

- `max_notional=0`.
- No paper/live promotion from this receipt alone.
- Receipt expires if not refreshed inside the configured freshness window.

### Hypothesis 2: Feature Lineage And Forecast Registry Repair

If the `feature_lineage` repair lot produces `torghut.feature-lineage-current-receipt.v1`, then
`forecast_registry_degraded` and `schema_lineage_missing` should retire or be restated with a smaller blocker.

Guardrails:

- No candidate can become routeable unless the lineage receipt names the dataset snapshot and source commit.
- Any missing dataset snapshot rolls the lot forward as `no_delta`.

### Hypothesis 3: Execution TCA Renewal

If the `execution_tca` repair lot produces `torghut.execution-tca-current-receipt.v1`, then `execution_tca_stale`
should retire and `fill_tca_or_slippage_quality` should move from missing/stale to measured.

Guardrails:

- Expected shortfall samples must be present before any paper-readiness claim.
- Slippage guardrail failures remain blockers and become negative dividends, not promotions.

### Hypothesis 4: Market Context Evidence Renewal

If a later `market_context` lot produces `torghut.market-context-current-receipt.v1`, then
`market_context_evidence_missing` should retire for the symbols in the route universe.

Guardrails:

- Market context receipt must name freshness timestamps per symbol.
- A healthy batch job alone is not enough; the route must show the evidence in consumer evidence.

## Jangar Integration

Jangar consumes the ledger through repair outcome escrow:

- `dispatch_repair` requires an open escrow and expected output receipt.
- Failed repair AgentRuns create active terminal debt until compacted.
- Succeeded repair AgentRuns without a valid outcome receipt create `invalid_receipt` debt.
- No-delta repairs roll forward but reduce future priority unless they identify a smaller blocker.
- Positive dividends can release one additional zero-notional repair lot but never open capital.

## Validation

Local validation for a Torghut implementation PR:

- `pytest services/torghut/tests/test_repair_bid_settlement.py`
- `pytest services/torghut/tests/test_trading_api.py -k consumer_evidence`
- `pytest services/torghut/tests/test_source_serving_repair_receipt.py`
- `ruff check services/torghut`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Production validation after rollout:

- Argo `torghut` is `Synced/Healthy`.
- `/db-check` is schema-current.
- `/trading/consumer-evidence` returns `repair_outcome_dividend_ledger`.
- `max_notional=0`, `capital_stage=shadow`, and live submission remains disabled.
- Every dispatchable repair lot has either an open escrow or a current outcome receipt.
- Jangar control-plane status shows matching repair outcome escrow and terminal debt compaction entries.

## Rollout

1. Add the ledger in observe mode to `/trading/consumer-evidence`.
2. Emit outcome receipts for the three current dispatchable lots: `quant_pipeline`, `feature_lineage`, and
   `execution_tca`.
3. Teach Jangar repair outcome escrow to consume the ledger.
4. Let positive dividends release only one additional zero-notional repair lot per account/window.
5. Consider paper-canary readiness only in a separate PR after routeable candidates, TCA, and profit-window evidence are
   current.

## Rollback

Rollback removes the ledger from Jangar admission and leaves Torghut in its current repair-bid settlement posture:

- Keep `/trading/consumer-evidence` serving route warrants and repair-bid settlement.
- Ignore repair outcome dividends for admission.
- Preserve `max_notional=0`.
- Keep live submission disabled.
- Do not delete outcome receipts; mark the ledger `observe_disabled` if the route cannot keep it current.

## Risks

- Repair outcome receipts can become another stale evidence surface. Mitigation: every receipt has `fresh_until` and
  missing freshness becomes `active` terminal debt in Jangar.
- A no-delta repair could hide a bad hypothesis. Mitigation: no-delta keeps capital closed and lowers priority for the
  same lot unless it names a smaller blocker.
- The ledger can grow large. Mitigation: carry receipts by compact refs and publish only the current account/window
  frontier on consumer evidence.
- Direct database access is unavailable to the current worker role. Mitigation: the route is the supported read-only
  evidence boundary for Jangar.

## Handoff

Engineer next action: implement the observe-mode `repair_outcome_dividend_ledger` and tests for the current
`quant_pipeline`, `feature_lineage`, and `execution_tca` lots.

Deployer next action: after rollout, prove Torghut Argo health, `/db-check`, `/trading/consumer-evidence`,
zero-notional capital safety, and Jangar repair outcome escrow parity before accepting any additional repair dispatch.
