# 192. Torghut Repair Receipt Frontier And Profit Cutover (2026-05-13)

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

I am selecting a **repair receipt frontier with a profit cutover ladder** as Torghut's next architecture step.

The current live system is doing the right safety thing: it is degraded, but it is not taking notional risk. On the
2026-05-13 read-only pass, Torghut `/readyz` and `/trading/health` returned `status=degraded`, while Postgres,
ClickHouse, Alpaca, universe loading, empirical jobs, and schema lineage were healthy. Live submission was disabled
with `simple_submit_disabled`, capital stage was `shadow`, promotion eligible count was zero, and the profitability
proof floor was `repair_only` with capital state `zero_notional`. That is a safe state, not a profitable state.

The problem is that Torghut's repair evidence is not yet organized as a frontier. It names many blockers, but it does
not give Jangar one compact answer to this question: which zero-notional repair receipt would most likely reduce stale
evidence and move the system toward routeable post-cost profit without weakening capital safety? The route evidence
surface reports eight symbols, all zero-notional, with `state_counts` of four blocked, three missing, and one probing.
It names an expected unblock value of `14` and top repair symbols `AAPL`, `AMD`, `AVGO`, `INTC`, and `NVDA`. That is
enough information to build a frontier, but it is not yet a promotion contract.

The selected design turns Torghut repair receipts into frontier lots. Each lot must state the hypothesis, target
symbol or route family, source-serving epoch, expected value-gate delta, cost class, required output receipt, freshness
TTL, and rollback target. Jangar can admit exactly one bounded zero-notional repair at a time from the frontier. Paper
or live capital remains blocked until the frontier produces current source-serving proof, current execution/TCA proof,
current feature rows, and positive post-cost profit evidence.

The tradeoff is slower promotion from repair to paper. I accept that because the goal is profitability with guardrails,
not activity. A repair that does not retire a named blocker should not consume runner capacity or weaken the proof
floor.

## Governing Runtime Requirements

Every Torghut quant run must cite the governing design or runtime requirement before changing code. Implementation
stages must improve readiness, profit evidence, data freshness, execution quality, or capital safety. Verify stages
must merge only green PRs and prove image promotion, Argo sync, live service health, and trading or evidence status
after rollout. Final handoff must name the revenue metric improved or the smallest blocker preventing revenue impact.

This design maps to the required value gates:

- `zero_notional_or_stale_evidence_rate`: every frontier lot must name the stale evidence it retires.
- `routeable_candidate_count`: a repair can graduate only if it creates or refreshes routeable candidates.
- `fill_tca_or_slippage_quality`: execution/TCA receipts must be current before paper canary.
- `post_cost_daily_net_pnl`: promotion requires positive post-cost proof, not just route availability.
- `capital_gate_safety`: `max_notional=0` until the frontier and Jangar material readiness both pass.

## Read-Only Evidence Snapshot

All evidence below was collected read-only on 2026-05-13. I did not mutate Kubernetes resources, database records,
GitOps resources, broker state, trading flags, or data rows.

### Runtime And Cluster

- Argo reported `torghut` `Synced/Healthy` at revision `1feb3fd8b727185dd014ec0f38481d1f2fb4be4b`.
- Torghut core had a current Knative revision `torghut-00339` with one ready pod, and the sim service had
  `torghut-sim-00437` with one ready pod.
- Postgres, ClickHouse, Keeper, TA, TA sim, options catalog, options enricher, WebSocket, and guardrail exporters were
  running.
- A recent Torghut whitepaper autoresearch pod was in `Error`, but the trading health blocker was not a core service
  crash.
- `/readyz` and `/trading/health` returned `status=degraded`.
- `/readyz` reported Postgres, ClickHouse, Alpaca, empirical jobs, and static universe loading healthy.
- `/readyz` reported `live_submission_gate.ok=false`, detail `simple_submit_disabled`, capital stage `shadow`.
- `/readyz` reported `profitability_proof_floor.ok=false`, detail `repair_only`, capital state `zero_notional`.
- `/readyz` reported `quant_evidence.ok=true` but only because quant evidence was `not_required` and
  `quant_health_not_configured`, which is not a profit proof.

