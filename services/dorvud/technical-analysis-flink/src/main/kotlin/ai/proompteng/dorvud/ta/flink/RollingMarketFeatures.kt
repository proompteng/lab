package ai.proompteng.dorvud.ta.flink

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneId
import kotlin.math.floor

internal const val ROLLING_FEATURE_DEFINITION = "dorvud.rolling-price-30m.v1"
internal const val ROLLING_FEATURE_SCHEMA = "dorvud.market-feature.v1"
internal const val FEATURE_SESSION_POLICY = "alpaca.regular.new-york-date.v1"
internal const val FEATURE_LOOKBACK_MINUTES = 30
internal const val FEATURE_MAX_CLOCK_SKEW_MS = 5000L
private const val MINUTE_MS = 60_000L
private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
private val featureZone = ZoneId.of("America/New_York")

@Serializable
data class MarketFeatureInput(
  val eventTimeNanos: String,
  val ingestionTimeNanos: String,
  val sourceTopic: String,
  val sourcePartition: Int,
  val sourceOffset: String,
  val contentHash: String,
)

@Serializable
data class RollingMarketValues(
  val referencePriceMicros: String,
  val rangeHighPriceMicros: String,
  val rangeLowPriceMicros: String,
  val lastClosePriceMicros: String,
  val totalVolumeMicros: String,
)

@Serializable
data class RollingMarketFeatureMaterial(
  val schemaVersion: String = ROLLING_FEATURE_SCHEMA,
  val definitionId: String = ROLLING_FEATURE_DEFINITION,
  val definitionHash: String = rollingFeatureDefinitionHash(),
  val provider: String,
  val feed: String,
  val delayClass: String,
  val universeId: String,
  val universeSymbolHash: String,
  val symbol: String,
  val sessionDate: String,
  val sessionPolicy: String = FEATURE_SESSION_POLICY,
  val windowStartMs: Long,
  val windowEndMs: Long,
  val inputs: List<MarketFeatureInput>,
  val values: RollingMarketValues,
)

@Serializable
data class RollingMarketFeature(
  val material: RollingMarketFeatureMaterial,
  val featureId: String,
  val computedAtMs: Long,
  val producerRevision: String,
)

data class RollingFeatureState(
  val sessionDate: String = "",
  val bars: List<IntradayBarRecord> = emptyList(),
  val lastFeatureId: String? = null,
) : java.io.Serializable

data class RollingFeatureTransition(
  val state: RollingFeatureState,
  val feature: RollingMarketFeature?,
  val rejection: String? = null,
)

