package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.Envelope
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

@Serializable
data class MarketDataChannelReadiness(
  val channel: String,
  val ready: Boolean,
  @SerialName("required") val required: Boolean,
  @SerialName("gate_active") val gateActive: Boolean,
  @SerialName("market_session_state") val marketSessionState: String,
  @SerialName("readiness_mode") val readinessMode: String = "continuous",
  @SerialName("freshness_required") val freshnessRequired: Boolean = true,
  @SerialName("symbol_coverage_required") val symbolCoverageRequired: Boolean = true,
  @SerialName("latest_provider_event_at_ms") val latestProviderEventAtMs: Long? = null,
  @SerialName("latest_serialized_at_ms") val latestSerializedAtMs: Long? = null,
  @SerialName("latest_kafka_success_at_ms") val latestKafkaSuccessAtMs: Long? = null,
  @SerialName("latest_subscription_ack_at_ms") val latestSubscriptionAckAtMs: Long? = null,
  @SerialName("latest_symbol") val latestSymbol: String? = null,
  @SerialName("subscribed_symbol_count") val subscribedSymbolCount: Int = 0,
  @SerialName("subscribed_symbols") val subscribedSymbols: List<String> = emptyList(),
  @SerialName("observed_symbol_count") val observedSymbolCount: Int = 0,
  @SerialName("observed_symbols") val observedSymbols: List<String> = emptyList(),
  @SerialName("fresh_symbol_count") val freshSymbolCount: Int = 0,
  @SerialName("fresh_symbols") val freshSymbols: List<String> = emptyList(),
  @SerialName("missing_symbols") val missingSymbols: List<String> = emptyList(),
  @SerialName("stale_symbols") val staleSymbols: List<String> = emptyList(),
  @SerialName("symbol_lag_ms") val symbolLagMs: Map<String, Long> = emptyMap(),
  @SerialName("lag_ms") val lagMs: Long? = null,
  @SerialName("subscription_ack_lag_ms") val subscriptionAckLagMs: Long? = null,
  @SerialName("max_lag_ms") val maxLagMs: Long,
  @SerialName("reason") val reason: String,
)

