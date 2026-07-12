# 75. Torghut Profit Actuation Cells and Capital Guardrail Marketplace (2026-05-05)

Status: Approved for implementation (`plan`)

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: metrics/renderers, PostHog hooks, guardrail exporters, and operational manifests exist; full SLO/on-call process is mostly doc/runbook-level.
- Matched implementation area: Observability, metrics, PostHog, alerts, and operations.
- Current source evidence:
  - `services/torghut/app/metrics/core.py`
  - `services/torghut/app/observability/posthog.py`
  - `argocd/applications/torghut/llm-guardrails-exporter.yaml`
  - `argocd/applications/torghut/clickhouse/clickhouse-guardrails-exporter.yaml`
  - `docs/torghut/production-readiness-proof-runbook.md`
- Design drift note: Operational docs need runtime status and alerting readback before being treated as complete.


## Executive Summary

The decision is to promote Torghut profitability through **profit actuation cells** and a **capital guardrail
marketplace**. A profit cell is no longer just an evidence bundle. It becomes an actuation candidate: a hypothesis,
lane, account, market segment, capital stage, Jangar actuation escrow, post-cost outcome window, and rollback recipe.

The reason is the May 5 state. Torghut is live and useful, but the profitable surface is narrower than the operational
surface:

- `/healthz` is ok and `/trading/health` reports Postgres, ClickHouse, Alpaca, and scheduler healthy;
- `/trading/status` says live submission is allowed, but active capital is still `shadow`, promotion eligible total is
  `0`, and rollback required total is `3`;
- signal lag is about `45036` seconds, universe symbols are empty, and empirical jobs are stale;
- the Torghut sim revision still has an `ImagePullBackOff` on one node due to a platform-missing image digest;
- Torghut DB has fresh decisions and positions from May 4, but options watermarks are from March 11, executions from
  April 3, LLM reviews from March 19, and autoresearch/hypothesis promotion tables are empty;
- Jangar's quant latest projection is fresh, but most latest rows are `insufficient_data` or `stale`.

The tradeoff is slower broad promotion. I am accepting that trade because the system needs profitable autonomy, not
route-level optimism. The capital path should reward cells with fresh, post-cost, platform-approved proof and keep the
rest learning in shadow.

## Success Criteria

This design is complete when:

1. Every non-observe capital request cites one `profit_actuation_cell_id` and one Jangar `actuation_escrow_id`.
2. Capital movement is decided per cell, not by portfolio-wide `/trading/status`.
3. Stale signal, stale options, empty autoresearch, stale empirical jobs, failed simulation revisions, and blocked
   Jangar actuation produce typed vetoes.
4. The marketplace can allocate shadow, canary, and live capital budgets to competing cells by expected post-cost
   edge, data quality, drawdown, concentration, and platform risk.
5. Rollback demotes one cell without erasing its evidence or stopping unrelated healthy cells.

## Assessment Snapshot

### Cluster, Rollout, and Event Evidence

Read-only cluster checks used the `agents` service account.

- `kubectl get pods -n torghut -o wide`
  - `torghut-00202-deployment-677db4fc7f-5cqgl` was `2/2 Running`.
  - ClickHouse, Keeper, Torghut DB, TA, WS, Symphony, and guardrail exporters were running.
  - `torghut-db-migrations-n5rg7` was running during the sample after another migration job had completed.
  - `torghut-sim-00280-deployment-6f844b4647-np4x6` was `0/2 ImagePullBackOff`.
  - another `torghut-sim-00280` pod was `2/2 Running`.
- `kubectl get events -n torghut --sort-by=.lastTimestamp`
  - showed repeated startup/readiness probe failures during revision rollouts.
  - showed `no match for platform in manifest` for digest
    `sha256:d278a4d4267f011ba559dc51401acc6ac8f43d44a766b61f29a4d01859cce5cf`.
  - showed `configuration/torghut-sim` with `LatestReadyFailed`.
  - showed main Torghut advancing to revision `torghut-00202`.

Interpretation:

- Live service and simulation evidence are different cells.
- A healthy live service must not promote a simulator-dependent cell while one simulator revision is platform-blocked.

### Runtime API Evidence

- `GET /healthz`
  - returned `{"status":"ok","service":"torghut"}`.
- `GET /db-check`
  - returned `ok=true`, expected and current head `0029_whitepaper_embedding_dimension_4096`, one schema graph root,
    and lineage warnings for known parent forks.
