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
  private val catalogMarketCount = AtomicInteger(0)
  private val subscriptionCount = AtomicInteger(0)
  private val catalogLastRefreshEpochMs = AtomicLong(0)
  private val restWeightUsed = AtomicInteger(0)
  private val eventCounters = ConcurrentHashMap<String, Counter>()
  private val kafkaErrors = ConcurrentHashMap<String, Counter>()
  private val clickHouseErrors = ConcurrentHashMap<String, Counter>()
  private val dedupDrops = ConcurrentHashMap<String, Counter>()

  val reconnects: Counter = registry.counter("torghut_hyperliquid_ws_reconnects_total")
  val wsConnectSuccess: Counter = registry.counter("torghut_hyperliquid_ws_connect_success_total")
  val kafkaProduceSuccess: Counter = registry.counter("torghut_hyperliquid_kafka_produce_success_total")

  init {
    Gauge.builder("torghut_hyperliquid_readyz_status", ready) { it.get().toDouble() }.register(registry)
    Gauge.builder("torghut_hyperliquid_ws_connected", wsConnected) { it.get().toDouble() }.register(registry)
    Gauge.builder("torghut_hyperliquid_kafka_ready", kafkaReady) { it.get().toDouble() }.register(registry)
    Gauge.builder("torghut_hyperliquid_clickhouse_ready", clickHouseReady) { it.get().toDouble() }.register(registry)
    Gauge.builder("torghut_hyperliquid_catalog_markets", catalogMarketCount) { it.get().toDouble() }.register(registry)
    Gauge.builder("torghut_hyperliquid_subscriptions", subscriptionCount) { it.get().toDouble() }.register(registry)
    Gauge.builder("torghut_hyperliquid_rest_weight_used", restWeightUsed) { it.get().toDouble() }.register(registry)
    Gauge
      .builder("torghut_hyperliquid_catalog_last_refresh_ts_seconds", catalogLastRefreshEpochMs) {
        it.get().toDouble() / 1_000.0
      }.register(registry)
  }

  fun setReady(value: Boolean) = ready.set(if (value) 1 else 0)

  fun setWsConnected(value: Boolean) = wsConnected.set(if (value) 1 else 0)

  fun setKafkaReady(value: Boolean) = kafkaReady.set(if (value) 1 else 0)

  fun setClickHouseReady(value: Boolean) = clickHouseReady.set(if (value) 1 else 0)

  fun setCatalogMarketCount(value: Int) = catalogMarketCount.set(value)

  fun setSubscriptionCount(value: Int) = subscriptionCount.set(value)

  fun setCatalogLastRefreshEpochMs(value: Long) = catalogLastRefreshEpochMs.set(value)

  fun setRestWeightUsed(value: Int) = restWeightUsed.set(value)

  fun recordEvent(channel: String) {
    eventCounters
      .computeIfAbsent(channel) { Counter.builder("torghut_hyperliquid_events_total").tag("channel", it).register(registry) }
      .increment()
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

  fun recordDedupDrop(channel: String) {
    dedupDrops
      .computeIfAbsent(channel) {
        Counter.builder("torghut_hyperliquid_dedup_drops_total").tag("channel", it).register(registry)
      }.increment()
  }
}