internal class MarketDataChannelFreshnessTracker(
  requiredChannels: Collection<String>,
  private val maxLagMs: Long,
  private val warmupMs: Long,
  private val nowMs: () -> Long,
  private val marketType: AlpacaMarketType,
  private val marketHolidays: Set<LocalDate> = emptySet(),
  private val equityFeed: EquityFeed? = null,
) {
  private val requiredChannels = requiredChannels.mapNotNull(::canonicalMarketDataChannel).distinct()
  private val latestByChannel = ConcurrentHashMap<String, ChannelFreshnessState>()
  private val subscribedSymbolsByChannel = AtomicReference<Map<String, Set<String>>>(emptyMap())
  private val latestSubscriptionAckAtMsByChannel = ConcurrentHashMap<String, AtomicLong>()
  private val subscribedSinceMs = AtomicLong(0)

  fun recordSubscription(symbols: Collection<String>) {
    recordSubscriptionByChannel(requiredChannels.associateWith { symbols })
  }

  fun recordSubscriptionByChannel(symbolsByChannel: Map<String, Collection<String>>) {
    val observedAtMs = nowMs()
    val inputByCanonical =
      symbolsByChannel.entries.groupBy(
        keySelector = { (channel, _) -> canonicalMarketDataChannel(channel) },
        valueTransform = { (_, symbols) -> symbols },
      )
    val normalizedByChannel =
      requiredChannels.associateWith { channel ->
        inputByCanonical[channel]
          ?.flatten()
          ?.mapNotNull(::normalizeSymbol)
          ?.toSet()
          .orEmpty()
      }
    subscribedSymbolsByChannel.set(normalizedByChannel)
    normalizedByChannel.keys.forEach { channel ->
      latestSubscriptionAckAtMsByChannel
        .computeIfAbsent(channel) { AtomicLong(0) }
        .set(observedAtMs)
    }
    if (normalizedByChannel.values.all { it.isEmpty() }) {
      subscribedSinceMs.set(0)
      return
    }
    subscribedSinceMs.compareAndSet(0, nowMs())
  }

  fun clearSubscription() {
    subscribedSymbolsByChannel.set(emptyMap())
    latestSubscriptionAckAtMsByChannel.clear()
    subscribedSinceMs.set(0)
  }

  fun recordProviderEvent(
    channel: String,
    symbol: String?,
  ) {
    state(channel)?.recordProviderEvent(nowMs(), symbol)
  }

  fun recordSerializedEvent(
    channel: String,
    symbol: String?,
  ) {
    state(channel)?.recordSerializedEvent(nowMs(), symbol)
  }

  fun recordKafkaSuccess(
    channel: String?,
    symbol: String?,
  ) {
    if (channel == null) return
    state(channel)?.recordKafkaSuccess(nowMs(), symbol)
  }

  fun ready(): Boolean = snapshot().all { it.ready }

  fun snapshot(): List<MarketDataChannelReadiness> {
    val now = nowMs()
    val subscribedAt = subscribedSinceMs.get()
    val symbolsByChannel = subscribedSymbolsByChannel.get()
    val hasAnySubscribedSymbols = symbolsByChannel.values.any { it.isNotEmpty() }
    val sessionState = marketSessionState(Instant.ofEpochMilli(now), marketType, marketHolidays)
    val gateActive =
      hasAnySubscribedSymbols &&
        subscribedAt > 0 &&
        now - subscribedAt >= warmupMs &&
        marketDataFreshnessGateActive(sessionState, equityFeed)
    return requiredChannels.map { channel ->
      val channelSymbols = symbolsByChannel[channel].orEmpty()
      val readinessMode = readinessModeFor(channel, marketType)
      val freshnessRequired = readinessMode == MarketDataChannelReadinessMode.CONTINUOUS
      // Alpaca omits a stock minute bar when that symbol has no qualifying trades in the interval.
      // Keep the channel freshness gate, but do not turn an expected per-symbol bar gap into a restart loop.
      val equityBarMayBeAbsent = marketType == AlpacaMarketType.EQUITY && channel == "bars"
      val symbolCoverageRequired =
        readinessMode == MarketDataChannelReadinessMode.CONTINUOUS &&
          marketType != AlpacaMarketType.OPTIONS &&
          !equityBarMayBeAbsent
      val state = latestByChannel[channel]
      val latestKafkaSuccessAt = state?.latestKafkaSuccessAtMs?.get()?.takeIf { it > 0 }
      val latestProviderAt = state?.latestProviderEventAtMs?.get()?.takeIf { it > 0 }
      val latestSerializedAt = state?.latestSerializedAtMs?.get()?.takeIf { it > 0 }
      val latestObservedInputAt = listOfNotNull(latestProviderAt, latestSerializedAt).maxOrNull()
      val latestSubscriptionAckAt = latestSubscriptionAckAtMsByChannel[channel]?.get()?.takeIf { it > 0 }
      val symbolLastSeen = state?.latestKafkaSuccessAtMsBySymbol?.mapValues { (_, seenAt) -> seenAt.get() }.orEmpty()
      val symbolObservedInput = state?.latestObservedInputAtMsBySymbol?.mapValues { (_, seenAt) -> seenAt.get() }.orEmpty()
      val subscribedSymbols = channelSymbols.sorted()
      val observedSymbols =
        symbolLastSeen
          .keys
          .filter { symbol -> symbol in channelSymbols }
          .sorted()
      val lagMs = latestKafkaSuccessAt?.let { (now - it).coerceAtLeast(0) }
      val symbolCoverageDiagnostic =
        symbolCoverageRequired ||
          marketType == AlpacaMarketType.OPTIONS ||
          equityBarMayBeAbsent
      val symbolLagMs =
        channelSymbols
          .mapNotNull { symbol ->
            val seenAt = symbolLastSeen[symbol]?.takeIf { it > 0 } ?: return@mapNotNull null
            symbol to (now - seenAt).coerceAtLeast(0)
          }.toMap()
      val subscriptionAckLagMs = latestSubscriptionAckAt?.let { (now - it).coerceAtLeast(0) }
      val freshSymbols =
        if (symbolCoverageDiagnostic) {
          channelSymbols
            .filter { symbol -> symbolLagMs[symbol]?.let { it <= maxLagMs } == true }
            .sorted()
        } else {
          observedSymbols
            .filter { symbol -> symbolLagMs[symbol]?.let { it <= maxLagMs } == true }
            .sorted()
        }
      val missingSymbols =
        if (symbolCoverageDiagnostic) {
          channelSymbols
            .filter { symbol -> symbol !in symbolLastSeen }
            .sorted()
        } else {
          emptyList()
        }
      val staleSymbols =
        if (symbolCoverageDiagnostic) {
          channelSymbols
            .filter { symbol -> symbolLastSeen.containsKey(symbol) && symbol !in freshSymbols }
            .sorted()
        } else {
          emptyList()
        }
      val gatedMissingSymbols = if (symbolCoverageRequired) missingSymbols else emptyList()
      val gatedStaleSymbols = if (symbolCoverageRequired) staleSymbols else emptyList()
      val subscribedSymbolObservedInput = symbolObservedInput.filterKeys { symbol -> symbol in channelSymbols }
      val latestObservedSymbolInput =
        subscribedSymbolObservedInput
          .filterValues { it > 0 }
          .maxByOrNull { (_, seenAt) -> seenAt }
      val latestObservedInputForReadiness =
        latestObservedSymbolInput?.value
          ?: latestObservedInputAt?.takeIf { symbolObservedInput.isEmpty() || channelSymbols.isEmpty() }
      val latestObservedSymbolKafkaSuccessAt =
        latestObservedSymbolInput?.let { (symbol, _) -> symbolLastSeen[symbol] }
      val kafkaSuccessCoversLatestObservedInput =
        latestObservedSymbolInput?.let { (_, observedAt) ->
          latestObservedSymbolKafkaSuccessAt?.let { it >= observedAt } == true
        } ?: latestObservedInputAt?.let { observedAt ->
          latestKafkaSuccessAt?.let { it >= observedAt } == true
        } ?: true
      val conditionalKafkaSuccessMissing =
        !freshnessRequired &&
          latestObservedInputForReadiness != null &&
          !kafkaSuccessCoversLatestObservedInput &&
          now - latestObservedInputForReadiness > maxLagMs
      val ready =
        when {
          !gateActive -> true
          channelSymbols.isEmpty() -> false
          !freshnessRequired -> !conditionalKafkaSuccessMissing
          latestKafkaSuccessAt == null -> false
          gatedMissingSymbols.isNotEmpty() -> false
          gatedStaleSymbols.isNotEmpty() -> false
          lagMs == null -> false
          else -> lagMs <= maxLagMs
        }
      MarketDataChannelReadiness(
        channel = channel,
        ready = ready,
        required = true,
        gateActive = gateActive,
        marketSessionState = sessionState,
        readinessMode = readinessMode.id,
        freshnessRequired = freshnessRequired,
        symbolCoverageRequired = symbolCoverageRequired,
        latestProviderEventAtMs = latestProviderAt,
        latestSerializedAtMs = latestSerializedAt,
        latestKafkaSuccessAtMs = latestKafkaSuccessAt,
        latestSubscriptionAckAtMs = latestSubscriptionAckAt,
        latestSymbol = state?.latestSymbol?.get(),
        subscribedSymbolCount = channelSymbols.size,
        subscribedSymbols = subscribedSymbols,
        observedSymbolCount = observedSymbols.size,
        observedSymbols = observedSymbols,
        freshSymbolCount = freshSymbols.size,
        freshSymbols = freshSymbols,
        missingSymbols = missingSymbols,
        staleSymbols = staleSymbols,
        symbolLagMs = symbolLagMs,
        lagMs = lagMs,
        subscriptionAckLagMs = subscriptionAckLagMs,
        maxLagMs = maxLagMs,
        reason =
          when {
            ready && !gateActive -> "market_data_channel_gate_inactive"
            ready && !freshnessRequired && latestObservedInputAt == null -> "market_data_channel_conditional_no_events"
            ready && !freshnessRequired && latestKafkaSuccessAt == null -> "market_data_channel_conditional_pending_kafka_success"
            ready && !freshnessRequired -> "market_data_channel_conditional_observed"
            ready -> "market_data_channel_fresh"
            channelSymbols.isEmpty() -> "market_data_channel_not_subscribed"
            conditionalKafkaSuccessMissing -> "market_data_channel_conditional_missing_kafka_success"
            freshnessRequired && latestKafkaSuccessAt == null -> "market_data_channel_missing_kafka_success"
            gatedMissingSymbols.isNotEmpty() -> "market_data_channel_missing_symbol_coverage"
            gatedStaleSymbols.isNotEmpty() -> "market_data_channel_stale_symbol_coverage"
            else -> "market_data_channel_stale"
          },
      )
    }
  }

  private fun state(channel: String): ChannelFreshnessState? {
    val canonical = canonicalMarketDataChannel(channel) ?: return null
    if (canonical !in requiredChannels) return null
    return latestByChannel.computeIfAbsent(canonical) { ChannelFreshnessState() }
  }

  private class ChannelFreshnessState {
    val latestProviderEventAtMs = AtomicLong(0)
    val latestSerializedAtMs = AtomicLong(0)
    val latestKafkaSuccessAtMs = AtomicLong(0)
    val latestSymbol = AtomicReference<String?>(null)
    val latestObservedInputAtMsBySymbol = ConcurrentHashMap<String, AtomicLong>()
    val latestKafkaSuccessAtMsBySymbol = ConcurrentHashMap<String, AtomicLong>()

    fun recordProviderEvent(
      atMs: Long,
      symbol: String?,
    ) {
      latestProviderEventAtMs.set(atMs)
      recordObservedInputSymbol(atMs, symbol)
      updateSymbol(symbol)
    }

    fun recordSerializedEvent(
      atMs: Long,
      symbol: String?,
    ) {
      latestSerializedAtMs.set(atMs)
      recordObservedInputSymbol(atMs, symbol)
      updateSymbol(symbol)
    }

    fun recordKafkaSuccess(
      atMs: Long,
      symbol: String?,
    ) {
      latestKafkaSuccessAtMs.set(atMs)
      updateSymbol(symbol)
      val normalized = normalizeSymbol(symbol) ?: return
      latestKafkaSuccessAtMsBySymbol
        .computeIfAbsent(normalized) { AtomicLong(0) }
        .set(atMs)
    }

    private fun updateSymbol(symbol: String?) {
      val normalized = normalizeSymbol(symbol) ?: return
      latestSymbol.set(normalized)
    }

    private fun recordObservedInputSymbol(
      atMs: Long,
      symbol: String?,
    ) {
      val normalized = normalizeSymbol(symbol) ?: return
      latestObservedInputAtMsBySymbol
        .computeIfAbsent(normalized) { AtomicLong(0) }
        .set(atMs)
    }
  }
}

