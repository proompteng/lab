# Torghut Crypto Market-Data Pipeline Production Design (BTC/USD, ETH/USD, SOL/USD)

## Status

- Date: `2026-02-22`
- Authoring basis: code + live cluster/runtime verification
- Scope: migrate Torghut market-data ingest from equity-only websocket assumptions to crypto pairs `BTC/USD`, `ETH/USD`, `SOL/USD`
- Environments: Kubernetes (`torghut`, `kafka`) with Argo CD GitOps

## 1. Goal

Design and execute a production-grade migration so Torghut websocket ingest, Kafka transport, TA/Flink processing, and trading inputs support crypto pairs:

- `BTC/USD`
- `ETH/USD`
- `SOL/USD`

This document defines target architecture, required code/config changes, phased rollout, observability, rollback, and verification gates.

## 2. Non-Goals

- No mixed equity+crypto dual-mode in the first rollout.
- No topic namespace split (`torghut.crypto.*`) in phase 1.
- No execution venue expansion beyond current Alpaca-based adapters in this phase.

## 3. Verified Current-State Baseline (Code + Runtime)

### 3.1 Code Baseline

1. WS feed/path are equity-shaped today.
   - `ALPACA_FEED` defaults to `iex` in config loader: `services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/ForwarderConfig.kt:105`.
   - WS URL is built as `.../v2/{feed}`: `services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/ForwarderApp.kt:283`.
   - Backfill endpoint is hardcoded to stocks: `.../v2/stocks/bars`: `services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/ForwarderApp.kt:713`.

2. Argo WS config is equity-oriented.
   - `ALPACA_FEED=iex`, fallback `SYMBOLS=CRWD,MU,NVDA`, Jangar symbols URL has no `assetClass=crypto` query:
   - `argocd/applications/torghut/ws/configmap.yaml:7`
   - `argocd/applications/torghut/ws/configmap.yaml:11`
   - `argocd/applications/torghut/ws/configmap.yaml:13`

3. Trading service config is also equity-oriented.
   - Execution allowlist is equities: `SPY,QQQ,IWM,NVDA,MSFT,AAPL`.
   - Jangar symbols URL has no crypto query.
   - `argocd/applications/torghut/knative-service.yaml:109`
   - `argocd/applications/torghut/knative-service.yaml:133`

4. Jangar symbols API already supports crypto filtering.
   - `assetClass` query supports `crypto` vs default `equity`:
   - `services/jangar/src/routes/api/torghut/symbols.ts:37`

5. Jangar symbols write path supports crypto.
   - `asset_class` is persisted in upsert path:
   - `services/jangar/src/server/torghut-symbols.ts:80`

6. Jangar symbols UI currently posts `assetClass: 'equity'` by default.
   - `services/jangar/src/routes/torghut/symbols.tsx:68`

7. Symbol normalization in Torghut backend already permits `/`.
   - Regex includes `_ . / -`, so `BTC/USD` is valid:
   - `services/torghut/app/trading/clickhouse.py:9`

### 3.2 Live Runtime Baseline (Kubernetes + Data Stores)

Snapshot time used for checks: `2026-02-22T00:18:01Z`.

1. Core workloads are up:
   - `kubectl get pods -n torghut -o wide` shows `torghut-ws`, `torghut-ta`, ClickHouse, Torghut app, and dependencies in `Running`.
   - `kubectl get pods -n kafka -o wide` shows brokers/operator/exporter in `Running`.

2. Service and job health:
   - Knative Torghut service: `READY=True`.
   - Command: `kubectl get ksvc torghut -n torghut`
   - Flink TA status: `READY / RUNNING / DEPLOYED`.
   - Command: `kubectl get flinkdeployment torghut-ta -n torghut -o jsonpath=...`

3. WS runtime config in-cluster confirms equity setup.
   - Command: `kubectl get configmap torghut-ws-config -n torghut -o yaml`
   - Observed:
     - `ALPACA_FEED: iex`
     - `JANGAR_SYMBOLS_URL: http://jangar.../api/torghut/symbols`
     - `SYMBOLS: CRWD,MU,NVDA`