### Source And Contract State

- Jangar already exposes `source_serving_contract_verdict_exchange` in source and tests.
- Jangar already exposes `stage_credit_ledger` in source and tests.
- The companion Jangar design now requires a `ready_truth_arbiter` before material launch readiness can be claimed.
- Torghut source-serving proof exists as a design contract, but the frontier must define which repair receipt buys down
  the current proof gap and what validates it.
- The current live Torghut status shows source-serving and repair evidence are present enough for observe/repair, but
  not enough for paper/live cutover.

### Database And Data Quality

- Torghut database schema was current at expected Alembic head `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- Schema head count current and expected were both `1`.
- Schema lineage was ready, with warnings for known parent forks:
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Account-scope checks were ready, with a warning that checks are bypassed while multi-account trading is disabled.
- Profit window contract showed three windows total: two `quarantined` and one `underfunded`.
- The blocked windows cited `schema_lineage_missing`, `drift_checks_missing`, `feature_rows_missing`,
  `required_feature_set_unavailable`, `market_context_evidence_missing`, `post_cost_expectancy_non_positive`, and
  `quant_health_not_configured`.
- Profit lease projection showed three leases, all `repair_only`, all proof state `missing`.
- Promotion table counts showed `research_candidates=0`, `research_promotions=0`, `strategy_promotion_decisions=1`,
  and `vnext_promotion_decisions=0`.
- Route repair packets showed eight symbols, zero capital-eligible symbols, and `max_notional=0` throughout.

## Problem

Torghut has moved from unsafe ambiguity to safe repair-only operation. That is progress, but it is not a profit
engine. The current blockers are specific:

1. `simple_submit_disabled` correctly prevents live submission.
2. `profitability_proof_floor=repair_only` correctly keeps notional at zero.
3. `feature_rows_missing` and `required_feature_set_unavailable` block the TA core.
4. `schema_lineage_missing` appears in profit-window escrows even though schema heads are current, which means the
   proof receipt is missing or not joined to the profit window.
5. `research_candidates_empty`, `research_promotions_empty`, and `vnext_promotion_decisions_empty` prevent a candidate
   from graduating.
6. `rejection_drag_unmeasured` prevents the system from knowing whether a route is operationally expensive.
7. Execution/TCA proof for some symbols is stale or missing.

Without a frontier, every repair looks urgent. With a frontier, the next repair must prove why it is the most valuable
zero-notional move and how Jangar can verify it without granting capital authority.

## Alternatives Considered

### Option A: Continue Broad Repair Batches

Let implement stages keep repairing any failing Torghut surface: feature rows, TCA, market context, source-serving,
research candidates, or promotion tables.

Advantages:

- Maximizes engineering parallelism.
- Keeps all known blockers visible.
- Avoids premature optimization of the repair queue.

Disadvantages:

- Consumes runner capacity without pricing repairs by expected unblock value.
- Does not reduce failed AgentRuns when many repairs target stale or already-held surfaces.
- Makes Jangar material readiness noisy because receipts are not comparable.
- Can produce activity without improving routeable candidates or post-cost profit.

Decision: reject as the default. Broad repair remains useful only during incident recovery.

### Option B: Block All Torghut Work Until Profit Floor Passes

Do not run Torghut repair or paper work until the profit proof floor is no longer `repair_only`.

Advantages:

- Strongest capital safety posture.
- Simple deployer rule.
- Avoids wasting capacity on uncertain repairs.

Disadvantages:

- The proof floor cannot pass without repair work.
- Keeps stale evidence high.
- Increases manual intervention because engineers have to bypass the gate to produce the evidence it requires.

Decision: reject. Capital remains blocked, but zero-notional repair must stay available.

### Option C: Repair Receipt Frontier With Profit Cutover Ladder

Create a ranked frontier of zero-notional repair lots. Admit only frontier lots that name a value gate, expected gate
delta, required output receipt, source-serving epoch, max runtime, and rollback. Promote to paper only after receipt
settlement proves routeability, TCA quality, feature freshness, and post-cost profit.

Advantages:

- Preserves `max_notional=0` while allowing high-value repair.
- Gives Jangar a compact repair receipt for stage-credit and material readiness.
- Makes profitability hypotheses measurable before paper/live cutover.
- Reduces manual triage because low-value or unverified repairs do not launch.
- Produces a clear deployer contract for green PR-to-healthy rollout.

Disadvantages:

- Requires repair receipts to be stricter and more structured.
- Slower for opportunistic fixes that do not map to a frontier lot.
- Needs settlement logic before the frontier can automatically unlock paper canaries.

Decision: select Option C.

## Architecture

Torghut publishes `repair_receipt_frontier` alongside readiness, trading health, consumer evidence, and source-serving
proof:

```text
repair_receipt_frontier
  schema_version = torghut.repair-receipt-frontier.v1
  frontier_id
  generated_at
  fresh_until
  account
  window
  source_serving_ledger_ref
  capital_state                 # zero_notional | shadow | paper_candidate | live_candidate
  max_notional
  frontier_state                # repair_only | paper_blocked | paper_candidate | live_blocked | live_candidate
  lots[]
  paper_cutover_requirements[]
  live_cutover_requirements[]
  rollback_target
