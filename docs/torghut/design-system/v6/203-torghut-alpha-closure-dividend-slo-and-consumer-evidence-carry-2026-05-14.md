# 203. Torghut Alpha Closure Dividend SLO And Consumer Evidence Carry (2026-05-14)

Status: Accepted for engineer and deployer handoff

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

I am selecting an **alpha closure dividend SLO with consumer-evidence carry** as the next Torghut architecture
increment.

The current business evidence is specific. On 2026-05-14, `/trading/revenue-repair` returned
`business_state=repair_only`, `revenue_ready=false`, queue count 5, top queue item `repair_alpha_readiness`, value
gate `routeable_candidate_count`, required output `torghut.executable-alpha-receipts.v1`, and `max_notional=0`.
Torghut also emitted a selected alpha closure board and settlement market for `H-MICRO-01`, with repair class
`feature_replay_closure`, required settlement receipt `torghut.alpha-closure-settlement-receipt.v1`, and a consumed
no-delta budget.

That is the right strategic priority. The blocker is no longer "find any repair." The blocker is "settle whether the
current alpha closure moved the value gate, and carry that result to Jangar before another runner starts." The pending
settlement receipt preserved `drift_checks_missing`, `feature_rows_missing`, `required_feature_set_unavailable`, and
`closed_session_signal_hold`; measured routeable candidate delta stayed `0`; the next allowed attempt was
`2026-05-14T04:53:40.994334+00:00`.

Torghut already exports a compact `torghut.alpha-repair-closure-board-ref.v1` through `/trading/consumer-evidence`.
That is useful, but it is still a board ref, not a dividend SLO. Jangar needs to know whether the last closure attempt
paid a value-gate dividend, produced no-delta debt, or is eligible for a new zero-notional repair slot. Torghut should
own that answer because it owns the trading hypothesis, the routeable candidate count, and the capital safety rules.

The selected design adds a compact `torghut.alpha-closure-dividend-slo.v1` carry object to consumer evidence. It
summarizes the current closure board, settlement market, before/after value-gate counts, preserved and retired blocker
codes, no-delta release conditions, next allowed attempt, validation commands, and zero-notional capital rule. Jangar
uses it as launch custody; Torghut keeps full strategy details on `/trading/revenue-repair`.

The tradeoff is one more compatibility object. I accept it because the alternative is repeated no-delta work. A
dividend SLO forces every alpha closure run to answer whether it improved `routeable_candidate_count`, and it gives
Jangar a compact reason to hold when the answer is no.

## Governing Runtime Requirements

This contract follows the active validation requirements:

- every run must cite the governing Torghut design or runtime requirement before changing code;
- implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety;
- verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or
  evidence status after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

Torghut value-gate mapping:

- `routeable_candidate_count`: primary dividend. A closure succeeds only when at least one selected hypothesis becomes
  routeable or the receipt records why the count stayed zero.
- `zero_notional_or_stale_evidence_rate`: no-delta receipts become active debt until the release key changes.
- `fill_tca_or_slippage_quality`: route TCA remains a graduation guardrail; no closure can promote a route with
  stale or failing slippage evidence.
- `post_cost_daily_net_pnl`: post-cost expectancy remains a blocker for H-CONT-01 and H-REV-01, not a reason to spend
  the H-MICRO-01 feature replay slot.
- `capital_gate_safety`: live submit remains disabled, capital stage remains shadow, and every dividend object carries
  `max_notional=0`.

Jangar value-gate mapping:

- `failed_agentrun_rate`: consumed no-delta debt gives Jangar a pre-launch denial reason.
- `pr_to_rollout_latency`: deployers can validate the same compact dividend SLO Jangar consumes.
- `ready_status_truth`: repair-only business state remains distinct from material launch authority.
- `manual_intervention_count`: operators do not compare full payloads by hand to know whether the closure paid.
- `handoff_evidence_quality`: every handoff cites the SLO id, board id, market id, selected hypothesis, measured
  delta, no-delta state, and rollback target.

## Current Evidence

All evidence was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database rows, trading
flags, broker state, GitOps resources, AgentRuns, or market data.

### Cluster And Serving Evidence

- Argo applications `agents`, `jangar`, and `torghut` were `Synced/Healthy` at
  `60ea7ce8935a77676696b415bcd16fddbedd0575`.
