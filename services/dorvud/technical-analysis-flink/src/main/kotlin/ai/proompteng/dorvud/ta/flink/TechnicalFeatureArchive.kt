package ai.proompteng.dorvud.ta.flink

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId

internal fun decodeArchivedTechnicalFeature(
  record: ArchiveKafkaRecord,
  routes: Map<String, ArchiveRoute>,
  archivedAtMs: Long,
): ArchivedMarketFeature {
  val json = Json { encodeDefaults = true }
  val document = json.parseToJsonElement(record.value)
  require(document is JsonObject) { "technical feature must be an object" }
  val supplied = document["material"]
  require(supplied is JsonObject && listOf("schemaVersion", "definitionId", "definitionHash", "sessionPolicy").all { it in supplied }) {
    "technical contract fields must be explicit"
  }
  val feature = json.decodeFromJsonElement(TechnicalMarketFeature.serializer(), document)
  val material = feature.material
  require(
    material.schemaVersion == TECHNICAL_FEATURE_SCHEMA && material.definitionId == TECHNICAL_FEATURE_DEFINITION &&
      material.definitionHash == technicalFeatureDefinitionHash(),
  ) { "unknown technical contract" }
  require(feature.featureId == featureHash(json.encodeToJsonElement(TechnicalMarketFeatureMaterial.serializer(), material))) {
    "technical content hash mismatch"
  }
  require(
    material.provider == "alpaca" && material.feed == "iex" && material.delayClass == "real_time_exchange_only" &&
      material.sessionPolicy == FEATURE_SESSION_POLICY && feature.producerRevision.isNotBlank(),
  ) { "unsupported technical identity" }
  require(record.partition >= 0 && record.offset >= 0) { "invalid technical transport" }
  require(
    material.windowStartMs in 0..253_402_300_799_999L && material.windowStartMs % 60_000 == 0L &&
      material.windowEndMs > material.windowStartMs && material.windowEndMs <= material.windowStartMs + 390 * 60_000 &&
      material.windowEndMs % 60_000 == 0L && material.inputs.size in 1..390,
  ) { "invalid technical window" }
  val start = Instant.ofEpochMilli(material.windowStartMs).atZone(ZoneId.of("America/New_York"))
  require(start.toLocalTime() == LocalTime.of(9, 30) && start.toLocalDate().toString() == material.sessionDate) {
    "technical session mismatch"
  }
  require(
    feature.computedAtMs in (material.windowEndMs - FEATURE_MAX_CLOCK_SKEW_MS)..253_402_300_799_999L &&
      feature.computedAtMs <= archivedAtMs + FEATURE_MAX_CLOCK_SKEW_MS,
  ) { "invalid technical availability" }
  var previous = (material.windowStartMs - 60_000).toBigInteger() * 1_000_000L.toBigInteger()
  val latestIngestion =
    (feature.computedAtMs + FEATURE_MAX_CLOCK_SKEW_MS).toBigInteger() * 1_000_000L.toBigInteger() + 999_999L.toBigInteger()
  val coordinates = mutableSetOf<String>()
  val topics = mutableSetOf<String>()
  for (input in material.inputs) {
    require(
      listOf(input.eventTimeNanos, input.ingestionTimeNanos, input.sourceOffset).all {
        it.matches(Regex("0|[1-9][0-9]*"))
      },
    ) { "invalid technical input integer" }
    val time = input.eventTimeNanos.toBigInteger()
    val ingestion = input.ingestionTimeNanos.toBigInteger()
    require(
      time > previous && time >= material.windowStartMs.toBigInteger() * 1_000_000L.toBigInteger() &&
        time < material.windowEndMs.toBigInteger() * 1_000_000L.toBigInteger() &&
        time % 60_000_000_000L.toBigInteger() == java.math.BigInteger.ZERO,
    ) {
      "technical inputs must be canonical session minutes"
    }
    require(
      ingestion + FEATURE_MAX_CLOCK_SKEW_MS.toBigInteger() * 1_000_000L.toBigInteger() >= time + 60_000_000_000L.toBigInteger() &&
        ingestion <= latestIngestion,
    ) {
      "technical computation precedes input"
    }
    require(
      input.sourcePartition >= 0 && input.sourceOffset.toLongOrNull()?.let { it >= 0 } == true &&
        input.contentHash.matches(Regex("[0-9a-f]{64}")) &&
        coordinates.add("${input.sourceTopic}:${input.sourcePartition}:${input.sourceOffset}"),
    ) {
      "invalid technical provenance"
    }
    val route = requireNotNull(routes[input.sourceTopic]) { "unknown technical input topic" }
    require(
      route.kind == ArchiveRecordKind.Bar && route.feed == material.feed && route.universe.id == material.universeId &&
        route.universe.symbolHash == material.universeSymbolHash && material.symbol in route.universe.symbols,
    ) { "technical universe mismatch" }
    topics.add(input.sourceTopic)
    previous = time
  }
  require(topics.size == 1 && previous == (material.windowEndMs - 60_000).toBigInteger() * 1_000_000L.toBigInteger()) {
    "technical input window is incomplete or mixed"
  }
  val times =
    material.inputs.map {
      it.eventTimeNanos
        .toBigInteger()
        .divide(1_000_000L.toBigInteger())
        .toLong()
    }
  val complete = times.first() == material.windowStartMs && times.zipWithNext().all { (a, b) -> b - a == 60_000L }
  val recursiveHorizons =
    mapOf(
      "ema12PriceMicros" to 12,
      "ema26PriceMicros" to 26,
      "macdPriceMicros" to 34,
      "macdSignalPriceMicros" to 34,
      "macdHistogramPriceMicros" to 34,
      "rsi14Micros" to 15,
      "weightedCloseSessionPriceMicros" to 1,
      "vwapSessionPriceMicros" to 1,
    )
  val rollingHorizons =
    mapOf(
      "bollingerMiddlePriceMicros" to 20,
      "bollingerUpperPriceMicros" to 20,
      "bollingerLowerPriceMicros" to 20,
      "weightedClose5mPriceMicros" to 5,
      "vwap5mPriceMicros" to 5,
      "realizedVolatility60ReturnsPpm" to 61,
    )
  val values = json.encodeToJsonElement(TechnicalMarketValues.serializer(), material.values) as JsonObject
  for ((name, encoded) in values) {
    val value = json.decodeFromJsonElement(TechnicalFeatureValue.serializer(), encoded)
    require((value.status == TechnicalReadiness.READY) == (value.value != null)) { "technical readiness disagrees with value" }
    val recursive = recursiveHorizons[name]
    val horizon = recursive ?: rollingHorizons.getValue(name)
    val expected =
      when {
        recursive != null && !complete -> TechnicalReadiness.GAP
        times.size < horizon -> TechnicalReadiness.WARMING
        times.takeLast(horizon).zipWithNext().any { (a, b) -> b - a != 60_000L } -> TechnicalReadiness.GAP
        else -> TechnicalReadiness.READY
      }
    val weighted = name.startsWith("weightedClose") || name.startsWith("vwap")
    require(
      value.status == expected || (
        expected == TechnicalReadiness.READY && weighted &&
          (value.status == TechnicalReadiness.ZERO_VOLUME || (name.startsWith("vwap") && value.status == TechnicalReadiness.SOURCE_MISSING))
      ),
    ) {
      "technical readiness disagrees with input coverage"
    }
    value.value?.let { number ->
      require(
        number.matches(Regex("0|-?[1-9][0-9]*")) &&
          number.toLongOrNull()?.let { it in -9_007_199_254_740_991L..9_007_199_254_740_991L } == true,
      ) {
        "invalid technical value"
      }
      val signed = name in setOf("macdPriceMicros", "macdSignalPriceMicros", "macdHistogramPriceMicros", "bollingerLowerPriceMicros")
      require(signed || number.toLong() >= 0) { "negative unsigned technical value" }
      require(name != "rsi14Micros" || number.toLong() <= 100_000_000) { "RSI outside percentage range" }
    }
  }
  return ArchivedMarketFeature(
    feature.featureId,
    material.universeId,
    material.universeSymbolHash,
    material.feed,
    material.symbol,
    material.windowEndMs,
    feature.computedAtMs,
    archivedAtMs,
    record.topic,
    record.partition,
    record.offset,
    record.value,
  )
}
