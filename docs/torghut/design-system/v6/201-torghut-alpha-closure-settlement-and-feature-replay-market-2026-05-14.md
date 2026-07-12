# 201. Torghut Alpha Closure Settlement And Feature Replay Market (2026-05-14)

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

I am selecting an **alpha closure settlement and feature replay market** as the next Torghut quant architecture
increment.

The live business surface is explicit and still capital-safe. On 2026-05-14 at 00:27 UTC,
`GET /trading/revenue-repair` returned `business_state=repair_only`, `revenue_ready=false`,
`routeable_candidate_count=0`, `max_notional=0`, and `capital_rule=zero_notional_repair_only`. The top queue item
remained `repair_alpha_readiness` for `hypothesis_not_promotion_eligible`, value gate
`routeable_candidate_count`, expected unblock value `4`, and required output receipt
`torghut.executable-alpha-receipts.v1`.

The prior design correctly chose an `alpha_repair_closure_board`, but the current source tree does not implement
`alpha_repair_closure_board` yet. It does implement `alpha_readiness_strike_ledger`,
`executable_alpha_repair_receipts`, `repair_bid_settlement_ledger`, and `repair_outcome_dividend_ledger`. Jangar also
sees Torghut consumer evidence as current and sees three dispatchable compacted repair lots:
`quant_pipeline`, `promotion_custody`, and `feature_lineage`. The open problem is no longer "can we rank promotion
custody ahead of static repair lots"; that is now true. The open problem is "which concrete alpha closure should get
the next zero-notional runner and what proves it changed the blocker set."

I am choosing the feature-replay lane for `H-MICRO-01` as the first closure market product. It is the only active
hypothesis with strategy lineage ready. It is blocked by `drift_checks_missing`, `feature_rows_missing`, and
`required_feature_set_unavailable`; those map to a bounded feature replay and evidence-window refresh. `H-CONT-01` and
`H-REV-01` remain shadow lanes with non-positive post-cost expectancy and missing strategy lineage, so they should not
consume the first closure slot unless the feature-replay closure produces no-delta debt or the live queue changes.

The tradeoff is that we do not try to clear every reason code in one implementation. We leave execution TCA, rollout
image proof, and live submit gate work behind the alpha closure lane. That is deliberate. Moving
`routeable_candidate_count` from zero requires one hypothesis to become a paper replay candidate with fresh feature
evidence and a settled promotion receipt; clearing lower-priority evidence while that count stays zero does not improve
the business metric.

## Governing Runtime Requirements

This contract follows the active Torghut quant validation contract:

- every run must cite the governing Torghut design or runtime requirement before changing code;
- implement stages must produce production PRs that improve readiness, profit evidence, data freshness, execution
  quality, or capital safety;
- verify stages must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or
  evidence status after rollout;
- final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

The value-gate mapping is direct:

- `routeable_candidate_count`: primary gate. The first closure must try to move `H-MICRO-01` from blocked
  feature-evidence state toward paper replay candidate evidence.
- `zero_notional_or_stale_evidence_rate`: feature replay must retire stale or missing feature evidence, or record
  no-delta debt with the exact preserved blockers.
- `fill_tca_or_slippage_quality`: the closure cannot graduate if route TCA remains outside the guardrail for the
  selected symbol path.
- `post_cost_daily_net_pnl`: the closure must bind to post-cost evidence or deny promotion with the measured
  expectancy blocker.
- `capital_gate_safety`: live submit remains disabled, capital stage remains shadow, and every repair object keeps
  `max_notional=0`.

## Current Evidence

Evidence was collected read-only on 2026-05-14. I did not mutate Kubernetes resources, database rows, trading flags,
broker state, GitOps resources, AgentRuns, or market data.

### Cluster And Rollout

- Working branch: `codex/swarm-torghut-quant-plan`, based on `main` at
  `c7f5dbf3284448e930addb5e7682eb105b250046`.
- Torghut live revision `torghut-00371` and sim revision `torghut-sim-00469` were both `2/2 Running`.
- Serving build commit was `8d84f9f5ce028214bfb5326e0791638bc35625f5`; serving image digest was
  `sha256:8d3a43bed9c6da942827c5e25f40fc88d1b0712a99a172831da222eebc820c4d`.
- Postgres `torghut-db-1`, ClickHouse, Keeper, TA, TA sim, options catalog, options enricher, WebSocket services,
  and guardrail exporters were running.
