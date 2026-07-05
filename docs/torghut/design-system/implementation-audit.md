# Torghut Design-System Implementation Audit

Status: Current source-read audit, refreshed 2026-07-04.

Source baseline inspected: `d53c7a4e5 docs: deepen torghut AI docs batch 3 (#11893)`.

Codex review feedback resolution: this audit summary was refreshed against the current main baseline after the Hyperliquid feed deployment changed after the original triage-audit baseline. Per-document triage blocks that still mention the original baseline remain triage markers until deepened in later batches.

This file summarizes the per-document audit blocks inserted into the Torghut design corpus. Core documents are being deepened in batches of five with document-specific implemented/drift/gap analysis.

## Source Surfaces Read

- Torghut service source: `services/torghut/app/**`
- Torghut scripts and tests: `services/torghut/scripts/**`, `services/torghut/tests/**`
- Torghut GitOps: `argocd/applications/torghut/**`, `argocd/applications/torghut-options/**`, `argocd/applications/torghut-hyperliquid-feed/**`, `argocd/applications/torghut-hyperliquid-runtime/**`
- Dorvud market-data/TA source: `services/dorvud/websockets/**`, `services/dorvud/technical-analysis-flink/**`
- Jangar/Torghut integration source: `services/jangar/src/routes/api/torghut/**`, `services/jangar/src/server/control-plane-torghut-*.ts`, `services/jangar/src/server/control-plane-*.ts`

## Deep-Dive Batches Completed

### Batch 1: core Torghut runtime

- `docs/torghut/design-system/v1/component-order-execution-and-idempotency.md`
- `docs/torghut/design-system/v1/component-postgres-schema-and-migrations.md`
- `docs/torghut/design-system/v1/component-risk-engine.md`
- `docs/torghut/design-system/v1/component-strategy-catalog-and-hot-reload.md`
- `docs/torghut/design-system/v1/component-trading-loop.md`

### Batch 2: market-data and TA data plane

- `docs/torghut/design-system/v1/component-clickhouse-schema-and-views.md`
- `docs/torghut/design-system/v1/component-flink-ta-job.md`
- `docs/torghut/design-system/v1/component-flink-watermarks-and-latency.md`
- `docs/torghut/design-system/v1/component-kafka-topics-and-retention.md`
- `docs/torghut/design-system/v1/component-ws-forwarder.md`

### Batch 3: LLM and AI advisory layer

- `docs/torghut/design-system/v1/ai-layer-circuit-breakers-and-fallbacks.md`
- `docs/torghut/design-system/v1/ai-layer-evaluation-and-benchmarks.md`
- `docs/torghut/design-system/v1/ai-layer-llm-review-and-policy.md`
- `docs/torghut/design-system/v1/ai-layer-model-risk-management.md`
- `docs/torghut/design-system/v1/ai-layer-prompting-and-schemas.md`

## Audit Coverage

- Design documents with source audit blocks: 458
- Deep-dive batch documents: 15
- Triage audit documents remaining: 443

## Implementation Area Counts

- 160: Proof, evidence, freshness, repair, and capital gating
- 41: Strategy, alpha, TSMOM, regime, portfolio, and sizing
- 40: Routeability, TCA, fill quality, and market context
- 29: Observability, metrics, PostHog, alerts, and operations
- 27: Execution, live submission, and broker path
- 24: CI/CD, release, GitOps, Argo, Knative, and deployment automation
- 24: Jangar/control-plane integration
- 21: Simulation, replay, backtesting, and Lean
- 17: Options lane
- 16: Whitepaper/autoresearch workflow
- 15: LLM, DSPy, AI review, and model governance
- 11: Market data, Kafka, Flink, ClickHouse, TA, and WS forwarding
- 10: Security, secrets, RBAC, audit, governance, and compliance
- 5: Empirical jobs and promotion evidence
- 2: TigerBeetle ledger and reconciliation
- 1: ClickHouse schema and views
- 1: Execution and idempotency
- 1: Flink TA job
- 1: Flink watermarks and latency
- 1: Hyperliquid / crypto lane
- 1: Kafka topics and retention
- 1: LLM circuit breakers and fallback controls
- 1: LLM evaluation workflow
- 1: LLM model risk guardrails
- 1: LLM prompting and schemas
- 1: LLM review and policy guard
- 1: Postgres schema and migrations
- 1: Risk engine and simple-risk caps
- 1: Strategy catalog and hot reload
- 1: Trading loop runtime
- 1: WS forwarder

## Reading Rule

For batch-1 through batch-3 documents, use the detailed source-read audit section in each document first. For remaining documents, the existing source audit block is a triage marker and must be deepened in later batches of five.