- `GET /trading/health`
  - returned scheduler, Postgres, ClickHouse, and Alpaca healthy.
  - reported universe source `jangar`, but `universe not yet evaluated`, `symbols_count=0`, and
    `require_non_empty=true`.
  - reported empirical jobs `degraded`, authority `blocked`, but `required=false`.
  - reported `live_submission_gate.allowed=true`.
  - reported `promotion_eligible_total=0`, `rollback_required_total=3`, and dependency quorum `block`.
- `GET /trading/status`
  - reported build `v0.568.0-59-g1b5765873`, commit `1b5765873985262f9c1ded242b40fcffb7bfafa5`, active revision
    `torghut-00202`.
  - reported `capital_stage_totals.shadow=3`.
  - reported `signal_lag_seconds=45036` with expected market-closed staleness.
  - reported `no_signal_reason_streak.cursor_tail_stable=178`.
  - listed three hypotheses:
    - `H-CONT-01`: shadow, rollback required, blocked by `jangar_dependency_block` and `signal_lag_exceeded`.
    - `H-MICRO-01`: blocked, rollback required, missing drift checks and feature rows.
    - `H-REV-01`: shadow, rollback required, blocked by Jangar dependency, stale market context, and signal lag.
  - reported empirical jobs completed in March but stale: `benchmark_parity`, `foundation_router_parity`,
    `janus_event_car`, and `janus_hgrm_reward`.

Interpretation:

- Torghut has enough structure to make cell-local decisions today.
- The dangerous gap is that live submission readiness can still look positive while every promotion candidate is
  shadow or blocked.

### Database and Data Quality Evidence

The Torghut Postgres assessment used the app account and issued read-only SQL.

- PostgreSQL version: `17.0`.
- Fresh operational tables:
  - `trade_decisions`: `147606` rows, newest `created_at=2026-05-04T17:25:57.901Z`.
  - `position_snapshots`: `39695` rows, newest `created_at=2026-05-04T20:59:06.489Z`.
  - `trade_cursor`: one row, newest `updated_at=2026-05-04T20:59:12.575Z`.
- Stale or non-authoritative tables:
  - `executions`: `13778` rows, newest `updated_at=2026-04-03T05:32:36.212Z`.
  - `llm_decision_reviews`: `23567` rows, newest `created_at=2026-03-19T20:13:45.326Z`.
  - `torghut_options_watermarks`: `1213` rows, newest `last_event_ts=2026-03-11T01:08:11.973Z`.
  - `torghut_options_subscription_state`: `1948` rows, newest `last_ranked_ts=2026-03-11T01:06:33.304Z`.
- Empty current promotion surfaces:
  - `strategy_hypotheses`: `0` rows.
  - `strategy_hypothesis_metric_windows`: `0` rows.
  - `strategy_promotion_decisions`: `0` rows.
  - `autoresearch_epochs`: `0` rows.
  - `autoresearch_candidate_specs`: `0` rows.
  - `autoresearch_portfolio_candidates`: `0` rows.

The Jangar database added cross-plane evidence:

- `torghut_control_plane.quant_metrics_latest.updated_at` reached `2026-05-05T09:27:26.162Z`.
- latest metric rows were mostly not promotable:
  - `2627` rows were `insufficient_data/insufficient_data`.
  - `558` rows were `ok/stale`.
  - `91` rows were `ok/good`.
- history tables were too large for route-time gates:
  - `quant_metrics_series` estimated `317739425` rows.
  - `quant_pipeline_health` estimated `50618301` rows.

Interpretation:

- Torghut has live measurements, but they are not broad enough for portfolio-level capital promotion.
- Empty tables are not TODOs; they are veto evidence.
- A profit cell can remain valuable in shadow while its promotion surfaces are empty or stale.

## Problem Statement

Torghut currently separates many facts but still lacks one economic actuation primitive. The runtime can say live
submission is ready, the hypothesis registry can say every candidate remains shadow or blocked, the database can show
fresh decisions and stale options, and Jangar can block platform promotion. Without a cell-level actuation contract,
those facts are easy to summarize into the wrong action.

The system needs to answer:

- Which exact hypothesis and market segment wants capital?
- Which Jangar actuation escrow authorizes the platform side?
- Which data and empirical surfaces are fresh enough for this cell?
- What is the expected post-cost edge after slippage and churn?
- What budget can this cell receive without harming other cells?
- What precise event demotes this cell?

## Alternatives Considered

### Option A: Freeze All Non-Observe Capital Until Every Surface Is Fresh

Pros:

- Safest against stale data.
- Simple operator decision.
- Avoids accidental promotion from partial truth.

Cons:

- Stops useful shadow learning when only one segment is stale.
- Treats a failed sim revision as equivalent to live measurement failure.
- Delays research and evidence generation.

Decision: rejected. Torghut should keep learning, but capital must stay scoped.

### Option B: Let Torghut Own Capital Independent of Jangar

Pros:

- Keeps trading autonomy high.
- Avoids platform coupling.
- Lets Torghut make faster lane-local decisions.

Cons:

- Ignores platform actuation risks such as missing runtime tools, stale stages, or deploy uncertainty.
- Makes Jangar dependency quorum advisory even when it should veto promotion.
- Recreates the same route optimism problem inside trading.

Decision: rejected. Jangar should not own PnL, but it must own the platform veto.

### Option C: Profit Actuation Cells and Capital Guardrail Marketplace (Selected)

Pros:

- Separates platform veto from economic approval.
- Lets healthy cells learn while stale cells remain shadow or blocked.
- Turns empty tables and stale watermarks into explicit cell-local vetoes.
- Creates a measurable path to profitability instead of portfolio-wide optimism.
- Preserves future option value for autoresearch and strategy-factory candidates.

Cons:

- Adds another promotion object and marketplace evaluator.
- Requires data-quality scoring and accounting work.
- Broad capital moves become slower until enough cells earn budget.

Decision: selected.

## Target Architecture

### Profit Actuation Cell

```text
profit_actuation_cell_id
profit_cell_id
hypothesis_id
strategy_family
strategy_variant
account
market_segment
capital_stage
jangar_actuation_escrow_id
data_watermark_set_id
empirical_bundle_id
simulation_lane_id
post_cost_window_id
expected_edge_bps
max_drawdown_bps
max_avg_abs_slippage_bps
capital_budget_notional
decision
reason_codes
fresh_until
rollback_recipe
```

Decisions:

- `shadow`: measure only.
- `canary`: bounded live or paper-live exposure.
- `live`: approved live exposure under budget.
- `scale`: eligible for larger budget.
- `quarantine`: no actuation until repair exits.

### Capital Guardrail Marketplace

Cells submit bids for scarce capital. The evaluator scores:

- Jangar actuation decision and expiry.
- signal lag and universe freshness.
- market-context freshness.
- empirical job freshness.
- simulation availability and artifact platform parity.
- post-cost expectancy.
- average absolute slippage.
- drawdown and concentration.
- feature coverage and drift governance.
- rollback readiness.

The marketplace is not an auction for maximum return only. It is a constrained optimizer: capital is assigned only when
edge survives cost, data is fresh, drawdown is bounded, and platform actuation is allowed.

### Cell-Local Vetoes

Required vetoes:

- `jangar_actuation_blocked`
- `jangar_actuation_expired`
- `signal_lag_exceeded`
- `universe_empty`
- `market_context_stale`
- `empirical_jobs_stale`
- `feature_rows_missing`
- `drift_checks_missing`
- `options_watermark_stale`
- `simulation_platform_mismatch`
- `autoresearch_empty`
- `promotion_decision_empty`
- `slippage_budget_exceeded`
- `post_cost_edge_missing`

The current May 5 state would produce:

- `H-CONT-01`: `shadow`, blocked from canary by Jangar dependency and signal lag.
- `H-MICRO-01`: `quarantine` or `shadow`, blocked by missing features, drift checks, Jangar dependency, and signal lag.
- `H-REV-01`: `shadow`, blocked by stale market context, Jangar dependency, and signal lag.
- Options cells: `quarantine` until March 11 watermarks are repaired.
- Simulation-dependent cells: `quarantine` for the platform-mismatched sim revision.

### Relationship to Jangar

Jangar supplies platform truth:

- actuation escrow id;
- runtime kit and deploy proof lane;
- webhook and workflow watermarks;
- Torghut quant latest summary;
- repair-cell ids for platform defects.

Torghut supplies economic truth:

- cell hypothesis and segment;
- data freshness;
- post-cost PnL and TCA;
- empirical and simulation proof;
- capital budget and rollback.

Jangar can veto platform promotion. It cannot approve profit by itself.

## Implementation Scope

Engineer stage should implement:

1. Add profit actuation cell tables or extend the existing profit-cell schema with actuation fields.
2. Add a marketplace evaluator that reads Jangar actuation, hypothesis registry status, current trading status,
   Torghut DB watermarks, and Jangar quant latest summaries.