4. WS logs show current subscribed universe is equities and intermittent Jangar fetch failures.
   - Command: `kubectl logs -n torghut deployment/torghut-ws --since=24h | rg ...`
   - Observed initial symbols:
     - `[ARM, CRWD, GOOG, LRCX, MSFT, MU, NVDA, SNDK, TSM]`
   - Observed repeated warning:
     - `desired symbols fetch failed; keeping last-known list`

5. Postgres (Torghut DB) shows no recent decision flow.
   - Command: `kubectl exec -n torghut torghut-db-1 -- psql -U postgres -d torghut ...`
   - Observed:
     - enabled strategy: `intraday-tsmom-profit-v2`
     - `trade_decisions` in last 24h: `0 rows`

6. Kafka topics are present/ready via Strimzi CRD.
   - Command: `kubectl get kafkatopics.kafka.strimzi.io -n kafka | grep '^torghut\.'`
   - Observed ready topics include:
     - `torghut.trades.v1`, `torghut.quotes.v1`, `torghut.bars.1m.v1`, `torghut.ta.signals.v1`, etc.
   - Topic configs verified (`partitions=3`, `replicas=3`, retention/compression set) from:
     - `kubectl get kafkatopic.kafka.strimzi.io -n kafka ... -o yaml`

7. ClickHouse has historical data but is stale (no recent writes).
   - Commands executed via `clickhouse-client` in `chi-torghut-clickhouse-default-0-0-0` with `torghut` user.
   - Observed:
     - `ta_signals max_event_ts = 2026-02-20 21:58:13`
     - `ta_microbars max_event_ts = 2026-02-20 21:58:13`
     - lag ≈ `94967s` at check time.
   - Historical rows still exist:
     - `ta_signals=122704`, `ta_microbars=115171`
   - Last 7d top symbols are equities (e.g., `NVDA`, `MU`, `MSFT`), and crypto pair counts are zero.

## 4. Design Requirements

### Functional

1. Subscribe crypto market websocket streams for `BTC/USD`, `ETH/USD`, `SOL/USD`.
2. Preserve envelope contract and Kafka topic contracts for downstream compatibility.
3. Support backfill for crypto bars with correct Alpaca crypto endpoint.
4. Ensure universe source (`Jangar`) can return crypto symbols deterministically.

### Reliability and Safety

1. Fail-soft on Jangar outages by retaining last-known symbols.
2. Keep readiness tied to WS auth/subscription and Kafka metadata.
3. Do not enable live trading promotion until data freshness SLOs pass.

### Operational

1. Full GitOps rollout through Argo CD.
2. Feature-flag guarded enablement.
3. Measurable acceptance gates across Kubernetes, Postgres, Kafka, ClickHouse.

## 5. Target Architecture

## 5.1 Logical Flow

1. `Jangar symbols API (assetClass=crypto)` provides desired symbol set.
2. `torghut-ws` subscribes Alpaca crypto websocket and emits envelopes to existing ingest topics.
3. `torghut-ta` (Flink) consumes ingest topics and produces TA outputs.
4. TA outputs persist to ClickHouse (`ta_microbars`, `ta_signals`).
5. Torghut runtime reads TA/price sources and operates under existing safety gates.

## 5.2 Symbol Canonical Contract

- Canonical symbol format: slash-delimited uppercase base/quote, e.g. `BTC/USD`.
- No symbol rewriting in storage topics for phase 1.
- Validation acceptance: symbol must pass `normalize_symbol` rules in Torghut backend (`services/torghut/app/trading/clickhouse.py:9`).

## 6. Required Changes

### 6.1 WS Forwarder (Kotlin)

1. Add market-type config to choose endpoint family (`equity` or `crypto`).
2. Build WS URL by market type, not just `/v2/{feed}`.
3. Route backfill endpoint by market type:
   - equity: stocks bars endpoint (existing)
   - crypto: crypto bars endpoint
4. Ensure query params match endpoint expectations (do not force equity-only feed semantics on crypto path).

Files:

- `services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/ForwarderConfig.kt`
- `services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/ForwarderApp.kt`

### 6.2 Argo WS Runtime Config

1. Add explicit crypto mode env.
2. Set fallback symbols to `BTC/USD,ETH/USD,SOL/USD`.
3. Set `JANGAR_SYMBOLS_URL` with `?assetClass=crypto`.
4. Keep topics unchanged for phase 1.

File:

- `argocd/applications/torghut/ws/configmap.yaml`

### 6.3 Jangar Symbol Management

