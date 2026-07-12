# 74. Torghut Profit Cells and Evidence-Escrow Promotion Veto (2026-05-05)

Status: Approved for implementation (`plan`)

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


## Executive Summary

The decision is to move Torghut promotion from portfolio-wide optimism to durable **profit cells** that consume Jangar
evidence escrows. A profit cell is a bounded unit of economic authority: one hypothesis, one strategy family, one
account or sleeve, one market/data segment, one capital stage, one evidence escrow, and one measured post-cost outcome
window.

The reason is the 2026-05-05 state. Torghut has a live trading database, a large options catalog, and a rich research
schema, but the fresh and stale surfaces are uneven. Live `trade_decisions` and `position_snapshots` were current on
2026-05-04, while options watermarks were stale from 2026-03-11 and many autoresearch/promotion tables had structure but
no rows. That is not a reason to stop innovation. It is a reason to allocate capital through cells whose evidence,
freshness, and guardrails are explicit.

The tradeoff is slower promotion for broad portfolio moves. I am accepting that trade because the system needs profit
that survives replay, slippage, stale data, and control-plane repair, not another global green light.

## Success Criteria

This design is complete when:

1. Every non-observe capital request cites one `profit_cell_id` and one fresh Jangar `evidence_escrow_id`.
2. Profit cells store post-cost PnL, drawdown, turnover, slippage, concentration, freshness, and replay provenance.
3. Empty or stale evidence tables produce explicit vetoes, not silent fallback to portfolio-level status.
4. Promotion can advance one cell without promoting the whole strategy family.
5. Rollback can demote one cell and preserve the evidence bundle for falsification analysis.

## Assessment Snapshot

### Cluster Health, Rollout, and Events

- `kubectl get pods -n torghut -o wide` showed the main Torghut pod recovered:
  - `torghut-00201-deployment-79df678c95-xvzsm` was `2/2 Running`.
  - `torghut-db-1`, ClickHouse, Torghut TA, Torghut WS, exporters, and Symphony were running.
- The same probe showed one simulation revision still degraded:
  - `torghut-sim-00280-deployment-6f844b4647-np4x6` was `0/2 ImagePullBackOff`.
  - another `torghut-sim-00280` pod was `2/2 Running`.
- `kubectl get events -n torghut --sort-by=.lastTimestamp | tail -80` showed:
  - the failed digest had `no match for platform in manifest`.
  - main Torghut revised to `torghut-00201` and became ready.
  - `configuration/torghut-sim` still reported `LatestReadyFailed`.
- The agents namespace showed current Torghut quant schedule jobs running while older schedule cron jobs had failed.

Interpretation:

- Torghut is live enough to keep measuring.
- Simulation and scheduler evidence cannot be collapsed into one binary health bit.
- Promotion must be per-cell and must explicitly exclude a degraded simulation cell until repaired.

### Source Architecture

Current in-tree foundations:

- `services/torghut/app/trading/submission_council.py`
  - already reasons about promotion certificates, configured live promotion, and blocked reasons.
- `services/torghut/app/trading/strategy_specs.py`
  - carries promotion policy references and strategy metadata.
- `services/torghut/app/whitepapers/claim_compiler.py`
  - compiles whitepaper claims into structured experiment intent.
- `services/torghut/scripts/run_strategy_factory_v2.py`
  - already runs strategy-factory experiments and writes artifacts.
- `services/torghut/scripts/run_strategy_autoresearch_loop.py`
  - already represents the autoresearch lane.
- `services/torghut/migrations/versions/0021_strategy_hypothesis_governance.py`
  - defines strategy hypotheses, metric windows, and promotion decisions.
- `services/torghut/migrations/versions/0028_autoresearch_epoch_ledgers.py`
  - defines autoresearch epochs, candidate specs, proposal scores, and portfolio candidates.
- `services/jangar/src/server/torghut-quant-metrics-store.ts`
  - writes `torghut_control_plane.quant_metrics_latest` and history into the Jangar database.
- `services/jangar/src/server/torghut-simulation-control-plane.ts`
  - writes Jangar-side simulation runs, artifacts, dataset cache, and lane leases.

Gaps:

- Torghut's promotion path can see rich artifacts but does not yet require a Jangar evidence escrow id.
- Many research tables exist before they are populated; absence needs to be a first-class veto reason.
- Simulation readiness and live trading readiness need separate cells so one broken simulator image does not erase live
  measurement, and live measurement does not justify simulation promotion.

### Database and Data Quality

Torghut database evidence:

- PostgreSQL version: `17.0`.
- Migration state:
  - `public.alembic_version` reported `0029_whitepaper_embedding_dimension_4096`.
- Largest and freshest useful tables:
  - `torghut_options_contract_catalog`: estimated `1,710,579` rows, expiration max `2028-02-18`.
  - `trade_decisions`: estimated `147,606` rows, `created_at` max `2026-05-04T17:25:57.901Z`.
  - `position_snapshots`: estimated `36,087` rows, `created_at` max `2026-05-04T20:59:06.489Z`.
  - `trade_cursor`: `updated_at` max `2026-05-04T20:59:12.575Z`.
- Stale or empty surfaces:
  - `torghut_options_watermarks.last_event_ts` max `2026-03-11T01:08:11.973Z`.
  - `torghut_options_subscription_state.last_ranked_ts` max `2026-03-11T01:06:33.304Z`.
  - `executions.updated_at` max `2026-04-03T05:32:36.212Z`.
  - `llm_decision_reviews.created_at` max `2026-03-19T20:13:45.326Z`.
  - `strategy_hypotheses`, `strategy_hypothesis_metric_windows`, `strategy_promotion_decisions`,
    `autoresearch_epochs`, `autoresearch_candidate_specs`, and `autoresearch_portfolio_candidates` were structurally
    present but had no current rows in the assessment output.

Jangar database evidence:

- `torghut_control_plane.quant_metrics_latest.updated_at` reached `2026-05-05T09:04:05.635Z`.
- `torghut_control_plane.quant_metrics_series` was about `117 GB` with an estimated `314,034,592` rows.
- `torghut_control_plane.quant_pipeline_health` was about `13.5 GB` with an estimated `49,411,352` rows.
- Broad freshness scans over those history tables hit read timeouts.

Interpretation:

- Torghut has live measurement and rich schema, but the valid measurement surface is narrower than the schema implies.
- Promotion must price data freshness and table emptiness directly.
- Jangar should provide current-state evidence ids; Torghut should avoid broad Jangar history scans in promotion paths.

## Problem Statement

Torghut's profitability architecture has advanced from static TSMOM into whitepaper autoresearch, strategy factory
evidence, options data, simulation, and promotion certificates. The remaining risk is that those surfaces can be
interpreted as a single portfolio truth.

That is not precise enough. A strategy family can have:

- fresh equities decisions but stale options watermarks;
- a ready live service but a failed simulation revision;
- a valid hypothesis schema but no populated evidence rows;
- fresh quant metrics latest rows but history tables too large for live scans;
- a healthy Jangar serving pod but a blocked promotion escrow.

The control plane must let Torghut keep learning from the healthy cell while refusing capital movement for the stale
cell.

## Alternatives Considered

### Option A: Make the Whitepaper Autoresearch Factory the Primary Promotion Gate

This option would continue from document 71 and let autoresearch epochs produce portfolio candidates that later pass the
existing promotion checks.

Pros:

- Keeps research velocity high.
- Reuses the newest design and migration work.
- Gives the team a clear innovation story.

Cons:

- Does not solve stale options or failed simulation evidence by itself.
- Treats missing rows as future work rather than a current veto.
- Can still produce portfolio-level optimism when only some data segments are trustworthy.

Decision: rejected as the primary gate. The factory remains important, but it must write into cells.

### Option B: Let Jangar Own Final Capital Authority

This option would make Jangar's evidence escrow the final source of capital approval.

Pros:

- One platform-controlled gate.
- Easier deploy verification.

Cons:

- Couples platform truth to trading economics.
- Makes Jangar accountable for PnL it does not measure locally.
- Reduces Torghut's ability to run lane-local experiments and falsification.

Decision: rejected. Jangar should veto stale platform evidence; Torghut should own economics.

### Option C: Profit Cells Backed by Evidence Escrow (Selected)

This option makes Jangar evidence escrow a required input and makes Torghut profit cells the economic authority.

Pros:

- Separates platform truth from trading truth.
- Lets one stale data segment veto only its cell.
- Gives each hypothesis measurable post-cost outcomes and guardrails.
- Supports ambitious research without letting empty tables or stale watermarks become hidden optimism.