- Recent rollout events showed expected Knative startup/readiness probe noise for new revisions, followed by
  `RevisionReady` for `torghut-00371` and `torghut-sim-00469`.
- The cluster still has operational noise: many `torghut-whitepaper-autoresearch-profit-target-*` pods are failed
  while one current instance is running. That is not the current revenue blocker, but it reinforces why repair launches
  need no-delta accounting and bounded retry slots.
- Jangar was serving `/ready` with `status=ok`; leader election was active; execution trust was healthy; agents and
  agents-controllers deployments were available.

### Database And Data

- `GET /db-check` returned `ok=true`, `schema_current=true`, current and expected head
  `0031_autoresearch_candidate_spec_epoch_uniqueness`, one schema graph branch, lineage ready, no missing heads, and no
  unexpected heads.
- The known historical parent-fork warnings remain under `0010_execution_provenance_and_governance_trace` and
  `0015_whitepaper_workflow_tables`.
- Direct database introspection is intentionally unavailable to this worker: CNPG cluster listing, secret listing, and
  pod exec into `torghut-db-1` were denied by RBAC. The accepted read path for this lane is Torghut's application
  database witness plus trading evidence endpoints.
- `/readyz` returned HTTP 503 with `status=degraded`, while Postgres, ClickHouse, Alpaca, database schema, universe,
  empirical jobs, DSPy runtime, and optional quant evidence were healthy or acceptable.
- The readiness failures were exactly the expected capital blockers: `live_submission_gate=simple_submit_disabled` and
  `profitability_proof_floor=repair_only`.
- Alpha readiness had three hypotheses, zero promotion-eligible hypotheses, and two rollback-required shadow lanes.

### Source And Test Surface

- `services/torghut/app/trading/revenue_repair.py` is 1036 lines and builds the business digest, queue, summaries,
  strike ledger, and executable alpha repair receipts.
- `services/torghut/app/trading/executable_alpha_receipts.py` is 1146 lines and already maps feature, drift, lineage,
  autoresearch, equity TA, rejection-drag, and promotion blockers into repair receipt classes.
- `services/torghut/app/trading/repair_bid_settlement.py` is 716 lines and now reserves alpha readiness strike capacity
  by ranking `promotion_custody` at priority `98`.
- `services/torghut/app/trading/repair_outcome_dividend.py` is 524 lines and already tracks open escrows, preserved
  reason codes, and no-delta outcomes for selected repair lots.
- `services/torghut/app/main.py` is 6869 lines and is the high-risk integration surface for `/readyz`,
  `/trading/revenue-repair`, `/trading/consumer-evidence`, and the zero-notional repair endpoint.
- Jangar consumer evidence and repair admission are covered by focused tests, but there is no implemented reducer named
  `alpha_repair_closure_board` and no test that selects `H-MICRO-01` as the first feature-replay closure when the live
  revenue queue is topped by alpha readiness.

### Trading Evidence

- `/trading/revenue-repair` had `business_state=repair_only`, `revenue_ready=false`, `readyz_status=degraded`, and
  active revision `torghut-00371`.
- Capital stayed closed: `live_submission_allowed=false`, `live_submission_reason=simple_submit_disabled`,
  `capital_stage=shadow`, `proof_floor_state=repair_only`, `capital_state=zero_notional`, and `max_notional=0`.
- Top queue item:
  - `code=repair_alpha_readiness`
  - `reason=hypothesis_not_promotion_eligible`
  - `value_gate=routeable_candidate_count`
  - `expected_unblock_value=4`
  - `required_output_receipt=torghut.executable-alpha-receipts.v1`
  - `required_receipts=alpha_readiness_receipt,hypothesis_promotion_receipt,capital_replay_board`
- Second queue item:
  - `code=live_submit_gate_closed`
  - `reason=simple_submit_disabled`
  - `value_gate=capital_gate_safety`
  - `required_output_receipt=torghut.capital-hold-repair-receipt.v1`
- Routeability acceptance was blocked with `accepted_routeable_candidate_count=0` and
  `zero_notional_or_stale_evidence_rate=1.0`.
- Repair-bid settlement had `33` raw bids, `6` compacted lots, `5` selected lots, `3` dispatchable lots, and
  `routeable_candidate_count=0`.
- Jangar saw dispatchable lots for `quant_pipeline`, `promotion_custody`, and `feature_lineage`. The selected but held
  lots were execution TCA and rollout image proof; empirical replay was held by selection limit.