private val marketDataFreshnessZoneId: ZoneId = ZoneId.of("America/New_York")
private val overnightSessionClose: LocalTime = LocalTime.of(4, 0)
private val regularSessionOpen: LocalTime = LocalTime.of(9, 30)
private val regularSessionClose: LocalTime = LocalTime.of(16, 0)
private val extendedSessionClose: LocalTime = LocalTime.of(20, 0)

internal fun marketDataFreshnessGateActive(
  sessionState: String,
  equityFeed: EquityFeed? = null,
): Boolean =
  when (equityFeed) {
    EquityFeed.Sip, EquityFeed.DelayedSip -> sessionState in setOf("pre", "regular", "post")
    EquityFeed.Overnight -> sessionState == "overnight"
    EquityFeed.Iex, null -> sessionState == "continuous" || sessionState == "regular"
  }

internal fun marketSessionState(
  now: Instant,
  marketType: AlpacaMarketType,
  marketHolidays: Set<LocalDate> = emptySet(),
): String {
  if (marketType == AlpacaMarketType.CRYPTO) return "continuous"
  val marketNow = now.atZone(marketDataFreshnessZoneId)
  if (marketNow.toLocalDate() in marketHolidays) return "holiday"
  val day = marketNow.dayOfWeek
  val localTime = marketNow.toLocalTime()
  if (day == DayOfWeek.SATURDAY || (day == DayOfWeek.SUNDAY && localTime < extendedSessionClose)) {
    return "weekend"
  }
  if (day == DayOfWeek.FRIDAY && localTime >= extendedSessionClose) return "closed"
  return when {
    localTime < overnightSessionClose -> "overnight"
    localTime < regularSessionOpen -> "pre"
    localTime < regularSessionClose -> "regular"
    localTime < extendedSessionClose -> "post"
    else -> "overnight"
  }
}

