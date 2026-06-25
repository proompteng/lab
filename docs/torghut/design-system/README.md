# Torghut Design System (Trading System) - Design Docs

This folder contains **production-facing** design documentation for the Torghut trading system, intended to be
usable by:

- **Oncall engineers** diagnosing incidents and performing recovery.
- **Implementers** extending the system safely (especially around trading and AI advisory).

The v1 documents are written to stay consistent with:

- Existing Torghut documentation in `docs/torghut/`.
- The currently deployed GitOps manifests in `argocd/applications/torghut/**`.

## Scope (end-to-end)

- Websocket forwarder (Alpaca WS) → Kafka
- Kafka topics, schema registry, evolution, and retention
- Flink technical analysis (TA) job and operational semantics
- ClickHouse storage (schema, TTL, disk guardrails)
- Postgres trading/audit database
- Knative trading service (Torghut service) and trading loop
- Strategy catalog + authoring kit
- Risk engine, execution, reconciliation
- Observability, security, CI/CD, incident response
- AI advisory layer (bounded + gated by deterministic controls; **paper by default**)

## Safety principles (non-negotiable)

- **Paper trading is the default** (`TRADING_MODE=paper`).
- AI is **advisory** and is never allowed to bypass deterministic risk policies.
- All “go-live” paths require explicit enablement flags and auditable change control.

## Current navigation and source-of-truth guide

If you are trying to decide which docs are current contract truth versus historical milestone records, start with:

- `docs/torghut/design-system/current-source-of-truth-and-priority-guide-2026-03-09.md`
- `docs/agents/designs/203-jangar-foreclosure-carry-rollout-witness-and-stage-debt-repair-2026-05-14.md`
- `docs/torghut/design-system/v6/209-torghut-verification-carry-import-and-alpha-repair-release-2026-05-14.md`
- `docs/torghut/design-system/v6/208-torghut-jangar-verification-carry-bridge-and-no-delta-reentry-market-2026-05-14.md`
- `docs/agents/designs/202-jangar-verification-carry-export-and-repair-slot-reconciliation-2026-05-14.md`
- `docs/torghut/design-system/v6/207-torghut-quant-plan-closeout-and-alpha-repair-reentry-handoff-2026-05-14.md`
- `docs/torghut/design-system/v6/206-torghut-no-delta-repair-reentry-auction-and-verification-carry-2026-05-14.md`
- `docs/agents/designs/201-jangar-verify-trust-foreclosure-and-alpha-repair-reentry-2026-05-14.md`
- `docs/torghut/design-system/v6/205-torghut-alpha-readiness-settlement-conveyor-and-routeable-profit-runway-2026-05-14.md`
- `docs/agents/designs/200-jangar-revenue-repair-settlement-conveyor-and-stage-health-custody-2026-05-14.md`
- `docs/torghut/design-system/v6/204-torghut-alpha-repair-dividend-ledger-and-custody-flight-recorder-2026-05-14.md`
- `docs/agents/designs/199-jangar-material-action-custody-flight-recorder-and-merge-reentry-slo-2026-05-14.md`
- `docs/torghut/design-system/v6/197-torghut-alpha-readiness-strike-ledger-and-routeable-candidate-ladder-2026-05-13.md`
- `docs/agents/designs/192-jangar-alpha-readiness-repair-escrow-and-runner-admission-2026-05-13.md`
- `docs/torghut/design-system/v6/190-torghut-repair-bid-settlement-and-routeability-proof-compaction-2026-05-13.md`
- `docs/agents/designs/186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md`
- `docs/torghut/design-system/v6/188-torghut-evidence-clock-arbiter-and-routeable-profit-candidate-exchange-2026-05-12.md`
- `docs/agents/designs/184-jangar-rollout-custody-and-evidence-clock-dispatch-2026-05-12.md`
- `docs/torghut/design-system/v6/188-torghut-route-evidence-clearinghouse-and-execution-freshness-market-2026-05-12.md`
- `docs/agents/designs/184-jangar-rollout-evidence-escrow-and-proof-repair-admission-2026-05-12.md`
- `docs/torghut/design-system/v6/188-torghut-evidence-credit-capital-repair-market-2026-05-12.md`
- `docs/agents/designs/184-jangar-stage-evidence-credit-authority-and-freeze-reclock-2026-05-12.md`
- `docs/torghut/design-system/v6/188-torghut-profit-freshness-frontier-and-zero-notional-repair-market-2026-05-12.md`
- `docs/agents/designs/184-jangar-reliability-settlement-ledger-and-rollout-slo-escrow-2026-05-12.md`
- `docs/torghut/design-system/v6/168-torghut-executable-alpha-receipts-and-capital-replay-board-2026-05-07.md`
- `docs/agents/designs/164-jangar-contract-graduation-brake-and-runtime-receipt-gates-2026-05-07.md`
- `docs/torghut/design-system/v6/159-torghut-capital-cohort-frontier-and-routeability-repair-board-2026-05-07.md`
- `docs/agents/designs/155-jangar-execution-cohort-settlement-and-launch-quarantine-2026-05-07.md`
- `docs/torghut/design-system/v6/158-torghut-capital-proof-provenance-and-routeable-edge-repair-ledger-2026-05-07.md`
- `docs/agents/designs/154-jangar-source-provenance-leases-and-material-action-escrow-2026-05-07.md`
- `docs/torghut/design-system/v6/157-torghut-profit-contract-actuation-and-capital-surface-truth-2026-05-07.md`
- `docs/agents/designs/153-jangar-design-actuation-ledger-and-contract-convergence-gates-2026-05-07.md`
- `docs/torghut/design-system/v6/155-torghut-capital-repair-outcome-ledger-and-edge-reacquisition-gates-2026-05-07.md`
- `docs/agents/designs/151-jangar-repair-outcome-settlement-and-schedule-debt-roi-exchange-2026-05-07.md`
- `docs/torghut/design-system/v6/156-torghut-repair-closure-yield-ledger-and-capital-unlock-receipts-2026-05-07.md`
- `docs/agents/designs/152-jangar-material-verdict-authority-and-contradiction-debt-ledger-2026-05-07.md`
- `docs/torghut/design-system/v6/154-torghut-marginal-proof-spend-portfolio-and-capital-repair-budget-2026-05-07.md`
- `docs/agents/designs/150-jangar-controller-brownout-budgets-and-proof-spend-admission-exchange-2026-05-07.md`
- `docs/torghut/design-system/v6/153-torghut-useful-evidence-capital-escrow-and-provider-repair-gates-2026-05-07.md`
- `docs/agents/designs/149-jangar-wrapper-truth-settlement-and-useful-evidence-gates-2026-05-07.md`
- `docs/agents/designs/148-jangar-source-rollout-truth-exchange-and-proof-floor-settlement-2026-05-07.md`
- `docs/torghut/design-system/v6/152-torghut-proof-floor-settlement-bonds-and-tca-repair-auction-2026-05-07.md`
- `docs/agents/designs/147-jangar-hypothesis-scoped-capital-adjudication-ledger-2026-05-07.md`
- `docs/torghut/design-system/v6/151-torghut-hypothesis-scoped-capital-adjudication-and-profit-gates-2026-05-07.md`
- `docs/agents/designs/143-jangar-route-stable-status-snapshot-escrow-and-repair-actuation-windows-2026-05-07.md`
- `docs/torghut/design-system/v6/147-torghut-stale-proof-repair-exchange-and-route-stable-capital-quorum-2026-05-07.md`
- `docs/agents/designs/118-jangar-repair-admission-governor-and-profit-renewal-bids-2026-05-06.md`
- `docs/torghut/design-system/v6/122-torghut-profit-renewal-bids-and-capital-shadow-ledger-2026-05-06.md`
- `docs/agents/designs/117-jangar-opening-proof-reconciliation-and-account-scope-capital-veto-2026-05-06.md`
- `docs/torghut/design-system/v6/121-torghut-opening-bell-proof-ladder-and-account-scoped-alpha-reentry-2026-05-06.md`
- `docs/agents/designs/116-jangar-controller-witness-quorum-and-capital-activation-receipts-2026-05-06.md`
- `docs/torghut/design-system/v6/120-torghut-capital-activation-receipts-and-shadow-profit-proof-queue-2026-05-06.md`
- `docs/agents/designs/115-jangar-watch-quiescence-and-evidence-renewal-arbiter-2026-05-06.md`
- `docs/torghut/design-system/v6/119-torghut-evidence-renewal-batches-and-capital-quiescence-gates-2026-05-06.md`
- `docs/agents/designs/114-jangar-evidence-transport-ledger-and-watch-restart-circuit-breakers-2026-05-06.md`
- `docs/torghut/design-system/v6/118-torghut-proof-route-parity-and-options-informed-repair-scheduler-2026-05-06.md`
- `docs/agents/designs/97-jangar-discover-cutover-handoff-and-proof-debt-gates-2026-05-06.md`
- `docs/torghut/design-system/v6/101-torghut-proof-debt-retirement-and-shadow-capital-handoff-2026-05-06.md`
- `docs/agents/designs/77-jangar-evidence-settlement-authority-and-data-proof-handoff-2026-05-05.md`
- `docs/torghut/design-system/v6/81-torghut-capital-proof-reconciliation-and-jangar-settlement-consumer-2026-05-05.md`
- `docs/agents/designs/76-jangar-rollout-settlement-fuses-and-proof-reclocking-2026-05-05.md`
- `docs/torghut/design-system/v6/80-torghut-capital-proof-reclocking-and-live-submission-fuses-2026-05-05.md`
- `docs/agents/designs/65-jangar-recovery-epoch-cutover-and-backlog-seat-enforcement-contract-2026-03-21.md`
- `docs/torghut/design-system/v6/64-torghut-profit-window-cutover-and-escrow-enforcement-contract-2026-03-21.md`
- `docs/agents/designs/62-jangar-execution-receipts-and-stage-recovery-cells-contract-2026-03-20.md`
- `docs/torghut/design-system/v6/61-torghut-evidence-seats-and-profit-repair-exchange-contract-2026-03-20.md`
- `docs/agents/designs/57-jangar-authority-capsules-and-readiness-class-separation-2026-03-20.md`
- `docs/torghut/design-system/v6/56-torghut-capability-leases-and-profit-clocks-2026-03-20.md`
- `docs/agents/designs/55-jangar-rollout-fact-receipts-and-swarm-freeze-parity-2026-03-20.md`
- `docs/torghut/design-system/v6/54-torghut-capital-lease-receipts-and-profit-falsification-ledger-2026-03-20.md`
- `docs/agents/designs/51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`
- `docs/agents/designs/54-jangar-admission-receipts-rollout-shadow-and-anti-entropy-reconciliation-2026-03-20.md`
- `docs/agents/designs/52-jangar-segment-authority-graph-and-promotion-certificate-fail-safe-2026-03-19.md`
- `docs/agents/designs/50-torghut-hypothesis-capital-governor-and-data-quorum-2026-03-19.md`
- `docs/agents/designs/52-jangar-rollout-epoch-witness-and-segment-circuit-breakers-2026-03-19.md`
- `docs/agents/designs/53-jangar-dependency-provenance-ledger-and-consumer-acknowledged-admission-2026-03-19.md`
- `docs/torghut/design-system/v6/50-torghut-submission-parity-council-and-options-bootstrap-escrow-2026-03-19.md`
- `docs/torghut/design-system/v6/51-torghut-profit-reservations-schema-witness-and-simulation-slot-ledger-2026-03-19.md`
- `docs/torghut/design-system/v6/51-torghut-promotion-certificate-and-segment-firebreak-handoff-2026-03-19.md`
- `docs/torghut/design-system/v6/52-torghut-profit-sleeves-segment-scoped-deallocation-and-evidence-decay-2026-03-19.md`
- `docs/torghut/design-system/v6/53-torghut-capital-leases-and-profit-trial-firebreaks-2026-03-20.md`

