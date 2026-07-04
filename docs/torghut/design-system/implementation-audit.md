# Torghut Design-System Implementation Audit

Status: Current source-read audit, refreshed 2026-07-04.

Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.

This file summarizes the exhaustive per-document audit blocks now inserted into the Torghut design corpus. The audit read current source and desired state before updating the existing design documents.

## Source Surfaces Read

- Torghut service source: `services/torghut/app/**`
- Torghut scripts and tests: `services/torghut/scripts/**`, `services/torghut/tests/**`
- Torghut GitOps: `argocd/applications/torghut/**`, `argocd/applications/torghut-options/**`, `argocd/applications/torghut-hyperliquid-feed/**`, `argocd/applications/torghut-hyperliquid-runtime/**`
- Dorvud market-data/TA source: `services/dorvud/websockets/**`, `services/dorvud/technical-analysis-flink/**`
- Jangar/Torghut integration source: `services/jangar/src/routes/api/torghut/**`, `services/jangar/src/server/control-plane-torghut-*.ts`, `services/jangar/src/server/control-plane-*.ts`

## Audit Coverage

- Design documents with inserted source audit blocks: 458
- Existing audit/index files updated separately: `README.md`, `implementation-audit.md`, `implementation-status-matrix-2026-02-21.md`, `current-source-of-truth-and-priority-guide-2026-03-09.md`

## Implementation Area Counts

- 162: Proof, evidence, freshness, repair, and capital gating
- 42: Strategy, alpha, TSMOM, regime, portfolio, and sizing
- 40: Routeability, TCA, fill quality, and market context
- 29: Observability, metrics, PostHog, alerts, and operations
- 28: Execution, live submission, and broker path
- 25: CI/CD, release, GitOps, Argo, Knative, and deployment automation
- 24: Jangar/control-plane integration
- 21: Simulation, replay, backtesting, and Lean
- 20: LLM, DSPy, AI review, and model governance
- 17: Options lane
- 16: Market data, Kafka, Flink, ClickHouse, TA, and WS forwarding
- 16: Whitepaper/autoresearch workflow
- 10: Security, secrets, RBAC, audit, governance, and compliance
- 5: Empirical jobs and promotion evidence
- 2: TigerBeetle ledger and reconciliation
- 1: Hyperliquid / crypto lane

## Reading Rule

The audit block inside each design document is now the first implementation-status stop for that document. The block states source baseline, implementation status, matched implementation area, source evidence, and drift. If a design body still contains older runtime claims, the audit block and current source paths win.
