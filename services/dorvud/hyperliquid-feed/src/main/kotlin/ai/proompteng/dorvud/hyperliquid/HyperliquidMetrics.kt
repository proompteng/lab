package ai.proompteng.dorvud.hyperliquid

import io.micrometer.core.instrument.Counter
import io.micrometer.core.instrument.Gauge
import io.micrometer.core.instrument.MeterRegistry
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

class HyperliquidMetrics(
  private val registry: MeterRegistry,
) {
  private val ready = AtomicInteger(0)
  private val wsConnected = AtomicInteger(0)
  private val kafkaReady = AtomicInteger(0)
  private val clickHouseReady = AtomicInteger(0)
  private val marketDataReady = AtomicInteger(0)
  private val catalogMarketCount = AtomicInteger(0)
  private val subscriptionCount = AtomicInteger(0)
  private val catalogLastRefreshEpochMs = AtomicLong(0)
  private val restWeightUsed = AtomicInteger(0)
  private val kafkaLastSuccessEpochMs = AtomicLong(0)
  private val kafkaLastFailureEpochMs = AtomicLong(0)
  private val eventCounters = ConcurrentHashMap<String, Counter>()
  private val kafkaErrors = ConcurrentHashMap<String, Counter>()
  private val clickHouseErrors = ConcurrentHashMap<String, Counter>()
  private val dedupDrops = ConcurrentHashMap<String, Counter>()
  private val readinessBlockers = ConcurrentHashMap<String, AtomicInteger>()
  private val eventLastSeenEpochMs = ConcurrentHashMap<String, AtomicLong>()
  private val clickHouseTableIngestLagMs = ConcurrentHashMap<String, AtomicLong>()
  private val clickHouseTableEventLagMs = ConcurrentHashMap<String, AtomicLong>()
  private val clickHouseTableEventFutureSkewMs = ConcurrentHashMap<String, AtomicLong>()

  private val knownReadinessBlockers =
    setOf(
      "websocket_not_connected",
      "kafka_no_recent_success",
      "clickhouse_not_fresh",
      "market_data_stale",
      "catalog_not_loaded",
    )

  val reconnects: Counter = registry.counter("torghut_hyperliquid_ws_reconnects_total")
  val wsConnectSuccess: Counter = registry.counter("torghut_hyperliquid_ws_connect_success_total")
  val kafkaProduceSuccess: Counter = registry.counter("torghut_hyperliquid_kafka_produce_success_total")

  init {
    Gauge.builder("torghut_hyperliquid_readyz_status", ready) { it.get().toDouble() }.register(registry)
    Gauge.builder("torghut_hyperliquid_ws_connected", wsConnected) { it.get().toDouble() }.register(registry)
    Gauge.builder("torghut_hyperliquid_kafka_ready", kafkaReady) { it.get().toDouble() }.register(registry)
    Gauge.builder("torghut_hyperliquid_clickhouse_ready", clickHouseReady) { it.get().toDouble() }.register(registry)
    Gauge.builder("torghut_hyperliquid_market_data_ready", marketDataReady) { it.get().toDouble() }.register(registry)
    Gauge.builder("torghut_hyperliquid_catalog_markets", catalogMarketCount) { it.get().toDouble() }.register(registry)
    Gauge.builder("torghut_hyperliquid_subscriptions", subscriptionCount) { it.get().toDouble() }.register(registry)
    Gauge.builder("torghut_hyperliquid_rest_weight_used", restWeightUsed) { it.get().toDouble() }.register(registry)
    Gauge
      .builder("torghut_hyperliquid_kafka_last_success_ts_seconds", kafkaLastSuccessEpochMs) {
        it.get().toDouble() / 1_000.0
      }.register(registry)
    Gauge
      .builder("torghut_hyperliquid_kafka_last_failure_ts_seconds", kafkaLastFailureEpochMs) {
        it.get().toDouble() / 1_000.0
      }.register(registry)
    Gauge
      .builder("torghut_hyperliquid_catalog_last_refresh_ts_seconds", catalogLastRefreshEpochMs) {
        it.get().toDouble() / 1_000.0
      }.register(registry)
  }

  fun setReady(value: Boolean) = ready.set(if (value) 1 else 0)

  fun setWsConnected(value: Boolean) = wsConnected.set(if (value) 1 else 0)

  fun setKafkaReady(value: Boolean) = kafkaReady.set(if (value) 1 else 0)

  fun setClickHouseReady(value: Boolean) = clickHouseReady.set(if (value) 1 else 0)

  fun setMarketDataReady(value: Boolean) = marketDataReady.set(if (value) 1 else 0)

  fun setCatalogMarketCount(value: Int) = catalogMarketCount.set(value)

  fun setSubscriptionCount(value: Int) = subscriptionCount.set(value)

  fun setCatalogLastRefreshEpochMs(value: Long) = catalogLastRefreshEpochMs.set(value)

  fun setRestWeightUsed(value: Int) = restWeightUsed.set(value)

  fun setKafkaLastSuccessEpochMs(value: Long?) = kafkaLastSuccessEpochMs.set(value ?: 0)

  fun setKafkaLastFailureEpochMs(value: Long?) = kafkaLastFailureEpochMs.set(value ?: 0)

  fun setReadinessBlockers(blockers: Collection<String>) {
    val active = blockers.toSet()
    (knownReadinessBlockers + active).forEach { reason ->
      readinessBlockers
        .computeIfAbsent(reason) {
          val value = AtomicInteger(0)
          Gauge
            .builder("torghut_hyperliquid_readiness_blocked", value) { it.get().toDouble() }
            .tag("reason", reason)
            .register(registry)
          value
        }.set(if (reason in active) 1 else 0)
    }
  }

  fun recordEvent(channel: String) {
    eventCounters
      .computeIfAbsent(channel) { Counter.builder("torghut_hyperliquid_events_total").tag("channel", it).register(registry) }
      .increment()
  }

  fun setEventLastSeenEpochMs(
    channel: String,
    epochMs: Long,
  ) {
    eventLastSeenEpochMs
      .computeIfAbsent(channel) {
        val value = AtomicLong(0)
        Gauge
          .builder("torghut_hyperliquid_event_last_seen_ts_seconds", value) { it.get().toDouble() / 1_000.0 }
          .tag("channel", channel)
          .register(registry)
        value
      }.set(epochMs)
  }

  fun recordKafkaError(topic: String) {
    kafkaErrors
      .computeIfAbsent(topic) {
        Counter.builder("torghut_hyperliquid_kafka_produce_errors_total").tag("topic", it).register(registry)
      }.increment()
  }

  fun recordClickHouseError(table: String) {
    clickHouseErrors
      .computeIfAbsent(table) {
        Counter.builder("torghut_hyperliquid_clickhouse_insert_errors_total").tag("table", it).register(registry)
      }.increment()
  }

  fun setClickHouseTableIngestLagMs(
    table: String,
    lagMs: Long?,
  ) {
    clickHouseTableIngestLagMs
      .computeIfAbsent(table) {
        val value = AtomicLong(-1)
        Gauge
          .builder("torghut_hyperliquid_clickhouse_table_ingest_lag_seconds", value) {
            val observed = it.get()
            if (observed < 0) -1.0 else observed.toDouble() / 1_000.0
          }.tag("table", table)
          .register(registry)
        value
      }.set(lagMs ?: -1)
  }

  fun setClickHouseTableEventLagMs(
    table: String,
    lagMs: Long?,
  ) {
    clickHouseTableEventLagMs
      .computeIfAbsent(table) {
        val value = AtomicLong(-1)
        Gauge
          .builder("torghut_hyperliquid_clickhouse_table_event_lag_seconds", value) {
            val observed = it.get()
            if (observed < 0) -1.0 else observed.toDouble() / 1_000.0
          }.tag("table", table)
          .register(registry)
        value
      }.set(lagMs ?: -1)
  }

  fun setClickHouseTableEventFutureSkewMs(
    table: String,
    skewMs: Long?,
  ) {
    clickHouseTableEventFutureSkewMs
      .computeIfAbsent(table) {
        val value = AtomicLong(-1)
        Gauge
          .builder("torghut_hyperliquid_clickhouse_table_event_future_skew_seconds", value) {
            val observed = it.get()
            if (observed < 0) -1.0 else observed.toDouble() / 1_000.0
          }.tag("table", table)
          .register(registry)
        value
      }.set(skewMs ?: -1)
  }

  fun recordDedupDrop(channel: String) {
    dedupDrops
      .computeIfAbsent(channel) {
        Counter.builder("torghut_hyperliquid_dedup_drops_total").tag("channel", it).register(registry)
      }.increment()
  }
}
