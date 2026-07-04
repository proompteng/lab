# Torghut Alpha Closure Settlement Handoff (2026-05-14)

Status: Accepted for engineer and deployer handoff
Owner: Gideon Park, Torghut Traders Architecture
Related designs:

- `docs/torghut/design-system/v6/201-torghut-alpha-closure-settlement-and-feature-replay-market-2026-05-14.md`
- `docs/agents/designs/196-jangar-alpha-closure-slot-governor-and-no-delta-budget-2026-05-14.md`

## Decision

Build the Torghut alpha closure board around one zero-notional feature-replay market for `H-MICRO-01`, then let Jangar
admit exactly one closure slot when the board is current and no no-delta debt blocks the dedupe key.

## Evidence

- `GET /trading/revenue-repair` on 2026-05-14 returned `business_state=repair_only`, `revenue_ready=false`,
  `routeable_candidate_count=0`, and top queue item `repair_alpha_readiness`.
- Capital stayed closed: `live_submission_allowed=false`, `capital_stage=shadow`, `capital_state=zero_notional`, and
  `max_notional=0`.
- `GET /db-check` was schema-current at `0031_autoresearch_candidate_spec_epoch_uniqueness`.
- `GET /readyz` was degraded on `simple_submit_disabled` and proof-floor `repair_only`; Postgres, ClickHouse, Alpaca,
  database schema, universe, and empirical jobs were healthy.
- Jangar `/ready` was `status=ok`, execution trust was healthy, and Torghut consumer evidence was current for serving
  revision `torghut-00371`.
- Jangar saw three dispatchable Torghut repair lots: `quant_pipeline`, `promotion_custody`, and `feature_lineage`.

## Engineer Acceptance Gates

- Torghut implements a pure `build_alpha_repair_closure_board()` helper.
- `/trading/revenue-repair` includes `alpha_repair_closure_board.alpha_closure_settlement_market`.
- The selected market targets `routeable_candidate_count`, selects `H-MICRO-01` while the current blocker set
  persists, and keeps `max_notional=0`.
- The board records a no-delta key based on account, window, hypothesis, repair class, source commit, and blocker
  digest.
- Tests cover current board, stale board, nonzero notional denial, H-MICRO-01 priority, and no-delta cooldown.

## Jangar Acceptance Gates

- Jangar parser accepts optional compact alpha closure refs in observe mode.
- The slot governor emits one decision with selected market id, selected hypothesis id, required receipt, and denied
  reason codes.
- Stale board, nonzero notional, missing board, paper/live action class, or active no-delta debt are denied.
- Enforcement is off until Torghut board visibility is proven in a rollout.

## Deployer Acceptance Gates

- Argo `torghut`, `jangar`, and `agents` are `Synced/Healthy`.
- Torghut live and sim revisions are ready.
- `GET /db-check` stays schema-current.
- `GET /trading/revenue-repair` includes the alpha closure board.
- `GET /trading/consumer-evidence` includes compact closure refs.
- Jangar status includes the alpha closure slot governor.
- Torghut remains `max_notional=0`, `live_submission_allowed=false`, and `capital_stage=shadow`.
- `/readyz` may remain HTTP 503 while the live submit gate and proof floor are intentionally closed.

## Rollback

- Disable board emission or ignore `alpha_repair_closure_board`.
- Set Jangar slot-governor mode to `observe`.
- Keep existing revenue repair, repair-bid settlement, alpha readiness strike, and repair outcome dividend payloads.
- Preserve emitted receipts for audit.
- Do not delete AgentRuns, database rows, jobs, or trading evidence.

## Next Milestone

Implement the Torghut board builder and additive `/trading/revenue-repair` exposure. The revenue metric is
`routeable_candidate_count`; the smallest current blocker is `hypothesis_not_promotion_eligible` with feature
rows, drift checks, and required feature set evidence missing for the lineage-ready `H-MICRO-01` lane.