- Execution TCA had `7334` orders and `7245` filled executions. It was fresh enough for the one-day threshold but the
  latest execution sample was from 2026-04-02. Average absolute slippage was `13.82` bps against an `8` bps guardrail.
  AAPL had route evidence, AMD/AVGO/INTC/NVDA were blocked, and AMZN/GOOGL/ORCL were missing symbol TCA.
- Route reacquisition had `routeable_symbol_count=0`, `probing_symbol_count=1`, `blocked_symbol_count=4`,
  `missing_symbol_count=3`, candidate symbol `AAPL`, and expected unblock value `14`.

## Problem

Torghut has moved past broad advisory evidence. It can now name the revenue blocker and expose dispatchable zero-notion
repair lots. The missing system property is closure settlement: a repair attempt must either move a named alpha lane
toward routeable-candidate admission or create no-delta debt that prevents repeated launches against the same evidence
window.

The concrete failure modes are:

1. `promotion_custody` can be dispatchable, but no closure object says which hypothesis is first and why.
2. The live queue says alpha readiness, but `quant_pipeline`, `promotion_custody`, and `feature_lineage` are all
   dispatchable, so worker selection can still drift without a market-clearing rule.
3. `H-MICRO-01` is lineage-ready and blocked by feature evidence, while `H-CONT-01` and `H-REV-01` carry missing
   lineage and non-positive expectancy; the payload does not yet make that priority explicit.
4. A zero-notional repair can finish without increasing `routeable_candidate_count`, and the system has no required
   no-delta cooldown keyed by hypothesis, evidence window, blocker set, and source revision.
5. `/readyz` is correctly degraded; operators may be tempted to treat that as a submit-gate task instead of an alpha
   closure task.
6. The alpha closure board described in doc 198 is not implemented, so deployer validation cannot yet prove the board
   is live.

The next architecture must turn the current top queue item into a small market: one selected hypothesis, one selected
repair class, one required after receipt, one no-delta budget, and one zero-notional rollback path.

## Alternatives Considered

### Option A: Build The Full Alpha Repair Closure Board First

This option implements doc 198 exactly before choosing any hypothesis-specific closure policy.

Advantages:

- It follows the current accepted design.
- It gives Jangar the compact board it already expects.
- It avoids adding another contract before implementation.

Disadvantages:

- It does not answer which closure receives the first runner slot when several lots are dispatchable.
- It can become a board-shaped summary of existing ambiguity.
- It does not force a no-delta cooldown keyed to a specific hypothesis and repair class.

Decision: reject as the complete next step. Keep it as M1, but add the settlement market rules now so the board has a
deterministic first product.

### Option B: Clear Execution TCA And Route Coverage Before Alpha Closure

This option spends the next zero-notional slots on execution TCA, missing symbols, and route evidence because those
gates are real and measurable.

Advantages:

- It improves `fill_tca_or_slippage_quality`.
- It has clear symbol-level work: AAPL probing, four blocked symbols, and three missing symbols.
- It reduces risk before any paper candidate is admitted.

Disadvantages:

- It is not the current top `/trading/revenue-repair` queue item.
- It can leave `promotion_eligible_total=0` and `routeable_candidate_count=0`.
- It spends repair capacity on downstream guardrails before a hypothesis can consume the repaired route evidence.

Decision: reject as the first closure product. TCA remains a required graduation gate, not the lead item.

### Option C: Feature Replay Closure Market For H-MICRO-01

This option implements the closure board with a first market product that selects `H-MICRO-01`, the lineage-ready
microstructure lane, and funds a zero-notional feature replay plus evidence-window refresh.

Advantages:

- It targets the top revenue queue item and the primary value gate.
- It uses the only active lane with ready strategy lineage.
- It has concrete blockers: drift checks missing, feature rows missing, and required feature set unavailable.
- It can settle as improved, retired, or no-delta without enabling capital.
- It lets Jangar deny duplicate launches until evidence window, blocker set, source ref, or required receipt changes.

Disadvantages:

- It may not improve post-cost expectancy in the same PR.
- It intentionally delays execution TCA and route-coverage work unless the closure produces after-receipts.
- It requires a new reducer and tests around selection, no-delta debt, and board freshness.

Decision: select Option C.

## Architecture

Torghut publishes `alpha_closure_settlement_market` as part of the new `alpha_repair_closure_board`. The market is a
read-model first. It does not submit orders, does not change capital flags, and does not mutate repair records.