- Torghut live revision `torghut-00377` and sim revision `torghut-sim-00475` were running with `2/2` containers ready.
- Postgres `torghut-db-1`, ClickHouse, Keeper, TA, TA sim, options services, WebSocket services, and guardrail
  exporters were running.
- Jangar `/ready` returned `status=ok`, but kept the business state `repair_only` and revenue not ready.
- Agents namespace runner debt remained material: since `2026-05-14T00:00:00Z`, pod-level evidence showed 72 failed
  pods and 4 OOMKilled terminations, while Torghut quant AgentRuns had implement and verify `BackoffLimitExceeded`
  failures.

### Database And Data Quality

- Direct CNPG cluster reads and pod exec were forbidden to the service account. The accepted read path for this lane is
  application-level database witnesses.
- `GET /db-check` returned current head `0031_autoresearch_candidate_spec_epoch_uniqueness`, one schema graph branch,
  no missing heads, no unexpected heads, and no lineage errors.
- Known parent-fork warnings remain under `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`; they do not block the current schema head.
- `GET /readyz` returned HTTP 503 with `status=degraded`, which is correct while the live submission gate is closed
  and alpha readiness has zero promotion-eligible hypotheses.
- The readiness summary reported three alpha hypotheses, one blocked lane, two shadow lanes, zero promotion-eligible
  lanes, and two rollback-required lanes.

### Revenue Repair And Closure Evidence

- `/trading/revenue-repair` returned `business_state=repair_only`, `revenue_ready=false`, and top queue item
  `repair_alpha_readiness`.
- The top item cited reason `hypothesis_not_promotion_eligible`, value gate `routeable_candidate_count`, expected
  unblock value `4`, required output `torghut.executable-alpha-receipts.v1`, and `max_notional=0`.
- The full alpha repair closure board was selected with board id
  `alpha-repair-closure-board:a99bea7acfa184abcd5d297c` and value gate `routeable_candidate_count`.
- The settlement market was `alpha-closure-settlement-market:89e028004ab04284dd5c7cac`, status `pending_no_delta`,
  selected hypothesis `H-MICRO-01`, selected repair class `feature_replay_closure`, and required output
  `torghut.alpha-closure-settlement-receipt.v1`.
- The no-delta budget had `used_attempts=1`, `remaining_attempts=0`, and state `consumed`.
- The pending settlement receipt preserved `drift_checks_missing`, `feature_rows_missing`,
  `required_feature_set_unavailable`, and `closed_session_signal_hold`; measured delta was `0`;
  routeable candidate count stayed `0`.
- `/trading/consumer-evidence` exposed compact `torghut.alpha-repair-closure-board-ref.v1` with selected hypothesis
  `H-MICRO-01`, active dedupe key `26ad0e6f5062ffa349b21e8a`, no-delta state `consumed`, no-delta debt count `1`,
  and `max_notional=0`.
- Jangar `/ready` did not yet carry that compact board ref through its Torghut projection.

### Source And Test Surface

- `services/torghut/app/main.py` is 6925 lines and remains the high-risk integration surface for `/readyz`,
  `/trading/status`, `/trading/revenue-repair`, `/trading/consumer-evidence`, and repair execution.
- `services/torghut/app/trading/revenue_repair.py` is 1111 lines and builds the live repair digest.
- `services/torghut/app/trading/alpha_repair_closure_board.py` is 820 lines and owns the selected closure board and
  settlement market.
- `services/torghut/app/trading/alpha_evidence_foundry.py` is 608 lines and owns evidence-window receipts.
- `services/torghut/app/trading/repair_bid_settlement.py` is 716 lines and compacts repair lots.
- Existing tests cover revenue repair, alpha closure board, alpha evidence foundry, repair-bid settlement, and
  executable alpha receipts. The missing test family is dividend SLO carry: paid dividend, no-delta dividend,
  changed release key, stale SLO, nonzero notional, and consumer-evidence projection parity.

## Problem

Torghut can now identify the right closure, but it does not yet expose the closure outcome as a compact SLO that
Jangar can enforce.

The concrete failure modes are:

1. A selected board ref can be current while the actual closure has produced no-delta debt.
2. Jangar can see a dispatchable promotion-custody lot without seeing the settlement receipt that preserved the same
   blockers and left routeable candidate count at zero.
