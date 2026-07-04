# Torghut Design-System Implementation Audit

Status: Current source-read audit, refreshed 2026-07-04.

Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.

This file summarizes the per-document audit blocks inserted into the Torghut design corpus. Five core runtime documents have been deepened beyond the initial source-audit stamp with document-specific implemented/drift/gap analysis.

## Source Surfaces Read

- Torghut service source: `services/torghut/app/**`
- Torghut scripts and tests: `services/torghut/scripts/**`, `services/torghut/tests/**`
- Torghut GitOps: `argocd/applications/torghut/**`, `argocd/applications/torghut-options/**`, `argocd/applications/torghut-hyperliquid-feed/**`, `argocd/applications/torghut-hyperliquid-runtime/**`
- Dorvud market-data/TA source: `services/dorvud/websockets/**`, `services/dorvud/technical-analysis-flink/**`
- Jangar/Torghut integration source: `services/jangar/src/routes/api/torghut/**`, `services/jangar/src/server/control-plane-torghut-*.ts`, `services/jangar/src/server/control-plane-*.ts`

## Batch 1 Deep-Dive Documents

- `docs/torghut/design-system/v1/component-trading-loop.md`
- `docs/torghut/design-system/v1/component-order-execution-and-idempotency.md`
- `docs/torghut/design-system/v1/component-risk-engine.md`
- `docs/torghut/design-system/v1/component-strategy-catalog-and-hot-reload.md`
- `docs/torghut/design-system/v1/component-postgres-schema-and-migrations.md`

## Audit Coverage

- Design documents with source audit blocks: 458
- Deep-dive batch documents: 5
- Existing audit/index files updated separately: `README.md`, `implementation-audit.md`, `implementation-status-matrix-2026-02-21.md`, `current-source-of-truth-and-priority-guide-2026-03-09.md`

## Implementation Area Counts

- 160: Proof, evidence, freshness, repair, and capital gating
- 41: Strategy, alpha, TSMOM, regime, portfolio, and sizing
- 40: Routeability, TCA, fill quality, and market context
- 29: Observability, metrics, PostHog, alerts, and operations
- 27: Execution, live submission, and broker path
- 24: CI/CD, release, GitOps, Argo, Knative, and deployment automation
- 24: Jangar/control-plane integration
- 21: Simulation, replay, backtesting, and Lean
- 20: LLM, DSPy, AI review, and model governance
- 17: Options lane
- 16: Market data, Kafka, Flink, ClickHouse, TA, and WS forwarding
- 16: Whitepaper/autoresearch workflow
- 10: Security, secrets, RBAC, audit, governance, and compliance
- 5: Empirical jobs and promotion evidence
- 2: TigerBeetle ledger and reconciliation
- 1: Execution and idempotency
- 1: Hyperliquid / crypto lane
- 1: Postgres schema and migrations
- 1: Risk engine and simple-risk caps
- 1: Strategy catalog and hot reload
- 1: Trading loop runtime

## Reading Rule

For the five batch-1 documents, use the detailed source-read audit section in each document first. For remaining documents, the existing source audit block is a triage marker and must be deepened in later batches of five.