```text
alpha_closure_settlement_market
  schema_version = torghut.alpha-closure-settlement-market.v1
  market_id
  generated_at
  fresh_until
  source_revenue_repair_ref
  source_repair_bid_settlement_ref
  source_repair_outcome_dividend_ref
  account_id
  window
  selected_value_gate = routeable_candidate_count
  selected_hypothesis_id = H-MICRO-01
  selected_repair_class = feature_replay_closure
  selected_lot_class = promotion_custody | feature_lineage
  required_output_receipt = torghut.alpha-closure-settlement-receipt.v1
  required_after_receipts[]
  before_blocker_codes[]
  no_delta_budget
  active_dedupe_key
  max_notional = 0
  capital_rule = zero_notional_repair_only
  rollback_target
```

The selected closure receipt:

```text
alpha_closure_settlement_receipt
  schema_version = torghut.alpha-closure-settlement-receipt.v1
  receipt_id
  market_id
  hypothesis_id
  candidate_id
  strategy_id
  repair_class
  before_refs[]
  after_refs[]
  retired_reason_codes[]
  preserved_reason_codes[]
  introduced_reason_codes[]
  measured_delta
  routeable_candidate_count_before
  routeable_candidate_count_after
  promotion_eligible_before
  promotion_eligible_after
  no_delta_reason
  next_allowed_attempt_after
  validation_commands[]
  max_notional = 0
```

Selection rules:

1. The live revenue-repair top item must be `repair_alpha_readiness`.
2. `/db-check` must be schema-current.
3. `capital.max_notional` and all selected lots must be zero.
4. Live submission must remain disabled.
5. A hypothesis with ready lineage and feature evidence blockers outranks lanes with missing lineage or non-positive
   expectancy when the selected value gate is `routeable_candidate_count`.
6. The first selected lane is `H-MICRO-01` while its blockers remain `drift_checks_missing`,
   `feature_rows_missing`, or `required_feature_set_unavailable`.
7. `promotion_custody` and `feature_lineage` can both feed the closure, but only one market slot is admitted until the
   receipt settles.
8. A no-delta outcome consumes the active dedupe key until source revision, evidence window, blocker set, or required
   receipt changes.

Graduation rules:

- `improved`: at least one selected blocker retires, or `promotion_eligible_total` increases, while
  `max_notional=0`.
- `retired`: `repair_alpha_readiness` is no longer the top queue item or `routeable_candidate_count` increases above
  zero.
- `no_delta`: validation ran, but the same selected blockers remain.
- `invalidated`: schema, source, or capital safety precondition changed before settlement.
- `blocked`: any object requests nonzero notional or live submission.

## Implementation Scope

M1: Implement `build_alpha_repair_closure_board()`.

- Inputs: revenue repair digest fields, repair-bid settlement, repair-outcome dividend ledger, executable alpha repair
  receipts, `/db-check` summary, serving build metadata, and current time.
- Outputs: `alpha_repair_closure_board` with nested `alpha_closure_settlement_market`.
- Tests: top queue selection, schema-current requirement, zero-notional rule, H-MICRO-01 priority, stale board, and
  no-delta cooldown.
- Value gates: `routeable_candidate_count`, `zero_notional_or_stale_evidence_rate`, `capital_gate_safety`.

M2: Expose the board on `/trading/revenue-repair`.

- Keep it additive.
- Do not change `/readyz` status.
- Do not change live submission or notional.
- Tests: `/trading/revenue-repair` contains board id, selected hypothesis, selected value gate, and no-delta budget.

M3: Mirror compact board refs on `/trading/consumer-evidence`.

- Jangar needs `board_id`, `market_id`, selected hypothesis, selected repair class, required receipt, dedupe key, and
  no-delta state.
- Tests: Jangar consumer evidence parser accepts the compact refs and denies nonzero notional.

M4: Add the zero-notional feature replay receipt.

- Run only from the repair endpoint or a worker path that writes a receipt, not from readiness generation.
- Required validations:
  - feature rows were regenerated or explicitly still missing;
  - drift checks were executed or explicitly still missing;
  - required feature set availability changed or stayed missing;
  - routeable candidate and promotion-eligible counts are captured before and after;
  - capital remains zero.

M5: Add Jangar slot-governor enforcement.

- Jangar admits one alpha closure slot only when the compact board is current and dedupe is clear.
- Jangar denies duplicate no-delta launches until the board's evidence key changes.

## Validation Gates

Architecture PR validation:

- `bunx oxfmt --check docs/agents/designs/196-jangar-alpha-closure-slot-governor-and-no-delta-budget-2026-05-14.md docs/torghut/design-system/v6/201-torghut-alpha-closure-settlement-and-feature-replay-market-2026-05-14.md docs/agents/release-handoffs/torghut-alpha-closure-settlement-2026-05-14.md docs/agents/README.md docs/torghut/design-system/v6/index.md`
- `git diff --check`

Engineer validation:

- `cd services/torghut && uv run --frozen pytest tests/test_build_revenue_repair_digest.py -k alpha_repair_closure`
- `cd services/torghut && uv run --frozen pytest tests/test_executable_alpha_repair_receipts.py -k feature`
- `cd services/torghut && uv run --frozen pytest tests/test_trading_api.py -k revenue_repair`
- `cd services/torghut && uv run --frozen ruff check app/trading tests/test_build_revenue_repair_digest.py tests/test_trading_api.py`
- If Jangar parser changes are included:
  `bun run --filter jangar test -- src/server/__tests__/control-plane-torghut-consumer-evidence.test.ts src/server/__tests__/control-plane-repair-bid-admission.test.ts`

Deployer validation:

- Argo `torghut`, `jangar`, and `agents` are `Synced/Healthy`.
- Torghut live and sim revisions are ready.
- `GET /db-check` remains schema-current.
- `GET /trading/revenue-repair` includes `alpha_repair_closure_board.alpha_closure_settlement_market`.
- `GET /trading/consumer-evidence` includes compact alpha closure refs.
- `GET /readyz` may remain HTTP 503 while `simple_submit_disabled` and proof-floor repair-only remain active.
- `max_notional=0`, `live_submission_allowed=false`, and `capital_stage=shadow` remain true after rollout.

## Rollout

Phase 0 merges this design and the Jangar companion.

Phase 1 implements the pure builder and tests. The builder is not exposed outside test fixtures yet.

Phase 2 exposes the board on `/trading/revenue-repair`.

Phase 3 mirrors compact refs to `/trading/consumer-evidence`.

Phase 4 lets Jangar reserve one zero-notional closure slot for `H-MICRO-01` feature replay.

Phase 5 evaluates the receipt. If improved or retired, the next market can select route TCA or post-cost replay. If
no-delta, the dedupe key blocks a repeat until source or evidence changes.

No phase enables paper or live notional. Paper/live canary gates remain independent and must prove profit, route TCA,
source-serving convergence, and capital safety before they open.

## Rollback

Rollback is additive and safe:

- disable board emission or omit `alpha_repair_closure_board` from `/trading/revenue-repair`;
- keep existing revenue repair, repair-bid settlement, executable alpha receipts, and repair outcome dividend payloads;
- keep live submission disabled and max notional `0`;
- keep Jangar fallback on repair-bid settlement and alpha readiness strike ledger;
- preserve emitted closure receipts for audit, but ignore them for admission;
- do not delete database rows, AgentRuns, jobs, or trading evidence.

## Risks

- The first closure may retire feature blockers but leave post-cost expectancy negative. That is acceptable only if the
  receipt records the preserved expectancy blocker.
- The closure board may duplicate fields already carried by executable alpha repair receipts. Keep the board compact
  and use refs instead of copying full payloads into Jangar status.
- A no-delta cooldown can block a legitimate retry after fresh data arrives. The dedupe key must include source
  revision, evidence window, blocker set, and required receipt ids.
- Route TCA can remain above guardrail after feature replay. Graduation to paper candidate must still require TCA
  evidence.
- Direct DB introspection is not available to workers under current RBAC. Implementation must continue to cite
  `/db-check` and application-level data witnesses.

## Handoff

Engineer: implement M1 and M2 first. The smallest production PR is a pure `alpha_repair_closure_board` builder,
tests, and additive `/trading/revenue-repair` exposure. It must select `H-MICRO-01` while the current blocker set
persists, carry `max_notional=0`, and produce no-delta debt keys without enabling live submit.

Deployer: validate that the board is visible and capital remains closed. A successful rollout does not mean Torghut is
revenue-ready; it means the next zero-notional repair can be admitted and audited.

Revenue metric: this targets `routeable_candidate_count`. The smallest blocker preventing immediate revenue impact is
`hypothesis_not_promotion_eligible` with feature rows, drift checks, and required feature set evidence missing on
the lineage-ready `H-MICRO-01` lane.