3. Operators have to inspect full `/trading/revenue-repair` to learn whether the closure attempt paid a dividend.
4. A no-delta repair can restart when the source, evidence window, blocker set, and required receipt set have not
   changed.
5. H-MICRO-01 is the only lineage-ready path, but the live status still needs to preserve H-CONT-01 and H-REV-01
   blockers without allowing them to steal the first feature replay slot.
6. `/readyz` degradation can be misread as a live-submit problem. The actual next revenue action is alpha closure
   settlement under zero notional.

Torghut needs to convert closure outcomes into a compact dividend SLO and carry it through consumer evidence.

## Alternatives Considered

### Option A: Keep Only The Current Board Ref

Torghut would leave `/trading/consumer-evidence` as-is, carrying the compact alpha repair closure board ref but no
separate dividend SLO.

Advantages:

- No new schema.
- Jangar can still see board id, market id, selected hypothesis, and no-delta state.
- Full details remain on `/trading/revenue-repair`.

Disadvantages:

- The board ref does not explicitly answer whether the closure paid a value-gate dividend.
- Release conditions and next allowed attempt can remain buried in the full endpoint.
- Jangar still has to infer no-delta denial from fields that are not framed as launch custody.
- Deployer proof remains less direct than it should be.

Decision: reject.

### Option B: Copy The Full Settlement Receipt Into Consumer Evidence

Torghut would mirror the pending or terminal settlement receipt into `/trading/consumer-evidence`.

Advantages:

- Jangar has all details.
- No separate summary logic is needed.
- Debugging is straightforward.

Disadvantages:

- Payload size and volatility increase.
- Strategy details leak across the launch boundary.
- Schema changes in the full settlement receipt can break Jangar admission.
- The main signal, value-gate dividend or no-delta debt, is not isolated.

Decision: reject.

### Option C: Add A Compact Alpha Closure Dividend SLO

Torghut keeps the full board and receipt on `/trading/revenue-repair`, then exports a compact dividend SLO on
consumer evidence.

Advantages:

- Makes routeable candidate delta first-class.
- Carries no-delta release conditions to Jangar.
- Keeps capital safety explicit.
- Gives deployers a small proof object.
- Lets Torghut evolve full strategy details without destabilizing Jangar launch custody.

Disadvantages:

- Adds compatibility tests.
- Requires parity checks between full revenue repair and consumer evidence.
- Can hold launches when the SLO is stale even if the full endpoint is healthy.

Decision: select Option C.

## Architecture

Torghut emits `torghut.alpha-closure-dividend-slo.v1` inside `/trading/consumer-evidence`.

```text
torghut.alpha-closure-dividend-slo.v1
  slo_id
  generated_at
  fresh_until
  source_revenue_repair_ref
  source_board_ref
  source_settlement_market_ref
  selected_hypothesis_id
  selected_value_gate
  selected_repair_class
  required_settlement_receipt
  active_dedupe_key
  routeable_candidate_count_before
  routeable_candidate_count_after
  measured_delta
  dividend_state: paid | no_delta | pending | stale | invalid
  retired_reason_codes[]
  preserved_reason_codes[]
  introduced_reason_codes[]
  no_delta_budget_state
  no_delta_debt_count
  release_conditions[]
  next_allowed_attempt_after
  validation_commands[]
  max_notional
  capital_rule
  rollback_target
```

Rules:

- `paid` requires a positive `routeable_candidate_count` delta or a terminal receipt that retires the selected
  promotion blocker.
- `no_delta` requires a terminal or pending settlement receipt with measured delta `0` and preserved blockers.
- `pending` is allowed only before the first settlement attempt in the current release key.
- `stale` applies when the SLO is past `fresh_until` or source refs disagree with the current revenue repair digest.
- `invalid` applies when notional is nonzero, capital rule is not zero-notional repair only, or required refs are
  missing.
- The SLO never enables paper or live submission. It only governs Jangar zero-notional runner custody.

The release key is:

```text
account_id + window + selected_hypothesis_id + selected_value_gate
  + active_dedupe_key + blocker_digest + source_revenue_repair_ref
  + required_settlement_receipt
```

A new zero-notional runner is eligible only when one of the release conditions changes: evidence window, blocker set,
source ref, required receipt set, or terminal settlement outcome.