internal fun featureHash(element: JsonElement): String {
  fun canonical(value: JsonElement): String =
    when (value) {
      is JsonObject -> value.keys.sorted().joinToString(",", "{", "}") { key -> "${JsonPrimitive(key)}:${canonical(value.getValue(key))}" }
      is JsonArray -> value.joinToString(",", "[", "]", transform = ::canonical)
      else -> value.toString()
    }
  return MessageDigest.getInstance("SHA-256").digest(canonical(element).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}

internal fun rollingFeatureDefinitionHash(): String =
  featureHash(
    JsonArray(
      listOf(
        ROLLING_FEATURE_DEFINITION,
        FEATURE_SESSION_POLICY,
        "30xPT1M-complete",
        "binary64-times-1000000-round-half-positive-infinity",
        "bar-winner:ingestion-nanos,partition,offset",
        "raw-content:binary64-hex-v1",
        "cross-host-clock-skew-ms:$FEATURE_MAX_CLOCK_SKEW_MS",
      ).map(::JsonPrimitive),
    ),
  )

internal fun featureNanos(value: Instant): String =
  (value.epochSecond.toBigInteger() * 1_000_000_000L.toBigInteger() + value.nano.toBigInteger()).toString()

private fun doubleBits(value: Double): String =
  java.lang.Long
    .toUnsignedString(value.toRawBits(), 16)
    .padStart(16, '0')

internal fun featureBarContentHash(bar: IntradayBarRecord): String =
  featureHash(
    JsonArray(
      listOf(
        bar.provider,
        bar.universeId,
        bar.universeSymbolHash,
        bar.feed,
        bar.marketSession,
        bar.delayClass,
        bar.symbol,
        featureNanos(bar.eventTime),
        featureNanos(bar.ingestionTime),
        bar.channel,
        bar.final.toString(),
        bar.schemaVersion.toString(),
        doubleBits(bar.open),
        doubleBits(bar.high),
        doubleBits(bar.low),
        doubleBits(bar.close),
        doubleBits(bar.volume),
        bar.vwap?.let(::doubleBits) ?: "null",
        bar.tradeCount?.toString() ?: "null",
      ).map(::JsonPrimitive),
    ),
  )

internal fun featureMicros(value: Double): Long {
  require(value.isFinite() && value >= 0) { "feature value must be finite and non-negative" }
  val scaled = value * 1_000_000
  val integral = floor(scaled)
  val rounded = if (scaled - integral >= 0.5) integral + 1 else integral
  require(rounded <= MAX_SAFE_INTEGER.toDouble()) { "feature value exceeds exact integer range" }
  return rounded.toLong()
}

internal fun compareFeatureBarRevision(
  left: IntradayBarRecord,
  right: IntradayBarRecord,
): Int =
  compareValues(left.ingestionTime, right.ingestionTime).takeIf { it != 0 }
    ?: compareValues(left.sourcePartition, right.sourcePartition).takeIf { it != 0 }
    ?: compareValues(left.sourceOffset, right.sourceOffset)

internal fun rollingFeatureKey(bar: IntradayBarRecord): String =
  listOf(bar.provider, bar.feed, bar.delayClass, bar.universeId, bar.universeSymbolHash, bar.symbol).joinToString("|")

internal fun advanceRollingFeature(
  previous: RollingFeatureState,
  bar: IntradayBarRecord,
  computedAtMs: Long,
  producerRevision: String,
): RollingFeatureTransition {
  require(bar.provider == "alpaca" && bar.feed == "iex" && bar.delayClass == "real_time_exchange_only") { "unsupported feature feed" }
  require(bar.marketSession == "regular" && bar.final) { "features require finalized regular-session bars" }
  require(bar.eventTime.nano == 0 && bar.eventTime.epochSecond % 60 == 0L) { "feature bar must be minute aligned" }
  require(bar.sourcePartition >= 0 && bar.sourceOffset >= 0) { "invalid feature source coordinates" }
  require(bar.ingestionTime.plusMillis(FEATURE_MAX_CLOCK_SKEW_MS) >= bar.eventTime.plusSeconds(60)) {
    "feature bar arrived before its window closed"
  }
  require(computedAtMs + FEATURE_MAX_CLOCK_SKEW_MS >= bar.eventTime.plusSeconds(60).toEpochMilli()) {
    "feature computation precedes the completed window"
  }
  require(
    bar.ingestionTime.toEpochMilli() <= computedAtMs + FEATURE_MAX_CLOCK_SKEW_MS,
  ) { "feature computation precedes input availability" }
  require(
    listOf(bar.open, bar.high, bar.low, bar.close).all { it.isFinite() && it > 0 && featureMicros(it) > 0 },
  ) { "invalid feature price" }
  require(bar.low <= minOf(bar.open, bar.close) && bar.high >= maxOf(bar.open, bar.close) && bar.high >= bar.low) {
    "inconsistent feature range"
  }
  require(bar.volume.isFinite() && bar.volume >= 0) { "invalid feature volume" }
  val sessionDate =
    bar.eventTime
      .atZone(featureZone)
      .toLocalDate()
      .toString()
  if (sessionDate < previous.sessionDate) return RollingFeatureTransition(previous, null)
  val current = if (sessionDate == previous.sessionDate) previous else RollingFeatureState(sessionDate)
  require(current.bars.all { rollingFeatureKey(it) == rollingFeatureKey(bar) }) { "mixed feature identity" }
  val duplicate =
    current.bars.find {
      it.sourceTopic == bar.sourceTopic && it.sourcePartition == bar.sourcePartition &&
        it.sourceOffset == bar.sourceOffset
    }
  if (duplicate != null) {
    require(featureBarContentHash(duplicate) == featureBarContentHash(bar)) { "conflicting immutable feature input" }
    return RollingFeatureTransition(current, null)
  }
  val existing = current.bars.find { it.eventTime == bar.eventTime }
  if (existing != null && compareFeatureBarRevision(bar, existing) <= 0) return RollingFeatureTransition(current, null)
  val bars = (current.bars.filter { it.eventTime != bar.eventTime } + bar).sortedBy { it.eventTime }.takeLast(FEATURE_LOOKBACK_MINUTES)
  val state = RollingFeatureState(sessionDate, bars, current.lastFeatureId)
  if (bars.size != FEATURE_LOOKBACK_MINUTES) return RollingFeatureTransition(state, null)
  val start = bars.first().eventTime.toEpochMilli()
  if (bars.withIndex().any { (index, value) ->
      value.eventTime.toEpochMilli() != start + index * MINUTE_MS
    }
  ) {
    return RollingFeatureTransition(state, null)
  }
  val material =
    RollingMarketFeatureMaterial(
      provider = bar.provider,
      feed = bar.feed,
      delayClass = bar.delayClass,
      universeId = bar.universeId,
      universeSymbolHash = bar.universeSymbolHash,
      symbol = bar.symbol,
      sessionDate = sessionDate,
      windowStartMs = start,
      windowEndMs = start + FEATURE_LOOKBACK_MINUTES * MINUTE_MS,
      inputs =
        bars.map { value ->
          MarketFeatureInput(
            featureNanos(value.eventTime),
            featureNanos(value.ingestionTime),
            value.sourceTopic,
            value.sourcePartition,
            value.sourceOffset.toString(),
            featureBarContentHash(value),
          )
        },
      values =
        RollingMarketValues(
          featureMicros(bars.first().open).toString(),
          featureMicros(bars.maxOf { it.high }).toString(),
          featureMicros(bars.minOf { it.low }).toString(),
          featureMicros(bars.last().close).toString(),
          bars.fold(java.math.BigInteger.ZERO) { sum, value -> sum + featureMicros(value.volume).toBigInteger() }.toString(),
        ),
    )
  val json = Json { encodeDefaults = true }
  val id = featureHash(json.encodeToJsonElement(RollingMarketFeatureMaterial.serializer(), material))
  if (id == current.lastFeatureId) return RollingFeatureTransition(state, null)
  return RollingFeatureTransition(state.copy(lastFeatureId = id), RollingMarketFeature(material, id, computedAtMs, producerRevision))
}

internal fun processRollingFeature(
  previous: RollingFeatureState,
  bar: IntradayBarRecord,
  computedAtMs: Long,
  producerRevision: String,
): RollingFeatureTransition =
  try {
    advanceRollingFeature(previous, bar, computedAtMs, producerRevision)
  } catch (error: IllegalArgumentException) {
    RollingFeatureTransition(previous, null, error.message ?: "invalid feature input")
  }