1. Keep API behavior (`assetClass=crypto`) as source of truth.
2. Update symbols UI to allow selecting crypto when adding symbols.

Files:

- `services/jangar/src/routes/torghut/symbols.tsx`
- `services/jangar/src/routes/api/torghut/symbols.ts`

### 6.4 Torghut Runtime Config

1. Update execution adapter allowlist from equity set to crypto pairs for controlled canary.
2. Update `JANGAR_SYMBOLS_URL` to crypto-filtered query.

File:

- `argocd/applications/torghut/knative-service.yaml`

### 6.5 Strategy/Policy Config

1. Remove equity-biased symbol globs/examples from strategy routing defaults.
2. Provide neutral defaults compatible with crypto symbols.

File:

- `argocd/applications/torghut/strategy-configmap.yaml`

## 7. Feature-Flag and Rollout Controls

Use feature flags for staged progression:

1. Data path on, trading path off.
2. Pair-by-pair enablement.
3. Live/promotion gates only after freshness and continuity thresholds pass.

Flag repository:

- `argocd/applications/feature-flags/gitops/default/features.yaml`

Recommended new flags:

1. `torghut_ws_crypto_enabled`
2. `torghut_universe_crypto_enabled`
3. `torghut_trading_crypto_enabled`
4. `torghut_trading_crypto_live_enabled`

## 8. Rollout Plan (Phased)

### Phase 0: Prereq Stabilization

1. Resolve Jangar symbols endpoint instability observed in WS logs.
2. Confirm ClickHouse freshness path recovers for current equity pipeline before migration.

Exit criteria:

- No repeated `desired symbols fetch failed` warnings for 30 minutes.
- `ta_signals` and `ta_microbars` lag < 120 seconds sustained for 30 minutes.

### Phase 1: Crypto Data Ingest Only

1. Deploy WS code/config for crypto endpoints and crypto symbol universe.
2. Keep trading execution disabled for crypto exposure.

Exit criteria:

- WS readiness green.
- Kafka topic resources healthy.
- ClickHouse receives new rows for crypto symbols.

### Phase 2: TA/Signal Validation

1. Verify `ta_microbars` and `ta_signals` for `BTC/USD`, `ETH/USD`, `SOL/USD`.
2. Validate no schema/parse regressions.

Exit criteria:

- non-zero 24h rows for each target pair.
- lag SLO pass (`p95` freshness under threshold).

### Phase 3: Controlled Trading Enablement

1. Enable crypto pair allowlist in execution routing.
2. Canary by one pair (`BTC/USD`), then expand.

Exit criteria:

- no safety gate violations,
- no abnormal fallback or reject spikes,
- positive continuity metrics.

## 9. Verification Matrix (Production)

### Code Verification

- WS equity assumptions verified in:
  - `services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/ForwarderConfig.kt:105`
  - `services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/ForwarderApp.kt:283`
  - `services/dorvud/websockets/src/main/kotlin/ai/proompteng/dorvud/ws/ForwarderApp.kt:713`
- Jangar crypto filtering verified in:
  - `services/jangar/src/routes/api/torghut/symbols.ts:37`
- UI equity default verified in:
  - `services/jangar/src/routes/torghut/symbols.tsx:68`
- Symbol parser allows slash symbols in:
  - `services/torghut/app/trading/clickhouse.py:9`

### Kubernetes Verification

Commands used:

- `kubectl get pods -n torghut -o wide`
- `kubectl get pods -n kafka -o wide`
- `kubectl get ksvc torghut -n torghut`
- `kubectl get flinkdeployment torghut-ta -n torghut -o jsonpath=...`
- `kubectl get configmap torghut-ws-config -n torghut -o yaml`
- `kubectl logs -n torghut deployment/torghut-ws --since=24h | rg ...`

Observed:

- platform components are running and service reports healthy,
- runtime config and subscriptions are still equity-based,
- intermittent Jangar symbol fetch failures are present.

### Postgres Verification

Command:

- `kubectl exec -n torghut torghut-db-1 -- psql -U postgres -d torghut ...`

Observed:

- strategy catalog includes enabled `intraday-tsmom-profit-v2`,
- `trade_decisions` in last 24h is empty at snapshot time.

### Kafka Verification

Commands:

