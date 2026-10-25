package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.CRYPTO_DELAY_CLASS
import ai.proompteng.dorvud.platform.CRYPTO_SESSION
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.math.BigDecimal
import java.time.Duration
import java.time.Instant

internal const val CRYPTO_FEATURE_SCHEMA = "dorvud.crypto-market-feature.v2"
internal const val CRYPTO_FEATURE_DEFINITION = "dorvud.crypto-continuous-1m.v2"
internal const val CRYPTO_FEATURE_HISTORY = 61
private val cryptoInterval = Duration.ofMinutes(1)
internal val cryptoFeatureJson = Json { encodeDefaults = true }
internal val cryptoEmptyHistoryHash = featureHash(JsonArray(emptyList()))

@Serializable
data class CryptoRollingValues(
  val referencePrice: String,
  val rangeHighPrice: String,
  val rangeLowPrice: String,
  val lastClosePrice: String,
  val totalVolume: String,
)

@Serializable
data class CryptoTechnicalValues(
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
  val weightedClose30mPriceMicros: TechnicalFeatureValue,
  val vwap5mPriceMicros: TechnicalFeatureValue,
  val vwap30mPriceMicros: TechnicalFeatureValue,
  val realizedVolatility60ReturnsPpm: TechnicalFeatureValue,
)

@Serializable
data class CryptoMarketFeatureMaterial(
  val schemaVersion: String,
  val definitionId: String,
  val definitionHash: String,
  val provider: String,
  val location: String,
  val marketSession: String,
  val delayClass: String,
  val symbol: String,
  val windowStartMs: Long,
  val windowEndMs: Long,
  val historyPrefixHash: String,
  val historyHash: String,
  val inputs: List<MarketFeatureInput>,
  val priceWindow: CryptoRollingValues,
  val technical: CryptoTechnicalValues,
)

@Serializable
data class CryptoMarketFeature(
  val material: CryptoMarketFeatureMaterial,
  val featureId: String,
  val computedAtMs: Long,
  val producerRevision: String,
)

internal data class CryptoFeatureBar(
  val location: String,
  val symbol: String,
  val eventTime: Instant,
  val ingestionTime: Instant,
  val sourceTopic: String,
  val sourcePartition: Int,
  val sourceOffset: Long,
  val open: String,
  val high: String,
  val low: String,
  val close: String,
  val volume: String,
  val vwap: String?,
  val contentHash: String,
) : java.io.Serializable

internal data class CryptoIndicatorSeed(
  val values: IndicatorAccumulator = IndicatorAccumulator(),
  val warmup: TechnicalReadiness = TechnicalReadiness.WARMING,
) : java.io.Serializable

internal data class CryptoFeatureState(
  val bars: List<CryptoFeatureBar> = emptyList(),
  val seed: CryptoIndicatorSeed = CryptoIndicatorSeed(),
  val historyPrefixHash: String = cryptoEmptyHistoryHash,
  val lastFeatureId: String? = null,
) : java.io.Serializable

internal data class CryptoFeatureTransition(
  val state: CryptoFeatureState,
  val feature: CryptoMarketFeature? = null,
)

internal fun cryptoFeatureDefinitionHash(): String =
  featureHash(
    JsonArray(
      listOf(
        CRYPTO_FEATURE_DEFINITION,
        "continuous;PT1M;no-calendar-reset;no-synthetic-bars",
        "canonical-correction-history:61-bars;older-corrections:reject",
        "EMA:12,26;alpha:2/(n+1);seed:first-observed-close;ready:12,26",
        "MACD:EMA12-EMA26;signal:9;seed:zero;ready:34",
        "RSI:14;gain-loss-alpha:1/14;seed:zero;ready:15;flat:0",
        "Bollinger:20;population-standard-deviation;2-sigma",
        "weighted-close-and-source-VWAP:5m,30m;zero-volume:unavailable",
        "volatility:60-log-returns;population-standard-deviation;not-annualized",
        "gap:reset-recursive-indicator-seed-and-warmup;price-window:observed-minutes",
        "rolling-OHLC-volume:PT30M-maximum-context;gaps-unfilled;exact-decimal-strings",
        "technical:binary64;price-micros;RSI-percentage-point-micros;volatility-ratio-ppm",
        "bar-winner:ingestion-nanos,partition,offset;raw-content:native-json-v1",
        "history:sha256-chain-of-canonical-source-inputs;cross-host-clock-skew-ms:$FEATURE_MAX_CLOCK_SKEW_MS",
      ).map(::JsonPrimitive),
    ),
  )