```

Each lot is a measurable repair hypothesis:

```text
repair_frontier_lot
  lot_id
  lot_class                     # feature_rows | execution_tca | research_candidate | source_serving | rejection_drag
  target_symbols[]
  target_hypothesis_ids[]
  target_value_gate             # zero_notional_or_stale_evidence_rate | routeable_candidate_count | ...
  expected_gate_delta
  expected_unblock_value
  cost_class
  source_serving_epoch_ref
  required_input_refs[]
  required_output_receipt
  validation_commands[]
  max_runtime_seconds
  max_notional = 0
  dispatchable
  hold_reason_codes[]
  settlement_status             # pending | settled | rejected | expired
```

Graduation rules:

- A frontier lot can be dispatched only when `max_notional=0`, source-serving proof is current or the lot explicitly
  repairs source-serving proof, and the required output receipt is named.
- A frontier lot settles only when the output receipt retires at least one blocking reason and remains fresh through
  the next Jangar material readiness evaluation.
- Paper cutover requires current source-serving proof, current feature rows, current execution/TCA receipt, at least
  one routeable candidate, and non-negative post-cost expectancy for the candidate window.
- Live cutover additionally requires human-approved capital limits, live submission enabled by configuration, and no
  unresolved capital safety blockers.
- If any receipt is malformed, expired, or claims notional above zero during repair, frontier state becomes
  `paper_blocked` and Jangar material readiness stays `hold` or `block`.

## Profit Hypotheses

The frontier must keep the hypotheses small enough to falsify:

- H1: Refreshing missing feature rows for the active eight-symbol universe reduces
  `zero_notional_or_stale_evidence_rate` by at least 25 percentage points without increasing `max_notional`.
- H2: Recomputing execution/TCA receipts for `AAPL`, `AMD`, `AVGO`, `INTC`, and `NVDA` raises
  `routeable_candidate_count` from `0` to at least `2` while slippage and expected shortfall stay inside configured
  paper thresholds.
- H3: Creating research candidate and promotion receipts for one active hypothesis reduces
  `research_candidates_empty`, `research_promotions_empty`, and `vnext_promotion_decisions_empty` without enabling
  live submission.
- H4: Measuring rejection drag for the top repair symbols produces a paper/no-paper decision that is more valuable
  than another generic market-context refresh.
- H5: Source-serving repair receipts reduce Jangar material-readiness holds by giving the ready truth arbiter a current
  contract canary and runtime source epoch.

Every implementation PR must name which hypothesis it tests and which receipt proves success.

## Implementation Scope For Engineer Stage

The next bounded Torghut engineering PR should add the read model first and leave capital behavior unchanged.

Required code changes:

1. Add `repair_receipt_frontier` construction in Torghut readiness/trading status code.
2. Reuse existing repair-bid settlement, route warrant, source-serving, TCA, feature freshness, and profit-window
   inputs; do not introduce a new database write path for the first PR.
3. Include the frontier in `/readyz`, `/trading/health`, and `/trading/consumer-evidence`.
4. Add tests that prove the current live shape produces `frontier_state=repair_only`, `max_notional=0`, no paper
   candidate, and dispatchable zero-notional lots only when required output receipts are named.
5. Add tests for malformed receipt, expired receipt, and nonzero notional repair rejection.

Acceptance gates:

- `uv run --frozen pytest services/torghut/tests/test_trading_api.py -k repair_receipt_frontier`
- `uv run --frozen pytest services/torghut/tests/test_repair_bid_settlement.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

