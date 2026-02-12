# Autonomous Quant Completion Gap and Rollout Checklist

## Status
- Version: `v3-completion-gap-2026-02-12`
- Owner: `torghut`
- Priority: `critical`

## Purpose
Capture every blocking gap for a fully autonomous quant+LLM loop and provide a single implementation-and-rollout checklist to close them.

## Verified Live State (2026-02-12)
- LEAN adapter routing is active (`TRADING_EXECUTION_ADAPTER=lean`, policy `all`, fallback `alpaca`).
- Autonomy loop is running and triggering every interval (`runs_total` increments), but `signals_total` is `0` in the same windows observed.
- Live `trading/decisions`/execution counters are currently flat.
- Executions contain route metadata in raw payload, but persisted `execution_expected_adapter`/`execution_actual_adapter` are all `NULL`.
- Research tables (`research_runs`, `research_candidates`, `research_fold_metrics`, `research_stress_metrics`, `research_promotions`) exist but are empty.
- Cluster role `torghut_app` currently has no direct privileges on `research_*` tables.

## Completion Criteria
1. Route provenance is complete and queryable on all new fills (and backfilled for historical rows).
2. Research lane writes are durable under the runtime DB role and observable with clear evidence rows per run.
3. Autonomy signal path proves non-zero throughput in production windows and surfaces block reasons when disabled/empty.
4. Live paper/canary transitions are blocked unless gate evidence and promotion rows exist.
5. Metrics expose execution-route and fallback behavior in near real-time.

## Workstream A: Route Provenance and Backfill
- Ensure `sync_order_to_db` and reconcile paths always persist both expected and actual adapters from:
  - response payload markers (`_execution_route_*`, `_execution_adapter`)
  - execution client route (`last_route`)
  - fallback normalization (`alpaca_fallback` -> `alpaca`)
- Add backfill migration to derive missing route values from persisted raw order JSON.
- Add migration-level grants for `torghut_app` on all `research_*` tables.

## Workstream B: Autonomous Research Persistence
- Keep `run_autonomous_lane(..., persist_results=True)` writes active in live runtime path.
- Validate via:
  - SQL counts for `research_runs` and related children.
  - Promotion rows for recommendation/reject reasons.
- If persisted rows remain missing, add explicit rollback logging for failed writes and hard-fail in strict mode.

## Workstream C: Signal Throughput and Controls
- Confirm WS/TA signal chain produces non-empty batches in live windows:
  - signal table visibility,
  - cursor advancement behavior on empty batches,
  - universe symbol allowlist consistency with WS symbols.
- Add staged alerting on consecutive zero-signal windows and cursor stalls.

## Workstream D: Operational Rollout
- Apply schema/migration rollout in this order:
  1. `services/torghut` migration upgrade for route/grant patch.
  2. Deploy service image with route persistence fixes.
  3. Verify `/trading/metrics`, `/trading/executions`, and `research_*` row counts post-deploy.
- Record evidence artifacts in PR description:
  - execution route null rate,
  - research table write counts,
  - first three lane runs with gate decisions and patch artifacts.
