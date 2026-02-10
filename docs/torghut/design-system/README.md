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
- **Paper trading is the default** (`TRADING_MODE=paper`, `TRADING_LIVE_ENABLED=false`).
- AI is **advisory** and is never allowed to bypass deterministic risk policies.
- All “go-live” paths require explicit enablement flags and auditable change control.

## Recommended entrypoint (single merged doc)
- `docs/torghut/design-system/v1/torghut-autonomous-trading-system.md`

## Design doc set

- `v2/` - research and profitability blueprint for a more autonomous system (not production-facing; may drift).
  - Entry point: `docs/torghut/design-system/v2/index.md`

- `v1/` - first cohesive design-system pass aligned to production reality as of **2026-02-08**.

### v1 Index
| Doc | Title |
| --- | --- |
| `v1/overview.md` | Overview |
| `v1/architecture-and-context.md` | Architecture and context |
| `v1/component-ws-forwarder.md` | Component: WS forwarder |
| `v1/component-kafka-topics-and-retention.md` | Component: Kafka topics and retention |
| `v1/component-schema-registry-and-evolution.md` | Component: schema registry and evolution |
| `v1/component-flink-ta-job.md` | Component: Flink TA job |
| `v1/component-flink-watermarks-and-latency.md` | Component: Flink watermarks and latency |
| `v1/component-clickhouse-schema-and-views.md` | Component: ClickHouse schema and views |
| `v1/component-clickhouse-capacity-ttl-and-disk-guardrails.md` | Component: ClickHouse capacity, TTL, disk guardrails |
| `v1/component-postgres-schema-and-migrations.md` | Component: Postgres schema and migrations |
| `v1/component-trading-loop.md` | Component: trading loop |
| `v1/component-risk-engine.md` | Component: risk engine |
| `v1/component-order-execution-and-idempotency.md` | Component: order execution and idempotency |
| `v1/component-reconciliation.md` | Component: reconciliation |
| `v1/component-strategy-catalog-and-hot-reload.md` | Component: strategy catalog and hot reload |
| `v1/strategy-authoring-kit.md` | Strategy authoring kit |
| `v1/backtesting-and-simulation.md` | Backtesting and simulation |
| `v1/test-harness-and-fixtures.md` | Test harness and fixtures |
| `v1/data-quality-and-dedup-contracts.md` | Data quality and dedup contracts |
| `v1/observability-metrics-logs-traces.md` | Observability: metrics, logs, traces |
| `v1/alerting-slos-and-oncall.md` | Alerting, SLOs, oncall |
| `v1/operations-ta-replay-and-recovery.md` | Operations: TA replay and recovery |
| `v1/operations-ws-connection-limit-and-auth.md` | Operations: WS connection limit and auth |
| `v1/operations-clickhouse-replica-and-keeper.md` | Operations: ClickHouse replica and keeper |
| `v1/operations-knative-revision-failures.md` | Operations: Knative revision failures |
| `v1/security-threat-model.md` | Security: threat model |
| `v1/security-secrets-rotation.md` | Security: secrets rotation |
| `v1/security-network-and-rbac.md` | Security: network and RBAC |
| `v1/security-audit-logging-and-immutability.md` | Security: audit logging and immutability |
| `v1/ci-cd-and-release-process.md` | CI/CD and release process |
| `v1/argo-gitops-and-overlays.md` | Argo GitOps and overlays |
| `v1/knative-scaling-and-concurrency.md` | Knative scaling and concurrency |
| `v1/kafka-scaling-partitioning-and-ordering.md` | Kafka scaling, partitioning, ordering |
| `v1/flink-scaling-checkpoints-and-upgrades.md` | Flink scaling, checkpoints, upgrades |
| `v1/clickhouse-performance-tuning.md` | ClickHouse performance tuning |
| `v1/trading-safety-kill-switches.md` | Trading safety kill switches |
| `v1/ai-layer-overview.md` | AI layer overview |
| `v1/ai-layer-llm-review-and-policy.md` | AI layer: LLM review and policy |
| `v1/ai-layer-circuit-breakers-and-fallbacks.md` | AI layer: circuit breakers and fallbacks |
| `v1/ai-layer-novel-capabilities-roadmap.md` | AI layer: novel capabilities roadmap |
| `v1/ai-layer-model-risk-management.md` | AI layer: model risk management |
| `v1/ai-layer-evaluation-and-benchmarks.md` | AI layer: evaluation and benchmarks |
| `v1/ai-layer-prompting-and-schemas.md` | AI layer: prompting and schemas |
| `v1/data-governance-and-retention.md` | Data governance and retention |
| `v1/disaster-recovery-and-backups.md` | Disaster recovery and backups |
| `v1/multi-venue-and-broker-abstraction.md` | Multi-venue and broker abstraction |
| `v1/compliance-and-auditability.md` | Compliance and auditability |
| `v1/cost-model-and-budgets.md` | Cost model and budgets |
| `v1/performance-low-latency-notes.md` | Performance and low-latency notes |
| `v1/api-contracts-and-jangar-integration.md` | API contracts and Jangar integration |
| `v1/component-jangar-trading-history-ui.md` | Component: Jangar trading history UI |
| `v1/current-state-and-gap-analysis-2026-02-08.md` | Current state and gap analysis (2026-02-08) |
| `v1/agentruns-handoff.md` | AgentRuns handoff (production handoff pack) |
| `v1/torghut-autonomous-trading-system.md` | Merged production design (single doc) |

## Related existing docs (legacy / supporting)
- `docs/torghut/system-design.md` - consolidated design snapshot.
- `docs/torghut/operations-legacy.md` - legacy operations notes.
- `docs/torghut/topics-and-schemas.md` - Kafka and schema notes.
- `argocd/applications/torghut/**` - deployed manifests (source of truth for current config).