- `kubectl get kafkatopics.kafka.strimzi.io -n kafka | grep '^torghut\.'`
- `kubectl get kafkatopic.kafka.strimzi.io -n kafka torghut.trades.v1 torghut.quotes.v1 torghut.bars.1m.v1 -o yaml`

Observed:

- required topics exist and are `Ready=True`,
- partition/replication/retention/compression settings match expected production setup.

### ClickHouse Verification

Commands (via `clickhouse-client` in torghut namespace):

- table cardinality checks,
- max timestamp and lag checks,
- symbol distribution checks.

Observed:

- historical data exists,
- freshest event timestamp is stale (last at `2026-02-20 21:58:13` at snapshot),
- recent symbol distribution remains equity-only.

## 10. SLOs and Alerting for Crypto Cutover

1. WS readiness availability: >= 99.9%.
2. Ingest freshness (`event_ts` -> `ingest_ts`) p95 under 2s during active market windows.
3. TA freshness (`now - max(event_ts)` in ClickHouse) < 120s.
4. Pair coverage: each of `BTC/USD`, `ETH/USD`, `SOL/USD` has non-zero rows in `ta_signals` and `ta_microbars` over rolling 30m windows.
5. Safety alerts:
   - repeated Jangar symbol fetch failure,
   - stale ClickHouse freshness,
   - abnormal execution fallback ratios.

## 11. Risk Register and Mitigations

1. Endpoint mismatch risk (equity vs crypto routes).
   - Mitigation: explicit market-type config and endpoint builders with tests.
2. Universe drift risk due Jangar fetch failures.
   - Mitigation: cache + alerting + pre-cutover stabilization gate.
3. Pipeline appears healthy while data is stale.
   - Mitigation: hard freshness gate in rollout promotion checks.
4. Symbol-format incompatibility downstream.
   - Mitigation: canonical slash format tests and allowlist updates in execution path.

## 12. Rollback Plan

1. Revert GitOps manifests to previous equity config:
   - `argocd/applications/torghut/ws/configmap.yaml`
   - `argocd/applications/torghut/knative-service.yaml`
2. Argo sync and confirm WS/TA readiness.
3. Validate ClickHouse freshness resumes for prior universe.
4. Keep trading promotions disabled until post-rollback health passes.

## 13. Acceptance Criteria for Production Readiness

1. Code merged with unit/integration coverage for crypto path selection.
2. Argo app `Synced/Healthy` after rollout.
3. ClickHouse freshness recovered and sustained under SLO.
4. Crypto symbol rows present and advancing in TA tables.
5. No unresolved critical alerts for symbol-source failures.

## Appendix A: Evidence Snapshot (2026-02-22 UTC)

### A.1 Runtime Health

- `kubectl get application -n argocd torghut -o jsonpath=...`
  - `Synced Healthy`
- `kubectl get ksvc torghut -n torghut`
  - `READY=True`
- `kubectl get flinkdeployment torghut-ta -n torghut -o jsonpath=...`
  - `READY / RUNNING / DEPLOYED`

### A.2 WS Runtime Config/Behavior

- In-cluster config includes equity defaults (`iex`, equity symbols fallback).
- WS startup log shows equity symbols list:
  - `[ARM, CRWD, GOOG, LRCX, MSFT, MU, NVDA, SNDK, TSM]`
- WS logs include repeated:
  - `desired symbols fetch failed; keeping last-known list`

### A.3 Postgres Snapshot

- Enabled strategies query returned:
  - `intraday-tsmom-profit-v2` enabled.
- `trade_decisions` in 24h query returned:
  - `0 rows`.

### A.4 Kafka Topic Snapshot

- `torghut.*` topic set present and `Ready=True`.
- Core ingest topics verified:
  - `torghut.trades.v1` (3 partitions, rf=3)
  - `torghut.quotes.v1` (3 partitions, rf=3)
  - `torghut.bars.1m.v1` (3 partitions, rf=3)

### A.5 ClickHouse Snapshot

- Total rows:
  - `ta_signals=122704`, `ta_microbars=115171`
- Freshness:
  - `max_event_ts=2026-02-20 21:58:13` for both tables at snapshot time.
- Last 7d symbol concentration remains equities (e.g., `NVDA`, `MU`, `MSFT`).
- Crypto pairs (`BTC/USD`, `ETH/USD`, `SOL/USD`) had zero rows at snapshot.