That guide is the canonical reading order for the current corpus.

If you need the discover-stage rationale directly beneath that current stack, also read:

- `docs/agents/designs/57-jangar-authority-capsules-and-route-parity-contract-2026-03-20.md`
- `docs/torghut/design-system/v6/56-torghut-profit-clocks-and-lane-falsification-exchange-2026-03-20.md`

## Recommended entrypoint (single merged doc)

- `docs/torghut/design-system/v1/torghut-autonomous-trading-system.md`

## Implementation Audit

- Document-by-document implementation status matrix:
- `docs/torghut/design-system/implementation-status-matrix-2026-02-21.md`
- `docs/torghut/design-system/implementation-audit.md`

## Corpus implementation status (historical 2026-03-01 snapshot)

These counts are a dated snapshot, not a current live status board. They remain useful as a corpus-history checkpoint,
but newer v6 docs and the current source-of-truth guide supersede them for present decisions.

- root: total=2 (Implemented=0, Partial=0, Planned=2)
- v1: total=60 (Implemented=11, Partial=44, Planned=5)
- v2: total=25 (Implemented=0, Partial=17, Planned=8)
- v3: total=37 (Implemented=4, Partial=29, Planned=4)
- v4: total=11 (Implemented=0, Partial=1, Planned=10)
- v5: total=15 (Implemented=0, Partial=7, Planned=8)
- v6: total=12 (Implemented=0, Partial=5, Planned=7)

