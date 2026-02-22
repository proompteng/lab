# Torghut Multi-Account Trading Architecture and Rollout Design

## Status
- Date: `2026-02-22`
- Authoring basis: source code + live runtime verification (`kubectl`, Postgres, Kafka, ClickHouse, Flink)
- Scope: production migration from single-account execution to multi-account execution in Torghut
- Environments: Kubernetes namespaces `torghut` and `kafka` with Argo CD GitOps deployment

## 1. Goal
Enable Torghut to run multiple trading accounts concurrently and safely, with deterministic account isolation for:
- order submission,
- reconciliation,
- idempotency,
- persistence,
- operational controls and observability.

The target is to support at least two paper accounts in one deployment while preserving existing crypto/equity data-plane behavior and without introducing regressions to current trading safety controls.

## 2. Non-Goals
- No broker expansion beyond current Alpaca adapters.
- No immediate split of TA/market-data storage by account (TA features remain market-wide).
- No schema-breaking API change for existing consumers in phase 1.
- No direct cluster hotfixes outside GitOps except emergency incidents.

## 3. Verified Current-State Baseline (Code + Runtime)

### 3.1 Runtime baseline (2026-02-22)
1. Torghut app is healthy and Argo-synced.
   - `ksvc/torghut` ready with revision `torghut-00013`.
   - Argo app `torghut` reports `Synced/Healthy`.

2. TA pipeline is running.
   - Flink deployment `torghut-ta` lifecycle `STABLE`, job status `RUNNING`.
   - Kafka topics (`torghut.trades.v1`, `torghut.quotes.v1`, `torghut.bars.1m.v1`, `torghut.ta.bars.1s.v1`, `torghut.ta.signals.v1`, `torghut.trade-updates.v1`) exist and have advancing offsets.

3. ClickHouse receives both equity and crypto TA rows.
   - `torghut.ta_signals` latest includes symbols like `BTC/USD`, `ETH/USD`, `SOL/USD` and equity symbols.
   - `torghut.ta_microbars` is fresh.

4. Postgres proves execution path is still effectively single-account.
   - `trade_decisions` rows are only under one label (`live`).
   - `executions` joined to decisions are only under `live`.
   - `position_snapshots` has more than one account label, indicating account snapshots are partially multi-account but execution is not.

### 3.2 Code baseline (single-account architecture)
1. Single account credentials + label in settings.
   - `services/torghut/app/config.py`
   - `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`, `APCA_API_BASE_URL`, and one `TRADING_ACCOUNT_LABEL`.

2. Scheduler builds one pipeline/client only.
   - `services/torghut/app/trading/scheduler.py`
   - `_build_pipeline()` creates one `TorghutAlpacaClient` and one `TradingPipeline` with one `account_label`.

3. Idempotency is not account-scoped.
   - `decision_hash()` in `services/torghut/app/trading/models.py` does not include account label.
   - `OrderExecutor.ensure_decision()` in `services/torghut/app/trading/execution.py` looks up only by `decision_hash`.

4. DB uniqueness is global, not per account.
   - `trade_decisions.decision_hash` unique index.
   - `executions.client_order_id` unique index.
   - `executions.alpaca_order_id` unique index.

5. Order-feed reconciliation is not account-aware.
   - `services/torghut/app/trading/order_feed.py` resolves by order ids / decision hash without account dimension.

6. Trade cursor is global singleton.
   - `TradeCursor.source` is unique and currently keyed as `clickhouse`, not per account.

7. WS trade-updates payload has no account label.
   - `services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/ForwarderApp.kt` emits envelopes without account context.

### 3.3 Production blockers observed during verification
1. DB schema drift currently exists and must be corrected before multi-account migration:
   - runtime queries reference `execution_tca_metrics.divergence_bps` and `research_candidates.lifecycle_*` columns that are absent in live DB.
