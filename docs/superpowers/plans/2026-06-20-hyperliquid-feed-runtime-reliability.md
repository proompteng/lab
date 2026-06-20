# Hyperliquid Feed And Runtime Reliability Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:systematic-debugging first, then superpowers:executing-plans to implement this plan task-by-task. Keep every checkbox tied to live evidence, a repo change, or an explicit blocker.

**Goal:** Make the Torghut Hyperliquid lane reliable enough for continuous data collection and testnet execution: the feed must stay healthy through transient Kafka leader movement, ClickHouse readiness must reflect real ingestion freshness, runtime readiness must be probeable, and release verification must prove fresh market data before execution claims.

**Live diagnosis on 2026-06-20:** `torghut-hyperliquid-feed-8676bfc568-dkq9k` is currently `1/1 Running` and `/readyz` returns 200, but the pod produced 240 `/readyz` 503 responses in the last four-hour log window. The 503 storm began at `2026-06-20T02:07:34Z` alongside thousands of Kafka producer errors, mostly `NOT_LEADER_OR_FOLLOWER`, while ClickHouse table freshness briefly reported stale BBO lags. Kafka and all `torghut.hyperliquid.*` topics are currently Ready with replication factor 3, and ClickHouse ingest is fresh again (`hyperliquid_bbo` lag about 2s, `hyperliquid_candles` lag about 9s in the live check).

**Root causes:**

- Kafka readiness is a single boolean and flips false on any producer callback error, including retriable broker metadata or leader movement while the producer is still retrying.
- `/readyz` returns detailed JSON, but Kubernetes events only show generic HTTP 503; the JSON does not expose a stable `readinessBlockers` list or Kafka success/failure lag fields.
- ClickHouse table readiness uses event timestamp lag. Hyperliquid candles can carry future close timestamps, so event time is a poor readiness source; ingestion freshness is the correct table-health signal.
- Runtime and feed health are separate surfaces. A healthy feed does not prove runtime execution readiness, and a healthy runtime does not prove feed freshness.

---

## Task 1: Stabilize Feed Readiness Semantics

**Files:**

- Modify `services/dorvud/hyperliquid-feed/src/main/kotlin/ai/proompteng/dorvud/hyperliquid/HyperliquidFeedApp.kt`
- Add `services/dorvud/hyperliquid-feed/src/main/kotlin/ai/proompteng/dorvud/hyperliquid/KafkaReadinessTracker.kt`
- Modify `services/dorvud/hyperliquid-feed/src/main/kotlin/ai/proompteng/dorvud/hyperliquid/HyperliquidConfig.kt`
- Modify `services/dorvud/hyperliquid-feed/src/main/kotlin/ai/proompteng/dorvud/hyperliquid/HealthServer.kt`
- Modify `services/dorvud/hyperliquid-feed/src/main/kotlin/ai/proompteng/dorvud/hyperliquid/HyperliquidMetrics.kt`

- [x] Replace `kafkaReady: AtomicBoolean` with a recent-success readiness tracker.
- [x] Add `KAFKA_READY_MAX_AGE_MS` with a production default of 120 seconds.
- [x] Record Kafka last-success lag, last-failure age, and last-failure reason in `/readyz`.
- [x] Add stable `/readyz.readinessBlockers` values: `websocket_not_connected`, `kafka_no_recent_success`, `clickhouse_not_fresh`, `market_data_stale`, and `catalog_not_loaded`.
- [x] Add metrics gauges for Kafka last success/failure timestamps and active readiness blockers.

## Task 2: Make ClickHouse Readiness Match Ingestion Reality

**Files:**

- Modify `services/dorvud/hyperliquid-feed/src/main/kotlin/ai/proompteng/dorvud/hyperliquid/ClickHouseSink.kt`
- Modify `services/dorvud/hyperliquid-feed/src/main/kotlin/ai/proompteng/dorvud/hyperliquid/HyperliquidMetrics.kt`

- [x] Use `ingest_ts` lag to decide `tableFreshnessReady`.
- [x] Keep event-time lag as diagnostic output only.
- [x] Add event future-skew reporting so candle close timestamps no longer look like missing metrics.
- [x] Warn with both ingest and event lag maps when ClickHouse table freshness blocks readiness.

## Task 3: Lock GitOps Configuration To The New Contract

**Files:**

- Modify `argocd/applications/torghut-hyperliquid-feed/configmap.yaml`
- Modify `packages/scripts/src/torghut/__tests__/manifest-scheduling.test.ts`

- [x] Add `KAFKA_READY_MAX_AGE_MS=120000` to the feed ConfigMap.
- [x] Keep mainnet data feed and bounded top-volume subscription settings unchanged.
- [x] Test that Hyperliquid feed GitOps includes Kafka readiness age, ClickHouse ingest readiness tables, and digest-pinned image deployment.

## Task 4: Add Regression Coverage

**Files:**

- Modify `services/dorvud/hyperliquid-feed/src/test/kotlin/ai/proompteng/dorvud/hyperliquid/HyperliquidFeedAppHealthTest.kt`
- Modify `services/dorvud/hyperliquid-feed/src/test/kotlin/ai/proompteng/dorvud/hyperliquid/HyperliquidConfigTest.kt`
- Modify `services/dorvud/hyperliquid-feed/src/test/kotlin/ai/proompteng/dorvud/hyperliquid/ClickHouseSinkTest.kt`

- [x] Prove transient Kafka failures do not make readiness false while recent acks exist.
- [x] Prove readiness becomes false when Kafka has no successful ack within the configured age.
- [x] Prove blockers list the exact dependency that fails readiness.
- [x] Prove ClickHouse readiness is blocked by stale ingest lag, not stale or future candle event timestamps.

## Task 5: Verify Live And Release

**Commands:**

```bash
cd services/dorvud && ./gradlew :hyperliquid-feed:test :hyperliquid-feed:build
bun test packages/scripts/src/torghut/__tests__/manifest-scheduling.test.ts
bun run lint:argocd
```

**Live checks after rollout:**

```bash
kubectl -n torghut get pod -l app=torghut-hyperliquid-feed -o wide
kubectl -n torghut logs deploy/torghut-hyperliquid-feed --since=30m | rg '503 Service Unavailable|Kafka produce failed|clickhouse table .* freshness stale'
kubectl -n torghut exec <probe-pod> -- wget -qO- http://torghut-hyperliquid-feed/readyz
kubectl -n kafka get kafka,kafkatopic -o wide | rg 'kafka|torghut.hyperliquid'
```

**Acceptance:**

- Feed pod is `1/1 Ready` with no new readiness 503 storm after rollout.
- `/readyz.ready=true`, `readinessBlockers=[]`, Kafka last-success lag is below `KAFKA_READY_MAX_AGE_MS`, and ClickHouse BBO/candle ingest lags are below `CLICKHOUSE_READY_MAX_AGE_MS`.
- If Kafka leader movement recurs, producer errors are counted but readiness only fails after the configured no-success window.
- Runtime readiness and `/report` are checked separately before any execution-readiness claim.