- Evidence-sync checkpoint: `implementation-audit.md`

## Design doc set

- `v2/` - research and profitability blueprint for a more autonomous system (not production-facing; may drift).
  - Entry point: `docs/torghut/design-system/v2/index.md`

- `v3/` - production handoff for flexible quant strategy engine + full-loop autonomous operation.
  - Entry point: `docs/torghut/design-system/v3/index.md`

- `v4/` - fresh quant/LLM profitability expansion pack grounded in 2024-2025 papers and white papers.
  - Entry point: `docs/torghut/design-system/v4/index.md`

- `v5/` - production-quality strategy build pack for the top 5 new quant+LLM priorities (2026-02-21),
  with comprehensive design docs and per-paper technique synthesis.
  - Entry point: `docs/torghut/design-system/v5/index.md`

- `v6/` - beyond-TSMOM intraday autonomy pack translating fresh multi-agent, regime-routing, contamination-safe
  evaluation, benchmark parity, and profitability operating-system research into production implementation docs.
  This pack now contains both active contract docs and dated closeout/proof records; use the current source-of-truth
  guide before treating a `Completed` or `Closeout` note as current truth.
  - Entry point: `docs/torghut/design-system/v6/index.md`

- `v1/` - first cohesive design-system pass aligned to production reality as of **2026-02-08**.
  - Entry point: `docs/torghut/design-system/v1/index.md`

### v1 Index