2. Alembic history has split heads at `0011_*` from the same `0010` parent; merge migration is required.
3. Flink task logs show intermittent ClickHouse memory-limit exceptions; this is a capacity/reliability concern for scale-up.

## 4. Design Principles
1. Keep market-data and TA feature generation shared and account-agnostic.
2. Make all execution state, order identity, and reconciliation account-scoped.
3. Prefer additive migrations and dual-read/write transitions.
4. Preserve backward compatibility for one-account config during rollout.
5. Roll out via GitOps with clear, reversible gates.

## 5. Target Architecture

### 5.1 High-level model
1. Shared data plane (unchanged in phase 1):
   - WebSocket -> Kafka -> Flink -> ClickHouse.
2. Multi-account execution plane (new):
   - one `TradingPipeline` instance per account,
   - one Alpaca client per account,
   - isolated decision/execution/reconciliation state per account.

### 5.2 Account registry contract
Introduce a structured account registry config (`TRADING_ACCOUNTS_JSON` or mounted YAML) with entries:
- `label`: stable account key (for storage and metrics),
- `mode`: `paper` or `live`,
- `api_key`, `secret_key`, `base_url`,
- `enabled`: on/off switch.

Backward compatibility:
- if registry is absent, synthesize one account from existing single-account env vars.

### 5.3 Scheduler supervision model
1. `TradingScheduler` becomes a supervisor of account pipelines.
2. For each enabled account:
   - create dedicated client,
   - create pipeline with `account_label`,
   - run `run_once` and `reconcile` on the account lane.
3. One account failure must not stop others.
4. API status endpoints expose per-account health and lag.

## 6. Data Model and Persistence Changes

### 6.1 Postgres schema changes
1. Add `executions.alpaca_account_label` (`NOT NULL`) and backfill from linked `trade_decisions`.
2. Replace global uniques with account-scoped uniques:
   - `trade_decisions`: unique (`alpaca_account_label`, `decision_hash`),
   - `executions`: unique (`alpaca_account_label`, `client_order_id`),
   - `executions`: unique (`alpaca_account_label`, `alpaca_order_id`).
3. Keep existing surrogate PKs unchanged.

### 6.2 Idempotency update
1. Include account label in decision hash input.
2. Keep hash length fixed (`sha256`) and keep usage as broker `client_order_id`.
3. Update all decision/execution lookups to include account scope.

### 6.3 Cursor model update
1. Move from global cursor source (`clickhouse`) to account-aware source key (for example `clickhouse:<account_label>`).
2. Avoid one account starving or skipping another via shared cursor.

## 7. Stream and Event Contract Changes

### 7.1 Trade updates topic evolution
1. Introduce `torghut.trade-updates.v2` envelope with explicit `account_label`.
2. Update WS producer to emit `account_label`.
3. Update Torghut order-feed consumer to:
   - prefer v2 account-aware matching,
   - optionally dual-read v1 during migration window.

### 7.2 TA/Kafka/ClickHouse account handling
1. No account label added to TA microbars/signals in phase 1.
2. Rationale: TA features derive from market data, not account holdings.
3. Preserve existing TA schemas and topic names to avoid unnecessary downstream churn.

## 8. Feature Flags and Control Plane
Use existing feature-flags service but account-specific entity ids:
- global: `entityId=torghut`,
- account lane: `entityId=torghut:<account_label>`.

Required lane controls:
- `torghut_trading_enabled`,
- `torghut_trading_live_enabled`,
- `torghut_trading_crypto_enabled`,
- `torghut_trading_crypto_live_enabled`,
- account-specific kill switch.

## 9. Rollout Plan (GitOps)

### Phase 0: Baseline Repair (blocking)
1. Merge and apply Alembic fix for split heads + missing columns.
2. Verify `trading/metrics` endpoint returns 200 and autonomy loop no longer fails on undefined columns.

Exit gates:
- no `UndefinedColumn` exceptions in Torghut logs for 24h.

### Phase 1: Code + schema for multi-account (dark)
1. Land schema migrations and code changes.
2. Deploy with one effective account active (behavior parity).

