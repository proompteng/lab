package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import java.time.DateTimeException
import java.time.Duration
import java.time.LocalTime
import java.time.ZoneId
import kotlin.math.abs
import kotlin.math.floor

internal const val TECHNICAL_FEATURE_DEFINITION = "dorvud.technical-indicators-1m.v1"
internal const val TECHNICAL_FEATURE_SCHEMA = "dorvud.technical-feature.v1"
private val technicalZone = ZoneId.of("America/New_York")
private val technicalInterval = Duration.ofMinutes(1)

@Serializable
enum class TechnicalReadiness { READY, WARMING, GAP, SOURCE_MISSING, ZERO_VOLUME }

@Serializable
data class TechnicalFeatureValue(
  val status: TechnicalReadiness,
  val value: String? = null,
)

@Serializable
data class TechnicalMarketValues(
  val ema12PriceMicros: TechnicalFeatureValue,
  val ema26PriceMicros: TechnicalFeatureValue,
  val macdPriceMicros: TechnicalFeatureValue,
  val macdSignalPriceMicros: TechnicalFeatureValue,
  val macdHistogramPriceMicros: TechnicalFeatureValue,
  val rsi14Micros: TechnicalFeatureValue,
  val bollingerMiddlePriceMicros: TechnicalFeatureValue,
  val bollingerUpperPriceMicros: TechnicalFeatureValue,
  val bollingerLowerPriceMicros: TechnicalFeatureValue,
  val weightedClose5mPriceMicros: TechnicalFeatureValue,
  val weightedCloseSessionPriceMicros: TechnicalFeatureValue,
  val vwap5mPriceMicros: TechnicalFeatureValue,
  val vwapSessionPriceMicros: TechnicalFeatureValue,
  val realizedVolatility60ReturnsPpm: TechnicalFeatureValue,
)

@Serializable
data class TechnicalMarketFeatureMaterial(
  val schemaVersion: String = TECHNICAL_FEATURE_SCHEMA,
  val definitionId: String = TECHNICAL_FEATURE_DEFINITION,
  val definitionHash: String = technicalFeatureDefinitionHash(),
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
  val values: TechnicalMarketValues,
)

@Serializable
data class TechnicalMarketFeature(
  val material: TechnicalMarketFeatureMaterial,
  val featureId: String,
  val computedAtMs: Long,
  val producerRevision: String,
)

data class TechnicalFeatureState(
  val sessionDate: String = "",
  val bars: List<IntradayBarRecord> = emptyList(),
  val lastFeatureId: String? = null,
) : java.io.Serializable

data class TechnicalFeatureTransition(
  val state: TechnicalFeatureState,
  val feature: TechnicalMarketFeature?,
  val rejection: String? = null,
)

internal fun technicalFeatureDefinitionHash(): String =
  featureHash(
    JsonArray(
      listOf(
        TECHNICAL_FEATURE_DEFINITION,
        FEATURE_SESSION_POLICY,
        "PT1M;session:09:30-16:00;canonical-session-recompute;no-synthetic-bars",
        "EMA:12,26;alpha:2/(n+1);seed:first-close;ready:12,26",
        "MACD:EMA12-EMA26;signal:9;seed:zero;ready:34",
        "RSI:14;gain-loss-alpha:1/14;seed:zero;ready:15;flat:0",
        "Bollinger:20;population-standard-deviation;2-sigma",
        "weighted-close:5m,session;source-VWAP:5m,session;zero-volume:unavailable",
        "volatility:60-log-returns;population-standard-deviation;not-annualized",
        "recursive-and-session:complete-from-open;rolling:contiguous-tail",
        "binary64-times-1000000-round-half-positive-infinity;safe-signed-integer-string",
        "RSI:percentage-point-micros;volatility:ratio-ppm;prices:micros",
        "bar-winner:ingestion-nanos,partition,offset;raw-content:binary64-hex-v1",
        "cross-host-clock-skew-ms:$FEATURE_MAX_CLOCK_SKEW_MS",
      ).map(::JsonPrimitive),
    ),
  )

internal fun technicalMicros(value: Double): String {
  require(value.isFinite()) { "technical value must be finite" }
  val scaled = value * 1_000_000
  val integral = floor(scaled)
  val rounded = if (scaled - integral >= 0.5) integral + 1 else integral
  require(abs(rounded) <= 9_007_199_254_740_991.0) { "technical value exceeds exact integer range" }
  return rounded.toLong().toString()
}