private enum class MarketDataChannelReadinessMode(
  val id: String,
) {
  CONTINUOUS("continuous"),
  CONDITIONAL("conditional"),
}

private fun readinessModeFor(
  channel: String,
  marketType: AlpacaMarketType,
): MarketDataChannelReadinessMode =
  when {
    canonicalMarketDataChannel(channel) == "updatedBars" -> MarketDataChannelReadinessMode.CONDITIONAL
    marketType == AlpacaMarketType.OPTIONS && canonicalMarketDataChannel(channel) == "trades" ->
      MarketDataChannelReadinessMode.CONDITIONAL
    else -> MarketDataChannelReadinessMode.CONTINUOUS
  }

internal fun canonicalMarketDataChannel(channel: String): String? =
  when (val normalized = channel.trim().lowercase()) {
    "trade", "trades" -> "trades"
    "quote", "quotes" -> "quotes"
    "bars" -> "bars"
    "updatedbars" -> "updatedBars"
    else -> null
  }

internal fun marketDataFreshnessChannelFor(
  env: Envelope<*>,
  marketDataChannel: String?,
): String? {
  if (!env.source.equals("ws", ignoreCase = true)) return null
  return marketDataChannel
}

private fun normalizeSymbol(symbol: String?): String? =
  symbol
    ?.trim()
    ?.uppercase()
    ?.takeIf { it.isNotEmpty() }