Exit gates:
- no unique constraint regressions,
- unchanged equity/crypto processing behavior for active account.

### Phase 2: Order-feed v2 dual migration
1. Deploy WS emitting v2 payload and topic.
2. Torghut dual-read: v1 + v2, prefer v2 for account attribution.

Exit gates:
- trade-updates processed with account attribution,
- no reconciliation regressions.

### Phase 3: Enable second account
1. Add second account in account registry and secret references.
2. Enable via feature flags in canary mode (start crypto-only or restricted symbol allowlist).

Exit gates:
- decisions/executions generated for both labels,
- no cross-account order mapping,
- no safety regressions.

### Phase 4: Cutover and cleanup
1. Disable v1 trade-updates consumption when stable.
2. Remove temporary compatibility logic.

## 10. Verification Matrix (Production Acceptance)

### 10.1 Kubernetes
- `kubectl get ksvc torghut -n torghut`
- `kubectl get deploy -n torghut`
- `kubectl get flinkdeployment torghut-ta -n torghut`
- `kubectl logs -n torghut deploy/torghut-<rev>-deployment --since=30m`

Pass criteria:
- service ready,
- no crash loops,
- no recurring runtime exceptions.

### 10.2 Postgres
- account coverage in `trade_decisions`, `executions`, `position_snapshots`.
- uniqueness/index checks confirm account-scoped constraints active.
- dual-account rows present without collisions.

### 10.3 Kafka
- topic readiness and offsets for:
  - `torghut.trade-updates.v2`,
  - existing ingest/TA topics.
- consumer lag stable for TA and order-feed groups.

### 10.4 ClickHouse
- TA freshness remains within SLO.
- symbol coverage remains healthy for both crypto and equity symbols.

### 10.5 Flink
- job remains `RUNNING/STABLE`.
- no sustained decode or sink exception bursts.

### 10.6 Functional safety and regressions
- orders for account A never reconcile into account B.
- kill switch and emergency-stop behavior still effective per lane.
- equity processing throughput/latency unchanged relative to pre-migration baseline.

## 11. Rollback Plan
1. Disable secondary account via feature flags and account registry.
2. Revert Torghut deployment manifest to prior single-account image/tag.
3. Keep additive schema changes in place; do not drop account columns/indexes during incident rollback.
4. If needed, switch order-feed back to v1-only consumption temporarily.

## 12. Implementation Worklist
1. Fix migration baseline (split-head merge + missing columns).
2. Add account registry config support and secret wiring.
3. Refactor scheduler to account supervisor model.
4. Add account-aware DB migrations and ORM/query updates.
5. Add trade-updates v2 with `account_label` and dual-read migration logic.
6. Add per-account observability and readiness/status reporting.
7. Update runbooks and production docs.

## 13. Source-of-Truth Pointers
- Torghut config: `services/torghut/app/config.py`
- Scheduler/pipeline: `services/torghut/app/trading/scheduler.py`
- Idempotency model: `services/torghut/app/trading/models.py`
- Execution + reconcile: `services/torghut/app/trading/execution.py`, `services/torghut/app/trading/reconcile.py`
- Order-feed ingest: `services/torghut/app/trading/order_feed.py`
- ORM entities: `services/torghut/app/models/entities.py`
- WS producer: `services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/ForwarderApp.kt`
- Flink TA job: `services/dorvud/technical-analysis-flink/src/main/kotlin/ai/proompteng/dorvud/ta/flink/FlinkTechnicalAnalysisJob.kt`
- TA schema: `services/dorvud/technical-analysis-flink/src/main/resources/ta-schema.sql`
- GitOps manifests: `argocd/applications/torghut/`, `argocd/applications/kafka/`

## 14. Decision Summary
- Data plane remains shared.
- Execution plane becomes account-isolated.
- Idempotency and reconciliation become account-scoped.
- Migration is phased, reversible, and GitOps-driven.