private fun technicalValues(
  bars: List<IntradayBarRecord>,
  sessionOpenMs: Long,
): TechnicalMarketValues {
  val payloads = bars.map { MicroBarPayload(it.open, it.high, it.low, it.close, it.volume, it.vwap, it.tradeCount ?: 0, it.eventTime) }
  val state = payloads.fold(IndicatorAccumulator()) { state, bar -> advanceIndicators(state, bar, technicalInterval, 61) }
  val complete = bars.first().eventTime.toEpochMilli() == sessionOpenMs && state.contiguous

  fun value(
    status: TechnicalReadiness,
    number: Double?,
  ): TechnicalFeatureValue =
    TechnicalFeatureValue(status, if (status == TechnicalReadiness.READY) technicalMicros(requireNotNull(number)) else null)

  fun recursive(
    count: Int,
    number: Double?,
  ): TechnicalFeatureValue =
    value(
      when {
        !complete -> TechnicalReadiness.GAP
        bars.size < count -> TechnicalReadiness.WARMING
        else -> TechnicalReadiness.READY
      },
      number,
    )

  fun tailStatus(count: Int): TechnicalReadiness =
    when {
      bars.size < count -> TechnicalReadiness.WARMING
      contiguousIndicatorTail(payloads, count, technicalInterval) == null -> TechnicalReadiness.GAP
      else -> TechnicalReadiness.READY
    }

  fun weighted(
    session: Boolean,
    sourceVwap: Boolean,
  ): TechnicalFeatureValue {
    val status =
      if (session) {
        if (complete) TechnicalReadiness.READY else TechnicalReadiness.GAP
      } else {
        tailStatus(5)
      }
    if (status != TechnicalReadiness.READY) return value(status, null)
    val selected = if (session) payloads else payloads.takeLast(5)
    if (selected.sumOf { it.v } == 0.0) return value(TechnicalReadiness.ZERO_VOLUME, null)
    if (sourceVwap && selected.any { it.v > 0 && it.vwap == null }) return value(TechnicalReadiness.SOURCE_MISSING, null)
    return value(TechnicalReadiness.READY, indicatorWeightedPrice(selected, sourceVwap))
  }
  val macd = state.ema12 - state.ema26
  val bands = indicatorBollinger(state, technicalInterval)
  val bandsStatus = tailStatus(20)
  return TechnicalMarketValues(
    recursive(12, state.ema12),
    recursive(26, state.ema26),
    recursive(34, macd),
    recursive(34, state.macdSignal),
    recursive(34, macd - state.macdSignal),
    recursive(15, indicatorRsi(state)),
    value(bandsStatus, bands?.mid),
    value(bandsStatus, bands?.upper),
    value(bandsStatus, bands?.lower),
    weighted(false, false),
    weighted(true, false),
    weighted(false, true),
    weighted(true, true),
    value(tailStatus(61), indicatorVolatility(state, 60, technicalInterval)),
  )
}

internal fun advanceTechnicalFeature(
  previous: TechnicalFeatureState,
  bar: IntradayBarRecord,
  computedAtMs: Long,
  producerRevision: String,
): TechnicalFeatureTransition {
  validateMarketFeatureBar(bar, computedAtMs)
  val local = bar.eventTime.atZone(technicalZone)
  require(local.toLocalTime() >= LocalTime.of(9, 30) && local.toLocalTime() < LocalTime.of(16, 0)) { "outside technical session" }
  val session = local.toLocalDate().toString()
  if (session < previous.sessionDate) return TechnicalFeatureTransition(previous, null)
  val current = if (session == previous.sessionDate) previous else TechnicalFeatureState(session)
  require(current.bars.all { rollingFeatureKey(it) == rollingFeatureKey(bar) && it.sourceTopic == bar.sourceTopic }) {
    "mixed technical feature identity"
  }
  val duplicate =
    current.bars.find {
      it.sourceTopic == bar.sourceTopic && it.sourcePartition == bar.sourcePartition && it.sourceOffset == bar.sourceOffset
    }
  if (duplicate != null) {
    require(featureBarContentHash(duplicate) == featureBarContentHash(bar)) { "conflicting immutable technical input" }
    return TechnicalFeatureTransition(current, null)
  }
  val existing = current.bars.find { it.eventTime == bar.eventTime }
  if (existing != null && compareFeatureBarRevision(bar, existing) <= 0) return TechnicalFeatureTransition(current, null)
  val bars = (current.bars.filter { it.eventTime != bar.eventTime } + bar).sortedBy { it.eventTime }
  require(bars.all { it.ingestionTime.toEpochMilli() <= Math.addExact(computedAtMs, FEATURE_MAX_CLOCK_SKEW_MS) }) {
    "technical computation precedes retained input availability"
  }
  require(bars.size <= 390) { "technical session exceeds bounded history" }
  val open =
    local
      .toLocalDate()
      .atTime(9, 30)
      .atZone(technicalZone)
      .toInstant()
      .toEpochMilli()
  val material =
    TechnicalMarketFeatureMaterial(
      provider = bar.provider,
      feed = bar.feed,
      delayClass = bar.delayClass,
      universeId = bar.universeId,
      universeSymbolHash = bar.universeSymbolHash,
      symbol = bar.symbol,
      sessionDate = session,
      windowStartMs = open,
      windowEndMs =
        bars
          .last()
          .eventTime
          .plusSeconds(60)
          .toEpochMilli(),
      inputs =
        bars.map {
          MarketFeatureInput(
            featureNanos(it.eventTime),
            featureNanos(it.ingestionTime),
            it.sourceTopic,
            it.sourcePartition,
            it.sourceOffset.toString(),
            featureBarContentHash(it),
          )
        },
      values = technicalValues(bars, open),
    )
  val id = featureHash(Json { encodeDefaults = true }.encodeToJsonElement(TechnicalMarketFeatureMaterial.serializer(), material))
  val state = TechnicalFeatureState(session, bars, id)
  return TechnicalFeatureTransition(
    state,
    if (id ==
      current.lastFeatureId
    ) {
      null
    } else {
      TechnicalMarketFeature(material, id, computedAtMs, producerRevision)
    },
  )
}

internal fun processTechnicalFeature(
  previous: TechnicalFeatureState,
  bar: IntradayBarRecord,
  computedAtMs: Long,
  producerRevision: String,
): TechnicalFeatureTransition =
  try {
    advanceTechnicalFeature(previous, bar, computedAtMs, producerRevision)
  } catch (cause: IllegalArgumentException) {
    TechnicalFeatureTransition(previous, null, cause.message ?: "invalid technical feature input")
  } catch (cause: DateTimeException) {
    TechnicalFeatureTransition(previous, null, cause.message ?: "invalid technical timestamp")
  } catch (cause: ArithmeticException) {
    TechnicalFeatureTransition(previous, null, cause.message ?: "technical timestamp overflow")
  }