The PR must cite this design and the companion Jangar design. It must keep live submission disabled and `max_notional=0`.

Implementation note, 2026-05-13:

- `services/torghut/app/trading/repair_receipt_frontier.py` now builds the
  `torghut.repair-receipt-frontier.v1` read model from source-serving proof, freshness carry, repair-bid settlement,
  profit-freshness frontier, route warrants, live submission, and proof-floor inputs.
- `/trading/status`, `/trading/health`, `/readyz`, and `/trading/consumer-evidence` expose the frontier as additive
  evidence. It does not authorize order submission; every lot is projected with `max_notional=0`.
- Source-serving gaps produce a selected `source_serving` repair lot, and non-source lots are held until source-serving
  proof converges.

## Deployment And Verification Gates

The deployer stage must prove:

- Argo `torghut` is Synced/Healthy at the promoted revision.
- The active Knative revision is ready.
- `/readyz` and `/trading/health` expose `repair_receipt_frontier`.
- `repair_receipt_frontier.max_notional=0` until paper cutover.
- The frontier has at least one lot with a named value gate and output receipt, or names the exact blocker preventing
  lot dispatch.
- Source-serving proof is current or a source-serving repair lot is the selected frontier lot.
- Jangar `ready_truth_arbiter` consumes the Torghut frontier as repair evidence, not capital authority.

## Rollback

Rollback stays simple:

- Keep `TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION=false`.
- Keep `TRADING_AUTONOMY_ENABLED=false` for live promotion until paper cutover passes.
- Keep `max_notional=0` for every repair frontier lot.
- If the frontier payload is malformed, omit it from readiness and let Jangar fall back to existing route warrants and
  repair-bid settlement holds.
- If a repair receipt is disputed, mark the lot `rejected` or `expired`; do not widen capital.

## Handoff Contract

Engineer handoff:

- Build the frontier as a read model first.
- Do not add new writes or broker actions in the first PR.
- Every frontier lot must name a value gate, expected gate delta, output receipt, max runtime, and notional cap.
- Tests must cover current degraded-but-safe state.

Deployer handoff:

- Treat a visible frontier as repair evidence, not paper authority.
- Paper cutover requires source-serving proof, routeability, TCA quality, feature freshness, and post-cost profit.
- Live cutover remains blocked without explicit capital gate approval and live submission configuration.

## Risks

- The frontier can become another dumping ground for every blocker. Limit the first version to the top few lots ranked
  by expected unblock value and receipt quality.
- A repair receipt can retire one reason while another reason still blocks paper. The frontier must show remaining
  reasons clearly.
- Jangar must not turn a Torghut repair lot into capital authority. The companion ready truth arbiter keeps repair,
  paper, and live action classes separate.
- If source-serving proof remains missing, the frontier should prioritize source-serving repair before routeable
  candidate claims.

## Next Milestone

The next implementation milestone is:

`feat(torghut): publish repair receipt frontier`

It improves:

- `zero_notional_or_stale_evidence_rate` by ranking stale-evidence repairs;
- `routeable_candidate_count` by requiring a routeability delta before paper promotion;
- `fill_tca_or_slippage_quality` by requiring current execution/TCA receipts;
- `post_cost_daily_net_pnl` by making profit evidence a cutover requirement;
- `capital_gate_safety` by keeping every repair lot at `max_notional=0`.
