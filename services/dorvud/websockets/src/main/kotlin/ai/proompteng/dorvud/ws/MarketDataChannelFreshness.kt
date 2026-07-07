package ai.proompteng.dorvud.ws

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.LocalDate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

@Serializable
data class MarketDataChannelReadiness(
  val channel: String,
  val ready: Boolean,
  @SerialName("required") val required: Boolean,
  @SerialName("latest_provider_event_at_ms") val latestProviderEventAtMs: Long? = null,
  @SerialName("latest_serialized_at_ms") val latestSerializedAtMs: Long? = null,
  @SerialName("latest_kafka_success_at_ms") val latestKafkaSuccessAtMs: Long? = null,
  @SerialName("latest_symbol") val latestSymbol: String? = null,
  @SerialName("subscribed_symbol_count") val subscribedSymbolCount: Int = 0,
  @SerialName("observed_symbol_count") val observedSymbolCount: Int = 0,
  @SerialName("observed_symbols") val observedSymbols: List<String> = emptyList(),
  @SerialName("lag_ms") val lagMs: Long? = null,
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
) {
  private val requiredChannels = requiredChannels.mapNotNull(::canonicalMarketDataChannel).distinct()
  private val latestByChannel = ConcurrentHashMap<String, ChannelFreshnessState>()
  private val subscribedSymbols = AtomicReference<Set<String>>(emptySet())
  private val subscribedSinceMs = AtomicLong(0)

  fun recordSubscription(symbols: Collection<String>) {
    val normalized = symbols.map { it.trim().uppercase() }.filter { it.isNotEmpty() }.toSet()
    subscribedSymbols.set(normalized)
    if (normalized.isEmpty()) {
      subscribedSinceMs.set(0)
      return
    }
    subscribedSinceMs.compareAndSet(0, nowMs())
  }

  fun clearSubscription() {
    subscribedSymbols.set(emptySet())
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
    val symbols = subscribedSymbols.get()
    val gateActive =
      symbols.isNotEmpty() &&
        subscribedAt > 0 &&
        now - subscribedAt >= warmupMs &&
        marketSessionActive(Instant.ofEpochMilli(now))
    return requiredChannels.map { channel ->
      val state = latestByChannel[channel]
      val latestKafkaSuccessAt = state?.latestKafkaSuccessAtMs?.get()?.takeIf { it > 0 }
      val latestProviderAt = state?.latestProviderEventAtMs?.get()?.takeIf { it > 0 }
      val latestSerializedAt = state?.latestSerializedAtMs?.get()?.takeIf { it > 0 }
      val observedSymbols =
        state
          ?.kafkaSuccessSymbols
          ?.toList()
          ?.sorted()
          .orEmpty()
      val lagMs = latestKafkaSuccessAt?.let { (now - it).coerceAtLeast(0) }
      val ready =
        when {
          !gateActive -> true
          latestKafkaSuccessAt == null -> false
          lagMs == null -> false
          else -> lagMs <= maxLagMs
        }
      MarketDataChannelReadiness(
        channel = channel,
        ready = ready,
        required = true,
        latestProviderEventAtMs = latestProviderAt,
        latestSerializedAtMs = latestSerializedAt,
        latestKafkaSuccessAtMs = latestKafkaSuccessAt,
        latestSymbol = state?.latestSymbol?.get(),
        subscribedSymbolCount = symbols.size,
        observedSymbolCount = observedSymbols.size,
        observedSymbols = observedSymbols,
        lagMs = lagMs,
        maxLagMs = maxLagMs,
        reason =
          when {
            ready && !gateActive -> "market_data_channel_gate_inactive"
            ready -> "market_data_channel_fresh"
            latestKafkaSuccessAt == null -> "market_data_channel_missing_kafka_success"
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

  private fun marketSessionActive(now: Instant): Boolean =
    when (marketType) {
      AlpacaMarketType.CRYPTO -> true
      AlpacaMarketType.EQUITY, AlpacaMarketType.OPTIONS -> isRegularMarketSession(now, marketHolidays)
    }

  private class ChannelFreshnessState {
    val latestProviderEventAtMs = AtomicLong(0)
    val latestSerializedAtMs = AtomicLong(0)
    val latestKafkaSuccessAtMs = AtomicLong(0)
    val latestSymbol = AtomicReference<String?>(null)
    val kafkaSuccessSymbols: MutableSet<String> = ConcurrentHashMap.newKeySet()

    fun recordProviderEvent(
      atMs: Long,
      symbol: String?,
    ) {
      latestProviderEventAtMs.set(atMs)
      updateSymbol(symbol)
    }

    fun recordSerializedEvent(
      atMs: Long,
      symbol: String?,
    ) {
      latestSerializedAtMs.set(atMs)
      updateSymbol(symbol)
    }

    fun recordKafkaSuccess(
      atMs: Long,
      symbol: String?,
    ) {
      latestKafkaSuccessAtMs.set(atMs)
      updateSymbol(symbol)
      val normalized = normalizeSymbol(symbol) ?: return
      kafkaSuccessSymbols.add(normalized)
    }

    private fun updateSymbol(symbol: String?) {
      val normalized = normalizeSymbol(symbol) ?: return
      latestSymbol.set(normalized)
    }
  }
}

internal fun canonicalMarketDataChannel(channel: String): String? =
  when (val normalized = channel.trim().lowercase()) {
    "trade", "trades" -> "trades"
    "quote", "quotes" -> "quotes"
    "bars" -> "bars"
    "updatedbars" -> "updatedBars"
    else -> null
  }

private fun normalizeSymbol(symbol: String?): String? =
  symbol
    ?.trim()
    ?.uppercase()
    ?.takeIf { it.isNotEmpty() }