## Validation Plan

Engineer stage must add focused tests:

- Revenue repair builds a dividend SLO when the closure market has a pending no-delta settlement.
- Consumer evidence carries the same SLO id, board id, market id, selected hypothesis, value gate, and notional as the
  full revenue-repair endpoint.
- No-delta SLO preserves blocker codes and exposes `next_allowed_attempt_after`.
- Paid SLO records a positive routeable candidate delta or a retired promotion blocker.
- Stale or invalid SLOs do not claim launch eligibility.
- Nonzero notional or nonzero capital rule makes the SLO invalid.

Targeted commands for the implementation PR:

- `uv run --frozen pytest services/torghut/tests/test_trading_api.py -k consumer_evidence`
- `uv run --frozen pytest services/torghut/tests/test_build_revenue_repair_digest.py -k alpha`
- `uv run --frozen pytest services/torghut/tests/test_alpha_repair_closure_board.py`
- `uv run --frozen pyright --project pyrightconfig.json`

Deployer validation:

- `GET /trading/revenue-repair` includes the full board, settlement market, and pending or terminal receipt.
- `GET /trading/consumer-evidence` includes `alpha_closure_dividend_slo`.
- `GET /db-check` remains schema-current.
- `/readyz` may remain HTTP 503 while live submission and proof floor stay intentionally closed.
- `max_notional=0` and live submission disabled remain true.
- Jangar `/ready` material gate digest carries the SLO and holds duplicate repair launch while no-delta is active.

## Rollout

Phase 0 emits the SLO in shadow on `/trading/consumer-evidence` and compares it with the full revenue-repair board.

Phase 1 marks stale or invalid SLOs as launch-ineligible while leaving existing repair endpoints unchanged.

Phase 2 lets Jangar use the SLO to hold duplicate no-delta launch keys. Torghut remains the source of truth for
selected hypothesis, routeable candidate delta, and capital rule.

Phase 3 records paid dividend receipts as routeable candidate reentry evidence. This phase does not open paper or live
capital; it only allows the next promotion and proof gates to evaluate with fresher evidence.

## Rollback

- Disable `alpha_closure_dividend_slo` emission or mark it `stale`.
- Keep the full alpha closure board, evidence foundry, repair-bid settlement, and revenue-repair digest active.
- Keep live submission disabled and `max_notional=0`.
- Preserve no-delta and settlement receipts for audit.
- Jangar falls back to holding `dispatch_repair` when the SLO is missing.
- Do not delete database rows, market evidence, AgentRuns, jobs, or no-delta receipts.

## Risks

- The SLO could disagree with the full board. Mitigation: shadow parity tests and source ref equality.
- The SLO could over-hold fresh repair if `fresh_until` is too short. Mitigation: align freshness with the closure
  market and emit explicit `slo_stale`.
- Operators could treat a paid zero-notional dividend as capital authority. Mitigation: repeat `max_notional=0`,
  `capital_rule=zero_notional_repair_only`, and live-submit disabled on every SLO.
- A dividend SLO does not itself fix H-MICRO-01 feature evidence. Mitigation: acceptance requires routeable candidate
  delta or a terminal no-delta reason, not just SLO presence.

## Engineer And Deployer Handoff

Next engineer milestone: add `alpha_closure_dividend_slo` to Torghut consumer evidence and teach Jangar's material
gate digest to carry it. The first implementation should be observe-only and must keep capital at zero.

Acceptance gates:

- `/trading/consumer-evidence` includes the dividend SLO.
- The SLO reports current live evidence as `no_delta` or `pending` with the selected H-MICRO-01 closure.
- Jangar `/ready` carries the SLO through `material_gate_digest`.
- Current consumed no-delta state holds duplicate `dispatch_repair`.
- Tests cover paid, no-delta, stale, invalid, nonzero notional, and parity cases.

Next deployer milestone: after implementation, verify Argo health, Torghut `/db-check`, Torghut consumer-evidence SLO,
Jangar `/ready` material digest, and zero-notional capital safety. The revenue metric targeted is
`routeable_candidate_count`; the smallest blocker remains H-MICRO-01 feature replay settlement until a terminal receipt
retires `feature_rows_missing`, `required_feature_set_unavailable`, and `drift_checks_missing`.
