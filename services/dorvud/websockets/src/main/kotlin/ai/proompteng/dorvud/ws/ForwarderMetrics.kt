package ai.proompteng.dorvud.ws

import io.micrometer.core.instrument.Counter
import io.micrometer.core.instrument.DistributionSummary
import io.micrometer.core.instrument.Gauge
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

internal class ForwarderMetrics(
  private val registry: MeterRegistry,
) {
  private val dedupCounters = ConcurrentHashMap<String, Counter>()
  private val readinessErrorCounters = ConcurrentHashMap<String, Counter>()
  private val wsConnectErrorCounters = ConcurrentHashMap<String, Counter>()
  private val kafkaProduceErrorCounters = ConcurrentHashMap<String, Counter>()
  private val kafkaProduceSuccessCounters = ConcurrentHashMap<String, Counter>()
  private val kafkaMetadataErrorCounters = ConcurrentHashMap<String, Counter>()
  private val desiredSymbolsFetchFailureCounters = ConcurrentHashMap<String, Counter>()
  private val providerMessageCounters = ConcurrentHashMap<String, Counter>()
  private val marketDataDropCounters = ConcurrentHashMap<String, Counter>()
  private val marketDataReconnectCounters = ConcurrentHashMap<String, Counter>()
  private val marketDataWsConnectSuccessCounters = ConcurrentHashMap<String, Counter>()
  private val marketDataWsConnectErrorCounters = ConcurrentHashMap<String, Counter>()
  private val marketDataLagSummaries = ConcurrentHashMap<String, DistributionSummary>()
  private val marketDataChannelGaugeValues = ConcurrentHashMap<String, AtomicLong>()

  private val readinessStatus = AtomicInteger(0)
  private val desiredSymbolsFetchDegraded = AtomicInteger(0)
  private val optionsEventStarvation = AtomicInteger(0)
  private val desiredSymbolsFetchLastSuccessEpochMs = AtomicLong(0)
  private val desiredSymbolsFetchLastFailureEpochMs = AtomicLong(0)
  private val readinessErrorClassGauge =
    ReadinessErrorClass
      .entries
      .associateWith { AtomicInteger(0) }
  private val readinessGateStatus =
    mapOf(
      "alpaca_ws" to AtomicInteger(0),
      "kafka" to AtomicInteger(0),
      "trade_updates" to AtomicInteger(0),
      "market_data_channels" to AtomicInteger(0),
    )

  private val lagSummary: DistributionSummary =
    DistributionSummary
      .builder("torghut_ws_lag_ms")
      .publishPercentileHistogram()
      .register(registry)

  private val kafkaLatency: Timer =
    Timer
      .builder("torghut_ws_kafka_send_latency")
      .publishPercentileHistogram()
      .register(registry)

  val reconnects: Counter = registry.counter("torghut_ws_reconnects_total")
  val kafkaSendErrors: Counter = registry.counter("torghut_ws_kafka_send_errors_total")
  val wsConnectSuccess: Counter = registry.counter("torghut_ws_ws_connect_success_total")
  val desiredSymbolsFetchSuccess: Counter = registry.counter("torghut_ws_desired_symbols_fetch_success_total")

  init {
    Gauge
      .builder("torghut_ws_readyz_status", readinessStatus) { it.get().toDouble() }
      .register(registry)

    Gauge
      .builder("torghut_ws_desired_symbols_fetch_degraded", desiredSymbolsFetchDegraded) { it.get().toDouble() }
      .register(registry)

    Gauge
      .builder("torghut_ws_options_event_starvation", optionsEventStarvation) { it.get().toDouble() }
      .description("1 when options websocket is subscribed during regular market hours but has not received quote or trade events")
      .register(registry)

    Gauge
      .builder("torghut_ws_desired_symbols_fetch_last_success_ts_seconds", desiredSymbolsFetchLastSuccessEpochMs) {
        it.get().toDouble() / 1_000.0
      }.register(registry)

    Gauge
      .builder("torghut_ws_desired_symbols_fetch_last_failure_ts_seconds", desiredSymbolsFetchLastFailureEpochMs) {
        it.get().toDouble() / 1_000.0
      }.register(registry)

    readinessErrorClassGauge.forEach { (errorClass, value) ->
      Gauge
        .builder("torghut_ws_readyz_error_class", value) { it.get().toDouble() }
        .tag("error_class", errorClass.id)
        .register(registry)
    }

    readinessGateStatus.forEach { (gate, value) ->
      Gauge
        .builder("torghut_ws_readyz_gate_status", value) { it.get().toDouble() }
        .tag("gate", gate)
        .register(registry)
    }
  }

  fun setReady(ready: Boolean) {
    readinessStatus.set(if (ready) 1 else 0)
  }

  fun setReadinessErrorClass(errorClass: ReadinessErrorClass?) {
    readinessErrorClassGauge.forEach { (cls, value) ->
      value.set(if (cls == errorClass) 1 else 0)
    }
  }

  fun setReadinessGates(gates: ReadinessGates) {
    readinessGateStatus["alpaca_ws"]?.set(if (gates.alpacaWs) 1 else 0)
    readinessGateStatus["kafka"]?.set(if (gates.kafka) 1 else 0)
    readinessGateStatus["trade_updates"]?.set(if (gates.tradeUpdates) 1 else 0)
    readinessGateStatus["market_data_channels"]?.set(if (gates.marketDataChannels) 1 else 0)
  }

  fun recordReadinessError(errorClass: ReadinessErrorClass) {
    readinessErrorCounters
      .computeIfAbsent(errorClass.id) { cls ->
        Counter
          .builder("torghut_ws_readiness_errors_total")
          .tag("error_class", cls)
          .register(registry)
      }.increment()
  }

  fun recordWsConnectError(errorClass: ReadinessErrorClass) {
    wsConnectErrorCounters
      .computeIfAbsent(errorClass.id) { cls ->
        Counter
          .builder("torghut_ws_ws_connect_errors_total")
          .tag("error_class", cls)
          .register(registry)
      }.increment()
  }

  fun recordKafkaProduceSuccess(topic: String) {
    kafkaProduceSuccessCounters
      .computeIfAbsent(topic) { t ->
        Counter
          .builder("torghut_ws_kafka_produce_success_total")
          .tag("topic", t)
          .register(registry)
      }.increment()
  }

  fun recordKafkaProduceError(
    topic: String,
    errorClass: ReadinessErrorClass,
  ) {
    kafkaProduceErrorCounters
      .computeIfAbsent("$topic|${errorClass.id}") { key ->
        val parts = key.split("|", limit = 2)
        Counter
          .builder("torghut_ws_kafka_produce_errors_total")
          .tag("topic", parts[0])
          .tag("error_class", parts[1])
          .register(registry)
      }.increment()
  }

  fun recordKafkaMetadataError(errorClass: ReadinessErrorClass) {
    kafkaMetadataErrorCounters
      .computeIfAbsent(errorClass.id) { cls ->
        Counter
          .builder("torghut_ws_kafka_metadata_errors_total")
          .tag("error_class", cls)
          .register(registry)
      }.increment()
  }

  fun recordLagMs(lagMs: Long) {
    if (lagMs < 0) return
    lagSummary.record(lagMs.toDouble())
  }

  fun recordMarketDataLagMs(
    feed: String,
    channel: String,
    lagMs: Long,
  ) {
    if (lagMs < 0) return
    marketDataLagSummaries
      .computeIfAbsent("$feed|$channel") { key ->
        val parts = key.split("|", limit = 2)
        DistributionSummary
          .builder("torghut_ws_market_data_lag_ms")
          .tag("feed", parts[0])
          .tag("channel", parts[1])
          .publishPercentileHistogram()
          .register(registry)
      }.record(lagMs.toDouble())
  }

  fun recordKafkaLatency(duration: Duration) {
    kafkaLatency.record(duration)
  }

  fun recordDedup(channel: String) {
    dedupCounters
      .computeIfAbsent(channel) { dedupChannel ->
        Counter
          .builder("torghut_ws_dedup_drops_total")
          .tag("channel", dedupChannel)
          .register(registry)
      }.increment()
  }

  fun recordMarketDataDedup(
    feed: String,
    channel: String,
  ) {
    dedupCounters
      .computeIfAbsent("market_data|$feed|$channel") { key ->
        val parts = key.split("|", limit = 3)
        Counter
          .builder("torghut_ws_market_data_dedup_drops_total")
          .tag("feed", parts[1])
          .tag("channel", parts[2])
          .register(registry)
      }.increment()
  }

  fun recordProviderMessage(
    marketType: AlpacaMarketType,
    feed: String,
    channel: String,
  ) {
    providerMessageCounters
      .computeIfAbsent("${marketType.name}|$feed|$channel") { key ->
        val parts = key.split("|", limit = 3)
        Counter
          .builder("torghut_ws_provider_messages_total")
          .tag("market_type", parts[0].lowercase())
          .tag("feed", parts[1])
          .tag("channel", parts[2])
          .register(registry)
      }.increment()
  }

  fun recordMarketDataDrop(
    marketType: AlpacaMarketType,
    feed: String,
    channel: String,
    reason: String,
  ) {
    marketDataDropCounters
      .computeIfAbsent("${marketType.name}|$feed|$channel|$reason") { key ->
        val parts = key.split("|", limit = 4)
        Counter
          .builder("torghut_ws_market_data_drops_total")
          .tag("market_type", parts[0].lowercase())
          .tag("feed", parts[1])
          .tag("channel", parts[2])
          .tag("reason", parts[3])
          .register(registry)
      }.increment()
  }

  fun recordMarketDataReconnect(feed: String) {
    marketDataReconnectCounters
      .computeIfAbsent(feed) { value ->
        Counter
          .builder("torghut_ws_market_data_reconnects_total")
          .tag("feed", value)
          .register(registry)
      }.increment()
  }

  fun recordMarketDataWsConnectSuccess(feed: String) {
    marketDataWsConnectSuccessCounters
      .computeIfAbsent(feed) { value ->
        Counter
          .builder("torghut_ws_market_data_connect_success_total")
          .tag("feed", value)
          .register(registry)
      }.increment()
  }

  fun recordMarketDataWsConnectError(
    feed: String,
    errorClass: ReadinessErrorClass,
  ) {
    marketDataWsConnectErrorCounters
      .computeIfAbsent("$feed|${errorClass.id}") { key ->
        val parts = key.split("|", limit = 2)
        Counter
          .builder("torghut_ws_market_data_connect_errors_total")
          .tag("feed", parts[0])
          .tag("error_class", parts[1])
          .register(registry)
      }.increment()
  }

  fun setOptionsEventStarvation(starved: Boolean) {
    optionsEventStarvation.set(if (starved) 1 else 0)
  }

  fun setMarketDataChannelReadiness(
    feed: String,
    channels: Collection<MarketDataChannelReadiness>,
  ) {
    channels.forEach { channel ->
      setMarketDataChannelGauge(
        feed = feed,
        channel = channel.channel,
        field = "ready",
        value = if (channel.ready) 1 else 0,
      )
      setMarketDataChannelGauge(
        feed = feed,
        channel = channel.channel,
        field = "lag_ms",
        value = channel.lagMs ?: -1,
      )
      setMarketDataChannelGauge(
        feed = feed,
        channel = channel.channel,
        field = "latest_provider_event_at_ms",
        value = channel.latestProviderEventAtMs ?: 0,
      )
      setMarketDataChannelGauge(
        feed = feed,
        channel = channel.channel,
        field = "latest_serialized_at_ms",
        value = channel.latestSerializedAtMs ?: 0,
      )
      setMarketDataChannelGauge(
        feed = feed,
        channel = channel.channel,
        field = "latest_kafka_success_at_ms",
        value = channel.latestKafkaSuccessAtMs ?: 0,
      )
      setMarketDataChannelGauge(
        feed = feed,
        channel = channel.channel,
        field = "latest_subscription_ack_at_ms",
        value = channel.latestSubscriptionAckAtMs ?: 0,
      )
      setMarketDataChannelGauge(
        feed = feed,
        channel = channel.channel,
        field = "subscription_ack_lag_ms",
        value = channel.subscriptionAckLagMs ?: -1,
      )
      setMarketDataChannelGauge(
        feed = feed,
        channel = channel.channel,
        field = "subscribed_symbol_count",
        value = channel.subscribedSymbolCount.toLong(),
      )
      setMarketDataChannelGauge(
        feed = feed,
        channel = channel.channel,
        field = "observed_symbol_count",
        value = channel.observedSymbolCount.toLong(),
      )
      setMarketDataChannelGauge(
        feed = feed,
        channel = channel.channel,
        field = "fresh_symbol_count",
        value = channel.freshSymbolCount.toLong(),
      )
      setMarketDataChannelGauge(
        feed = feed,
        channel = channel.channel,
        field = "missing_symbol_count",
        value = channel.missingSymbols.size.toLong(),
      )
      setMarketDataChannelGauge(
        feed = feed,
        channel = channel.channel,
        field = "stale_symbol_count",
        value = channel.staleSymbols.size.toLong(),
      )
    }
  }

  private fun setMarketDataChannelGauge(
    feed: String,
    channel: String,
    field: String,
    value: Long,
  ) {
    marketDataChannelGaugeValues
      .computeIfAbsent("$feed|$channel|$field") { key ->
        val parts = key.split("|", limit = 3)
        val gaugeValue = AtomicLong(0)
        Gauge
          .builder("torghut_ws_market_data_channel", gaugeValue) { it.get().toDouble() }
          .tag("feed", parts[0])
          .tag("channel", parts[1])
          .tag("field", parts[2])
          .register(registry)
        gaugeValue
      }.set(value)
  }

  fun recordDesiredSymbolsFetchSuccess() {
    desiredSymbolsFetchSuccess.increment()
    desiredSymbolsFetchDegraded.set(0)
    desiredSymbolsFetchLastSuccessEpochMs.set(System.currentTimeMillis())
  }

  fun recordDesiredSymbolsFetchFailure(reason: String) {
    desiredSymbolsFetchFailureCounters
      .computeIfAbsent(reason) { failureReason ->
        Counter
          .builder("torghut_ws_desired_symbols_fetch_failures_total")
          .tag("reason", failureReason)
          .register(registry)
      }.increment()
    desiredSymbolsFetchDegraded.set(1)
    desiredSymbolsFetchLastFailureEpochMs.set(System.currentTimeMillis())
  }
}