internal fun decodeCryptoFeatureBar(
  record: ArchiveKafkaRecord,
  source: CryptoArchiveConfig,
): CryptoFeatureBar? {
  val raw = decodeArchivedCryptoMarketData(record, source)
  if (raw.channel !in setOf("bars", "updatedBars")) return null
  val payload = Json.parseToJsonElement(raw.payload).jsonObject

  fun decimal(field: String): String =
    payload
      .getValue(field)
      .jsonPrimitive.content
      .toBigDecimal()
      .stripTrailingZeros()
      .toPlainString()
  val eventTime = Instant.parse(raw.eventTs)
  val ingestionTime = Instant.parse(raw.ingestTs)
  require(eventTime.nano == 0 && eventTime.epochSecond % 60 == 0L) { "crypto feature bar must be minute aligned" }
  require(ingestionTime.plusMillis(FEATURE_MAX_CLOCK_SKEW_MS) >= eventTime.plusSeconds(60)) {
    "crypto feature bar arrived before its minute closed"
  }
  return CryptoFeatureBar(
    raw.location,
    raw.symbol,
    eventTime,
    ingestionTime,
    record.topic,
    record.partition,
    record.offset,
    decimal("o"),
    decimal("h"),
    decimal("l"),
    decimal("c"),
    decimal("v"),
    payload["vw"]
      ?.jsonPrimitive
      ?.content
      ?.toBigDecimal()
      ?.takeIf { it.signum() > 0 }
      ?.stripTrailingZeros()
      ?.toPlainString(),
    featureHash(
      JsonArray(
        listOf(
          JsonPrimitive("alpaca"),
          JsonPrimitive(raw.location),
          JsonPrimitive(raw.symbol),
          JsonPrimitive(raw.channel),
          JsonPrimitive(featureNanos(eventTime)),
          JsonPrimitive(featureNanos(ingestionTime)),
          payload,
        ),
      ),
    ),
  ).also { cryptoIndicatorBar(it) }
}

internal fun cryptoFeatureInput(bar: CryptoFeatureBar): MarketFeatureInput =
  MarketFeatureInput(
    featureNanos(bar.eventTime),
    featureNanos(bar.ingestionTime),
    bar.sourceTopic,
    bar.sourcePartition,
    bar.sourceOffset.toString(),
    bar.contentHash,
  )

internal fun cryptoHistoryHash(
  prefix: String,
  inputs: List<MarketFeatureInput>,
): String =
  inputs.fold(prefix) { hash, input ->
    featureHash(JsonArray(listOf(JsonPrimitive(hash), cryptoFeatureJson.encodeToJsonElement(MarketFeatureInput.serializer(), input))))
  }

private fun cryptoIndicatorBar(bar: CryptoFeatureBar): MicroBarPayload {
  fun value(raw: String): Double =
    raw.toDouble().also {
      require(it.isFinite() && (raw.toBigDecimal().signum() == 0 || it > 0)) { "crypto indicator input exceeds binary64 range" }
    }
  return MicroBarPayload(
    value(bar.open),
    value(bar.high),
    value(bar.low),
    value(bar.close),
    value(bar.volume),
    bar.vwap?.let(::value),
    0,
    bar.eventTime,
  )
}

private fun advanceCryptoSeed(
  previous: CryptoIndicatorSeed,
  bar: CryptoFeatureBar,
): CryptoIndicatorSeed {
  val last = previous.values.recent.lastOrNull()
  val seed =
    if (last != null && last.t.plus(cryptoInterval) != bar.eventTime) {
      CryptoIndicatorSeed(warmup = TechnicalReadiness.GAP)
    } else {
      previous
    }
  return seed.copy(
    values =
      advanceIndicators(seed.values, cryptoIndicatorBar(bar), cryptoInterval, CRYPTO_FEATURE_HISTORY)
        .copy(volume = 0.0, closeVolume = 0.0, vwapVolume = 0.0),
  )
}

private fun cryptoTailStatus(
  bars: List<CryptoFeatureBar>,
  count: Int,
): TechnicalReadiness =
  when {
    bars.size < count -> TechnicalReadiness.WARMING
    bars.takeLast(count).zipWithNext().any { (a, b) -> a.eventTime.plus(cryptoInterval) != b.eventTime } -> TechnicalReadiness.GAP
    else -> TechnicalReadiness.READY
  }

private fun cryptoRollingValues(bars: List<CryptoFeatureBar>): CryptoRollingValues {
  val end = bars.last().eventTime.plusSeconds(60)
  val window = bars.filter { it.eventTime >= end.minusSeconds(30 * 60) }
  return CryptoRollingValues(
    window.first().open,
    window.maxOf { it.high.toBigDecimal() }.stripTrailingZeros().toPlainString(),
    window.minOf { it.low.toBigDecimal() }.stripTrailingZeros().toPlainString(),
    window.last().close,
    window.fold(BigDecimal.ZERO) { total, bar -> total + bar.volume.toBigDecimal() }.stripTrailingZeros().toPlainString(),
  )
}

