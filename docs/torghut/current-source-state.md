# Torghut Current Source State

Status: Current source-read snapshot.

Source baseline inspected: `60f683dd0 chore(release/6f50bd9): automated release PR (#11846)`.

This document is derived from live repository source and GitOps files, not from the historical Torghut design corpus.
When it conflicts with a dated design doc, this document is closer to the current source state, but source code, GitOps,
runtime readback, and CI still outrank this prose.

## Source Inputs Read

Primary code and desired-state inputs:

- API composition: `services/torghut/app/api/application.py`
- API routes: `services/torghut/app/api/**`
- Settings model: `services/torghut/app/config/settings.py`, `services/torghut/app/config/service_fields.py`,
  `services/torghut/app/config/runtime_risk_fields.py`
- Scheduler and trading runtime: `services/torghut/app/trading/scheduler/**`, `services/torghut/app/trading/execution_runtime.py`,
  `services/torghut/app/trading/execution_adapters/**`, `services/torghut/app/trading/execution_policy/**`
- Proof/readiness surfaces: `services/torghut/app/api/readiness_helpers/**`, `services/torghut/app/api/proof_floor_payloads/**`,
  `services/torghut/app/trading/proof_floor/**`, `services/torghut/app/trading/submission_council/**`
- Options lane: `services/torghut/app/options_lane/**`, `argocd/applications/torghut-options/**`
- Hyperliquid lane: `services/torghut/app/hyperliquid_execution/**`, `argocd/applications/torghut-hyperliquid-feed/**`,
  `argocd/applications/torghut-hyperliquid-runtime/**`
- Whitepaper workflow: `services/torghut/app/whitepapers/**`, `services/torghut/app/api/whitepaper.py`
- GitOps desired state: `argocd/applications/torghut/**`

## Current Runtime Shape

Torghut is a FastAPI service with a broad runtime API surface, not a single trading loop described by older design docs.
The app composition layer registers routers from `services/torghut/app/api/application.py` and the route files under
`services/torghut/app/api/**`.

Current API families in source include readiness, trading health, loop status, trading status, revenue repair,
zero-notional repair, proof/TCA, runtime profitability, consumer evidence, executions, autonomy, empirical jobs,
decisions, metrics, simulation progress, Lean backtests, and whitepaper workflow routes.

## Trading Runtime

The current trading runtime is split into modules:

- scheduler entry and modes: `services/torghut/app/trading/scheduler/runtime.py`,
  `services/torghut/app/trading/scheduler/runtime_pipeline_factory.py`, `services/torghut/app/trading/scheduler/simple_pipeline.py`,
  and `services/torghut/app/trading/scheduler/pipeline/**`;
- decision and source collection: `services/torghut/app/trading/decisions/**`,
  `services/torghut/app/trading/scheduler/source_collection/**`, and
  `services/torghut/app/trading/scheduler/target_plan_helpers/**`;
- execution path: `services/torghut/app/trading/execution_runtime.py`, `services/torghut/app/trading/execution/**`,
  `services/torghut/app/trading/execution_adapters/**`, and `services/torghut/app/trading/execution_policy/**`;
- proof and capital gating: `services/torghut/app/trading/submission_council/**`,
  `services/torghut/app/trading/proof_floor/**`, `services/torghut/app/trading/profit_freshness_frontier/**`, and
  `services/torghut/app/trading/executable_alpha_receipts/**`.

Current source still has empirical proof/status concepts through `services/torghut/app/trading/empirical_jobs.py` and
readiness/proof surfaces, but the old empirical-promotion job scripts and workflow templates that earlier designs cited
are not the active authority. Use the API/readiness/proof modules above plus current GitOps instead.

## Current Lanes

Options lane:

- source code: `services/torghut/app/options_lane/**`
- settings: `services/torghut/app/options_lane/settings.py`
- GitOps: `argocd/applications/torghut-options/**`, including catalog, enricher, websocket, and TA Flink deployment

Hyperliquid lane:

- source code: `services/torghut/app/hyperliquid_execution/**`
- runtime service class: `HyperliquidExecutionService`
- runtime readiness helper: `runtime_readiness`
- GitOps: `argocd/applications/torghut-hyperliquid-feed/**` and `argocd/applications/torghut-hyperliquid-runtime/**`

Older Torghut designs that model Torghut as only Alpaca/equity/options are incomplete for current source state.

## GitOps Current Shape

Current Torghut desired state is split across these Argo application directories:

- `argocd/applications/torghut/**` for main service, ClickHouse, Postgres, TigerBeetle, TA, TA sim, simulations,
  whitepaper buckets, rollout-analysis permissions, generated resource cleanup, and operational cronjobs;
- `argocd/applications/torghut-options/**` for options catalog, enricher, websocket, and TA Flink deployment;
- `argocd/applications/torghut-hyperliquid-feed/**` for Hyperliquid feed ingestion;
- `argocd/applications/torghut-hyperliquid-runtime/**` for Hyperliquid execution/runtime service.

Any design document that cites a removed Argo resource is historical until reconciled with these directories.

## Documentation Consequence

Future Torghut docs must check source and GitOps before using claims from `docs/torghut/design-system/**`. Include the
inspected paths in any new current-state doc and update this file when source layout changes materially.
