# Torghut Design System (Trading System) — Design Docs

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

## Design doc set
- `v1/` — first cohesive design-system pass aligned to production reality as of **2026-02-08**.

### v1 Index
| Doc | Title |
| --- | --- |
| `v1/00-overview.md` | Overview |
| `v1/01-architecture-and-context.md` | Architecture and context |
| `v1/02-component-ws-forwarder.md` | Component: WS forwarder |
| `v1/03-component-kafka-topics-and-retention.md` | Component: Kafka topics and retention |
| `v1/04-component-schema-registry-and-evolution.md` | Component: schema registry and evolution |
| `v1/05-component-flink-ta-job.md` | Component: Flink TA job |
| `v1/06-component-flink-watermarks-and-latency.md` | Component: Flink watermarks and latency |
| `v1/07-component-clickhouse-schema-and-views.md` | Component: ClickHouse schema and views |
| `v1/08-component-clickhouse-capacity-ttl-and-disk-guardrails.md` | Component: ClickHouse capacity, TTL, disk guardrails |
| `v1/09-component-postgres-schema-and-migrations.md` | Component: Postgres schema and migrations |
| `v1/10-component-trading-loop.md` | Component: trading loop |
| `v1/11-component-risk-engine.md` | Component: risk engine |
| `v1/12-component-order-execution-and-idempotency.md` | Component: order execution and idempotency |
| `v1/13-component-reconciliation.md` | Component: reconciliation |
| `v1/14-component-strategy-catalog-and-hot-reload.md` | Component: strategy catalog and hot reload |
| `v1/15-strategy-authoring-kit.md` | Strategy authoring kit |
| `v1/16-backtesting-and-simulation.md` | Backtesting and simulation |
| `v1/17-test-harness-and-fixtures.md` | Test harness and fixtures |
| `v1/18-data-quality-and-dedup-contracts.md` | Data quality and dedup contracts |
| `v1/19-observability-metrics-logs-traces.md` | Observability: metrics, logs, traces |
| `v1/20-alerting-slos-and-oncall.md` | Alerting, SLOs, oncall |
| `v1/21-runbooks-ta-replay-and-recovery.md` | Runbooks: TA replay and recovery |
| `v1/22-runbooks-ws-connection-limit-and-auth.md` | Runbooks: WS connection limit and auth |
| `v1/23-runbooks-clickhouse-replica-and-keeper.md` | Runbooks: ClickHouse replica and keeper |
| `v1/24-runbooks-knative-revision-failures.md` | Runbooks: Knative revision failures |
| `v1/25-security-threat-model.md` | Security: threat model |
| `v1/26-security-secrets-rotation.md` | Security: secrets rotation |
| `v1/27-security-network-and-rbac.md` | Security: network and RBAC |
| `v1/28-security-audit-logging-and-immutability.md` | Security: audit logging and immutability |
| `v1/29-ci-cd-and-release-process.md` | CI/CD and release process |
| `v1/30-argo-gitops-and-overlays.md` | Argo GitOps and overlays |
| `v1/31-knative-scaling-and-concurrency.md` | Knative scaling and concurrency |
| `v1/32-kafka-scaling-partitioning-and-ordering.md` | Kafka scaling, partitioning, ordering |
| `v1/33-flink-scaling-checkpoints-and-upgrades.md` | Flink scaling, checkpoints, upgrades |
| `v1/34-clickhouse-performance-tuning.md` | ClickHouse performance tuning |
| `v1/35-trading-safety-kill-switches.md` | Trading safety kill switches |
| `v1/36-ai-layer-overview.md` | AI layer overview |
| `v1/37-ai-layer-llm-review-and-policy.md` | AI layer: LLM review and policy |
| `v1/38-ai-layer-circuit-breakers-and-fallbacks.md` | AI layer: circuit breakers and fallbacks |
| `v1/39-ai-layer-novel-capabilities-roadmap.md` | AI layer: novel capabilities roadmap |
| `v1/40-ai-layer-model-risk-management.md` | AI layer: model risk management |
| `v1/41-ai-layer-evaluation-and-benchmarks.md` | AI layer: evaluation and benchmarks |
| `v1/42-ai-layer-prompting-and-schemas.md` | AI layer: prompting and schemas |
| `v1/43-data-governance-and-retention.md` | Data governance and retention |
| `v1/44-disaster-recovery-and-backups.md` | Disaster recovery and backups |
| `v1/45-multi-venue-and-broker-abstraction.md` | Multi-venue and broker abstraction |
| `v1/46-compliance-and-auditability.md` | Compliance and auditability |
| `v1/47-cost-model-and-budgets.md` | Cost model and budgets |
| `v1/48-performance-low-latency-notes.md` | Performance and low-latency notes |
| `v1/49-api-contracts-and-jangar-integration.md` | API contracts and Jangar integration |
| `v1/50-current-state-and-gap-analysis-2026-02-08.md` | Current state and gap analysis (2026-02-08) |

## Related existing docs (legacy / supporting)
- `docs/torghut/system-design.md` — consolidated design snapshot.
- `docs/torghut/runbooks.md` — existing runbooks.
- `docs/torghut/topics-and-schemas.md` — Kafka and schema notes.
- `argocd/applications/torghut/**` — deployed manifests (source of truth for current config).