private fun cryptoTechnicalValues(
  bars: List<CryptoFeatureBar>,
  seed: CryptoIndicatorSeed,
): CryptoTechnicalValues {
  val current = bars.fold(seed, ::advanceCryptoSeed)
  val state = current.values

  fun value(
    status: TechnicalReadiness,
    number: Double?,
  ): TechnicalFeatureValue =
    TechnicalFeatureValue(status, if (status == TechnicalReadiness.READY) technicalMicros(requireNotNull(number)) else null)

  fun recursive(
    count: Int,
    number: Double?,
  ): TechnicalFeatureValue = value(if (state.count < count) current.warmup else TechnicalReadiness.READY, number)

  fun weighted(
    count: Int,
    sourceVwap: Boolean,
  ): TechnicalFeatureValue {
    val status = cryptoTailStatus(bars, count)
    if (status != TechnicalReadiness.READY) return value(status, null)
    val selected = bars.takeLast(count).map(::cryptoIndicatorBar)
    if (selected.sumOf { it.v } == 0.0) return value(TechnicalReadiness.ZERO_VOLUME, null)
    if (sourceVwap && selected.any { it.v > 0 && it.vwap == null }) return value(TechnicalReadiness.SOURCE_MISSING, null)
    return value(TechnicalReadiness.READY, indicatorWeightedPrice(selected, sourceVwap))
  }
  val macd = state.ema12 - state.ema26
  val bands = indicatorBollinger(state, cryptoInterval)
  val bandsStatus = cryptoTailStatus(bars, 20)
  return CryptoTechnicalValues(
    recursive(12, state.ema12),
    recursive(26, state.ema26),
    recursive(34, macd),
    recursive(34, state.macdSignal),
    recursive(34, macd - state.macdSignal),
    recursive(15, indicatorRsi(state)),
    value(bandsStatus, bands?.mid),
    value(bandsStatus, bands?.upper),
    value(bandsStatus, bands?.lower),
    weighted(5, false),
    weighted(30, false),
    weighted(5, true),
    weighted(30, true),
    value(cryptoTailStatus(bars, 61), indicatorVolatility(state, 60, cryptoInterval)),
  )
}

internal fun advanceCryptoFeature(
  previous: CryptoFeatureState,
  bar: CryptoFeatureBar,
  computedAtMs: Long,
  producerRevision: String,
): CryptoFeatureTransition {
  val availableAt = Math.addExact(computedAtMs, FEATURE_MAX_CLOCK_SKEW_MS)
  require(availableAt >= bar.ingestionTime.toEpochMilli()) {
    "crypto feature computation precedes input availability"
  }
  require(availableAt >= bar.eventTime.plusSeconds(60).toEpochMilli()) { "crypto feature computation precedes the completed minute" }
  require(previous.bars.all { it.location == bar.location && it.symbol == bar.symbol && it.sourceTopic == bar.sourceTopic }) {
    "mixed crypto feature identity"
  }
  previous.bars.find { it.sourcePartition == bar.sourcePartition && it.sourceOffset == bar.sourceOffset }?.let {
    require(it.contentHash == bar.contentHash) { "conflicting immutable crypto input" }
    return CryptoFeatureTransition(previous)
  }
  val prefixEnd =
    previous.seed.values.recent
      .lastOrNull()
      ?.t
  require(prefixEnd == null || bar.eventTime > prefixEnd) { "crypto correction is older than retained feature history" }
  val existing = previous.bars.find { it.eventTime == bar.eventTime }
  if (existing != null &&
    compareValuesBy(bar, existing, { it.ingestionTime }, { it.sourcePartition }, { it.sourceOffset }) <= 0
  ) {
    return CryptoFeatureTransition(previous)
  }
  val canonical = (previous.bars.filter { it.eventTime != bar.eventTime } + bar).sortedBy { it.eventTime }
  val evicted = canonical.dropLast(CRYPTO_FEATURE_HISTORY)
  val seed = evicted.fold(previous.seed, ::advanceCryptoSeed)
  val prefix = cryptoHistoryHash(previous.historyPrefixHash, evicted.map(::cryptoFeatureInput))
  val bars = canonical.takeLast(CRYPTO_FEATURE_HISTORY)
  val inputs = bars.map(::cryptoFeatureInput)
  val material =
    CryptoMarketFeatureMaterial(
      CRYPTO_FEATURE_SCHEMA,
      CRYPTO_FEATURE_DEFINITION,
      cryptoFeatureDefinitionHash(),
      "alpaca",
      bar.location,
      CRYPTO_SESSION,
      CRYPTO_DELAY_CLASS,
      bar.symbol,
      bars.first().eventTime.toEpochMilli(),
      bars
        .last()
        .eventTime
        .plusSeconds(60)
        .toEpochMilli(),
      prefix,
      cryptoHistoryHash(prefix, inputs),
      inputs,
      cryptoRollingValues(bars),
      cryptoTechnicalValues(bars, seed),
    )
  val id = featureHash(cryptoFeatureJson.encodeToJsonElement(CryptoMarketFeatureMaterial.serializer(), material))
  val state = CryptoFeatureState(bars, seed, prefix, id)
  return CryptoFeatureTransition(
    state,
    if (id == previous.lastFeatureId) null else CryptoMarketFeature(material, id, computedAtMs, producerRevision),
  )
}