Cons:

- Adds a new promotion join key.
- Requires migration and reporting work.
- Slows broad portfolio promotion until enough cells are populated.

Decision: selected.

## Target Architecture

### Profit Cell

A profit cell is identified by:

- `profit_cell_id`
- `hypothesis_id`
- `strategy_family`
- `strategy_variant`
- `account`
- `market_segment`
- `data_segment`
- `capital_stage`
- `evidence_escrow_id`
- `dataset_snapshot_id`
- `measurement_window`

Required metrics:

- gross PnL
- fees
- slippage
- borrow or funding cost when applicable
- post-cost net PnL
- max drawdown
- turnover
- order rejection rate
- best-day share
- worst-day loss
- active-day ratio
- regime-slice pass rate
- stale-evidence age
- simulation/live parity when simulation is required

Required guardrails:

- no capital stage above `observe` when Jangar `promotion` escrow is missing, stale, or blocked;
- no options cell promotion when options watermarks exceed freshness budget;
- no simulation-backed promotion when the simulation revision is `LatestReadyFailed`;
- no whitepaper/autoresearch promotion when the referenced epoch, candidate spec, or portfolio candidate rows are
  missing;
- no live promotion when execution/TCA rows are stale beyond the configured evidence window.

### Proposed Tables

Use additive Torghut migrations:

- `profit_cells`
  - identity, hypothesis, strategy, account, segment, stage, escrow id, and status.
- `profit_cell_metric_windows`
  - one row per cell/window with objective metrics and freshness measurements.
- `profit_cell_evidence_refs`
  - links to Jangar escrow, replay artifacts, dataset snapshots, executions, TCA rows, and whitepaper claims.
- `profit_cell_vetoes`
  - durable veto reasons with source, severity, entered_at, resolved_at, and rollback action.

The first implementation can map these rows onto existing `strategy_hypotheses`, `strategy_hypothesis_metric_windows`,
`strategy_promotion_decisions`, and `autoresearch_*` rows before adding new tables if the engineer can prove the mapping
is lossless. If the mapping cannot express `evidence_escrow_id` and per-cell vetoes cleanly, add the new tables.

### Measurable Trading Hypotheses

The first four cells should be deliberately narrow:

1. `equity_microbar_reversal_top2`
   - Source: existing strict daily microbar reversal configs.
   - Target: positive post-cost net PnL over the next 10 valid trading days with best-day share below 35%.
   - Guardrail: no promotion if live slippage exceeds replay slippage by more than 25 bps.
2. `equity_opening_drive_continuation`
   - Source: existing opening-drive and volume-continuation configs.
   - Target: at least 55% active-day participation with drawdown under the configured cell budget.
   - Guardrail: no promotion if first-hour market-context evidence is stale.
3. `whitepaper_claim_graph_candidate`
   - Source: populated whitepaper claim graph and autoresearch epoch.
   - Target: candidate survives formal validity, cost stress, and replay against a forward-only holdout.
   - Guardrail: no promotion if the referenced `autoresearch_epochs` or candidate rows are missing.
4. `options_freshness_probe`
   - Source: options catalog and watermarks.
   - Target: observe-only probe proves fresh option chain ingestion and ranking after market open.
   - Guardrail: no non-observe capital until `torghut_options_watermarks.last_event_ts` is within the options budget.

### Promotion Veto Flow

1. Jangar seals an evidence escrow.
2. Torghut reads the escrow id and maps it to active cells.
3. For each cell, Torghut loads only allowed latest/current evidence.
4. Torghut writes metric windows and vetoes.
5. The submission council can promote a cell only when:
   - Jangar escrow is fresh and not promotion-blocked;
   - the cell has a current measurement window;
   - post-cost net PnL and guardrails pass;
   - no unresolved veto exists for that cell and stage.
6. A portfolio candidate can request more capital only from cells that individually pass.

## Implementation Scope

Engineer stage should touch these areas:

- `services/torghut/migrations/versions/*`
  - add profit-cell tables or extend existing promotion tables with a lossless mapping.
- `services/torghut/app/models/entities.py`
  - add ORM models for profit cells, metric windows, evidence refs, and vetoes.