| Doc                                                           | Title                                                |
| ------------------------------------------------------------- | ---------------------------------------------------- |
| `v1/overview.md`                                              | Overview                                             |
| `v1/architecture-and-context.md`                              | Architecture and context                             |
| `v1/component-ws-forwarder.md`                                | Component: WS forwarder                              |
| `v1/component-kafka-topics-and-retention.md`                  | Component: Kafka topics and retention                |
| `v1/component-schema-registry-and-evolution.md`               | Component: schema registry and evolution             |
| `v1/component-flink-ta-job.md`                                | Component: Flink TA job                              |
| `v1/component-flink-watermarks-and-latency.md`                | Component: Flink watermarks and latency              |
| `v1/component-clickhouse-schema-and-views.md`                 | Component: ClickHouse schema and views               |
| `v1/component-clickhouse-capacity-ttl-and-disk-guardrails.md` | Component: ClickHouse capacity, TTL, disk guardrails |
| `v1/component-postgres-schema-and-migrations.md`              | Component: Postgres schema and migrations            |
| `v1/component-trading-loop.md`                                | Component: trading loop                              |
| `v1/component-risk-engine.md`                                 | Component: risk engine                               |
| `v1/component-order-execution-and-idempotency.md`             | Component: order execution and idempotency           |
| `v1/component-reconciliation.md`                              | Component: reconciliation                            |
| `v1/component-strategy-catalog-and-hot-reload.md`             | Component: strategy catalog and hot reload           |
| `v1/strategy-authoring-kit.md`                                | Strategy authoring kit                               |
| `v1/backtesting-and-simulation.md`                            | Backtesting and simulation                           |
| `v1/historical-dataset-simulation.md`                         | Historical dataset simulation                        |
| `v1/test-harness-and-fixtures.md`                             | Test harness and fixtures                            |
| `v1/data-quality-and-dedup-contracts.md`                      | Data quality and dedup contracts                     |
| `v1/observability-metrics-logs-traces.md`                     | Observability: metrics, logs, traces                 |
| `v1/alerting-slos-and-oncall.md`                              | Alerting, SLOs, oncall                               |
| `v1/operations-ta-replay-and-recovery.md`                     | Operations: TA replay and recovery                   |
| `v1/operations-ws-connection-limit-and-auth.md`               | Operations: WS connection limit and auth             |
| `v1/operations-clickhouse-replica-and-keeper.md`              | Operations: ClickHouse replica and keeper            |
| `v1/operations-knative-revision-failures.md`                  | Operations: Knative revision failures                |
| `v1/operations-actuation-runner.md`                           | Operations: gated actuation runner                   |
| `v1/security-threat-model.md`                                 | Security: threat model                               |
| `v1/security-secrets-rotation.md`                             | Security: secrets rotation                           |
| `v1/security-audit-logging-and-immutability.md`               | Security: audit logging and immutability             |
| `v1/ci-cd-and-release-process.md`                             | CI/CD and release process                            |
| `v1/argo-gitops-and-overlays.md`                              | Argo GitOps and overlays                             |
| `v1/knative-scaling-and-concurrency.md`                       | Knative scaling and concurrency                      |
| `v1/kafka-scaling-partitioning-and-ordering.md`               | Kafka scaling, partitioning, ordering                |
| `v1/flink-scaling-checkpoints-and-upgrades.md`                | Flink scaling, checkpoints, upgrades                 |
| `v1/clickhouse-performance-tuning.md`                         | ClickHouse performance tuning                        |
| `v1/trading-safety-kill-switches.md`                          | Trading safety kill switches                         |
| `v1/ai-layer-overview.md`                                     | AI layer overview                                    |
| `v1/ai-layer-llm-review-and-policy.md`                        | AI layer: LLM review and policy                      |
| `v1/ai-layer-circuit-breakers-and-fallbacks.md`               | AI layer: circuit breakers and fallbacks             |
| `v1/ai-layer-novel-capabilities-roadmap.md`                   | AI layer: novel capabilities roadmap                 |
| `v1/ai-layer-model-risk-management.md`                        | AI layer: model risk management                      |
| `v1/ai-layer-evaluation-and-benchmarks.md`                    | AI layer: evaluation and benchmarks                  |
| `v1/ai-layer-prompting-and-schemas.md`                        | AI layer: prompting and schemas                      |
| `v1/data-governance-and-retention.md`                         | Data governance and retention                        |
| `v1/disaster-recovery-and-backups.md`                         | Disaster recovery and backups                        |
| `v1/multi-venue-and-broker-abstraction.md`                    | Multi-venue and broker abstraction                   |
| `v1/compliance-and-auditability.md`                           | Compliance and auditability                          |
| `v1/cost-model-and-budgets.md`                                | Cost model and budgets                               |
| `v1/performance-low-latency-notes.md`                         | Performance and low-latency notes                    |
| `v1/api-contracts-and-jangar-integration.md`                  | API contracts and Jangar integration                 |
| `v1/component-jangar-trading-history-ui.md`                   | Component: Jangar trading history UI                 |
| `v1/current-state-and-gap-analysis-2026-02-08.md`             | Current state and gap analysis (2026-02-08)          |
| `v1/agentruns-handoff.md`                                     | AgentRuns handoff (production handoff pack)          |
| `v1/torghut-autonomous-trading-system.md`                     | Merged production design (single doc)                |

## Related existing docs (legacy / supporting)

- `docs/torghut/system-design.md` - consolidated design snapshot.
- `docs/torghut/operations-legacy.md` - legacy operations notes.
- `docs/torghut/topics-and-schemas.md` - Kafka and schema notes.
- `argocd/applications/torghut/**` - deployed manifests (source of truth for current config).