3. Add explicit veto reason mapping for the May 5 failures listed above.
4. Require `jangar_actuation_escrow_id` for any non-observe capital stage transition.
5. Write cell decisions back to a current-state projection for `/trading/status` and Jangar consumer projections.
6. Add simulation platform parity as a required proof for simulator-dependent cells.
7. Add autoresearch empty-table vetoes until epochs, candidate specs, and portfolio candidates are populated.

Deployer stage should implement:

1. Keep live service available when only sim cells are quarantined.
2. Refuse canary/live/scale promotion when Jangar platform actuation is `block` or expired.
3. Refuse options-cell promotion until options watermarks are current.
4. Refuse autoresearch-cell promotion until autoresearch current-state rows exist.
5. Verify rollback demotes only affected cells.

## Validation Gates

Required tests:

- marketplace evaluator unit tests for the three current hypotheses.
- DB fixture tests for empty strategy and autoresearch tables.
- platform mismatch test for sim image digest without matching architecture.
- Jangar actuation expiry test.
- slippage and post-cost expectancy guardrail tests.
- `/trading/status` contract test proving live submission readiness is not promotion approval.

Required read-only production checks:

- `curl http://torghut.torghut.svc.cluster.local/healthz`
- `curl http://torghut.torghut.svc.cluster.local/db-check`
- `curl http://torghut.torghut.svc.cluster.local/trading/health`
- `curl http://torghut.torghut.svc.cluster.local/trading/status`
- `kubectl get pods -n torghut -o wide`
- bounded SQL watermarks for `trade_decisions`, `position_snapshots`, `trade_cursor`, options watermarks, empirical
  rows, strategy hypotheses, and autoresearch tables.

Pass criteria for non-observe capital:

- Jangar actuation `allow`.
- cell data watermarks fresh for the market segment.
- empirical jobs not stale.
- simulator proof healthy when required.
- post-cost expectancy above the cell threshold.
- slippage below the cell threshold.
- rollback recipe present.

## Rollout Plan

1. Shadow-calculate profit actuation cells without changing trading behavior.
2. Surface cell decisions and vetoes in `/trading/status`.
3. Require Jangar actuation id for new canary/live/scale requests.
4. Enable marketplace budget assignment for shadow and canary only.
5. Promote one cell at a time after two consecutive fresh proof windows.
6. Scale only after post-cost edge and slippage remain inside budget through the configured holdout window.

## Rollback Plan

Rollback is cell-local:

1. Mark the affected cell `quarantine`.
2. Set capital budget to zero.
3. Preserve the evidence and reason codes.
4. Keep unrelated cells in their current stage if their Jangar actuation and economic proof remain fresh.
5. Re-enter shadow only after the failed proof surface is repaired and a new marketplace score is written.

## Risks

- Marketplace scoring can hide policy choices. Mitigation: every score must expose reason codes and raw gate inputs.
- Empty autoresearch tables can stall the innovation lane. Mitigation: keep shadow cells active while blocking capital.
- Live submission readiness can still be misread. Mitigation: rename UI/API fields so capital stage and cell decision
  lead, with live submission as a lower-level dependency.
- Jangar actuation can become too conservative. Mitigation: Jangar only vetoes platform risk; Torghut owns economic
  approval and cell-local shadow learning.

## Engineer Handoff

Start with read-only marketplace calculation and explicit veto mapping. Do not change order submission in the first
milestone. The first implementation is successful when `/trading/status` can show each current hypothesis with a
profit actuation cell id, Jangar actuation id, decision, vetoes, and expiry.

Acceptance gates:

- current `H-CONT-01`, `H-MICRO-01`, and `H-REV-01` fixtures match the May 5 decisions;
- empty autoresearch and promotion tables block capital but do not block shadow measurement;
- simulator platform mismatch quarantines only sim-dependent cells;
- Jangar platform actuation is required for canary/live/scale;
- post-cost and slippage thresholds are visible per cell.

## Deployer Handoff

Do not use `live_submission_gate.allowed=true` as promotion approval. Use profit actuation cell decisions. A Torghut
deploy is healthy for serving if `/healthz`, `/db-check`, and `/trading/health` pass, but capital promotion remains
blocked until the relevant cell has fresh Jangar actuation, fresh data watermarks, current empirical proof, and a
rollback recipe. If one sim revision is platform-blocked, quarantine the sim cells and keep live measurement running.

Acceptance gates:

- affected cell demotion does not stop unrelated healthy cells;
- stale options watermarks keep options cells in quarantine;
- stale empirical jobs block canary/live/scale;
- Jangar actuation block is visible in Torghut status;
- rollback evidence remains queryable after demotion.