- `services/torghut/app/trading/submission_council.py`
  - require `profit_cell_id` and `evidence_escrow_id` for non-observe promotion.
- `services/torghut/app/trading/evidence_contracts.py`
  - encode cell evidence requirements and veto reasons.
- `services/torghut/scripts/run_strategy_factory_v2.py`
  - write candidate results into profit cells.
- `services/torghut/scripts/run_strategy_autoresearch_loop.py`
  - produce cell-scoped proposal and portfolio evidence.
- `services/jangar/src/server/torghut-quant-metrics-store.ts`
  - expose latest cell metrics without scanning large history tables.
- `services/jangar/src/server/control-plane-status.ts`
  - project Torghut cell veto summary from the Jangar evidence escrow.

## Validation Gates

Pre-merge engineering gates:

- Migration graph is linear and includes downgrade-safe additive tables.
- Unit tests prove non-observe promotion is rejected without `profit_cell_id`.
- Unit tests prove stale options watermarks veto only options cells.
- Unit tests prove missing autoresearch rows veto whitepaper-derived cells.
- Unit tests prove a failed simulation revision vetoes simulation-backed cells without blocking live measurement cells.
- Submission council tests prove Jangar escrow `blocked` or expired status blocks promotion.

Validation commands:

```bash
cd services/torghut
uv sync --frozen --extra dev
uv run --frozen pytest tests/test_submission_council.py tests/test_strategy_autoresearch.py tests/test_run_strategy_factory_v2.py
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
bunx oxfmt --check docs/torghut/design-system/v6/74-torghut-profit-cells-and-evidence-escrow-promotion-veto-2026-05-05.md
```

Deployer gates:

- Main Torghut service is ready.
- Simulation revision is either ready or has a cell-scoped veto.
- Latest Jangar evidence escrow is fresh.
- Each non-observe cell has a current metric window and no unresolved veto.
- Rollback evidence lists the exact cells demoted.

## Rollout Plan

1. Shadow cells:
   - write profit-cell rows for current strategies without changing promotion behavior.
   - populate vetoes for stale options, empty autoresearch, and simulation ImagePullBackOff evidence.
2. Observe-only enforcement:
   - require profit cells for new observe-stage promotions.
   - keep existing portfolio status visible but non-authoritative.
3. Non-observe enforcement:
   - require fresh Jangar escrow and passing metric window for constrained live.
   - block portfolio promotion when any requested cell has unresolved vetoes.
4. Portfolio assembly:
   - assemble candidates only from passing cells.
   - target portfolio-level `>= $500/day` post-cost net PnL after cell-level proof exists.
5. Scaled live:
   - increase capital by cell, not by family.
   - require deployer evidence for each cell escalation.

## Rollback Plan

Rollback is cell-scoped:

- demote the affected cell to `observe`;
- mark the active metric window invalidated with the rollback reason;
- keep the evidence refs and veto rows;
- preserve unrelated cells when their evidence remains valid;
- disable non-observe promotion globally only if Jangar escrow is blocked or compiler parity fails.

Rollback triggers:

- post-cost net PnL turns negative for two consecutive valid windows;
- live slippage exceeds the guardrail threshold;
- evidence escrow expires before promotion decision completes;
- options, simulation, or whitepaper data freshness exceeds budget;
- submission council cannot explain a promotion decision with one cell id and one escrow id.

## Risks

- Cell proliferation can hide portfolio risk if aggregation is weak. The portfolio view must still enforce total
  exposure, correlation, and drawdown caps.
- Empty research tables can slow innovation. That is acceptable until the factory writes real evidence.
- Jangar escrow freshness can become a hard dependency. The companion design separates serving from promotion so a
  platform observer repair does not stop live measurement unnecessarily.
- Large Jangar quant history tables can tempt expensive analysis in promotion paths. Promotion must use latest/materialized
  evidence and offline jobs for history.

## Handoff

Engineer acceptance:

- Implement profit-cell persistence or a proven lossless mapping to existing tables.
- Require cell and escrow ids for non-observe promotion.
- Add stale-data, missing-row, failed-simulation, and blocked-escrow tests.

Deployer acceptance:

- Verify current cells and vetoes after rollout.
- Do not promote options or simulation-backed cells while the observed freshness and revision failures remain unresolved.
- Capture promoted, vetoed, and rolled-back cell ids in release evidence.
