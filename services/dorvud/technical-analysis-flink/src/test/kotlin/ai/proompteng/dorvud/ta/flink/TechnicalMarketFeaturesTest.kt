package ai.proompteng.dorvud.ta.flink

import kotlinx.serialization.json.Json
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class TechnicalMarketFeaturesTest {
  private val start = Instant.parse("2026-09-11T13:30:00Z")
  private val computed = start.plusSeconds(24 * 3600).toEpochMilli()

  private fun bar(
    index: Int,
    close: Double = 100.0,
  ) = IntradayBarRecord(
    provider = "alpaca",
    universeId = "test-equity-v1",
    universeSymbolHash = canonicalSymbolHash(listOf("AAPL")),
    feed = "iex",
    channel = "bars",
    marketSession = "regular",
    delayClass = "real_time_exchange_only",
    symbol = "AAPL",
    eventTime = start.plusSeconds(index * 60L),
    ingestionTime = start.plusSeconds((index + 1) * 60L + 1),
    sourceTopic = "torghut.bars.1m.v1",
    sourcePartition = 0,
    sourceOffset = index.toLong(),
    final = true,
    open = close,
    high = close + 1,
    low = close - 1,
    close = close,
    volume = 2.0,
    vwap = close - 0.5,
    tradeCount = 2,
    schemaVersion = 1,
  )

  private fun calculate(bars: List<IntradayBarRecord>): TechnicalFeatureTransition =
    bars.fold(
      TechnicalFeatureTransition(TechnicalFeatureState(), null),
    ) { state, bar -> advanceTechnicalFeature(state.state, bar, computed, "a".repeat(40)) }

  private fun ready(value: String) = TechnicalFeatureValue(TechnicalReadiness.READY, value)

  @Test fun `constant series has literal golden values and separate source VWAP`() {
    val feature = assertNotNull(calculate((0..60).map { bar(it) }).feature)
    assertEquals(
      TechnicalMarketValues(
        ready("100000000"),
        ready("100000000"),
        ready("0"),
        ready("0"),
        ready("0"),
        ready("0"),
        ready("100000000"),
        ready("100000000"),
        ready("100000000"),
        ready("100000000"),
        ready("100000000"),
        ready("99500000"),
        ready("99500000"),
        ready("0"),
      ),
      feature.material.values,
    )
    assertEquals(61, feature.material.inputs.size)
    assertEquals(start.toEpochMilli(), feature.material.windowStartMs)
    assertEquals(start.plusSeconds(61 * 60).toEpochMilli(), feature.material.windowEndMs)
    assertEquals(computed, feature.computedAtMs)
    val fixture = java.io.File("../../bayn/src/market-data/features/fixtures/technical-indicators-v1.json")
    val json =
      Json {
        encodeDefaults = true
        prettyPrint = true
      }
    if (System.getProperty("writeMarketFeatureFixture") ==
      "true"
    ) {
      fixture.writeText(json.encodeToString(TechnicalMarketFeature.serializer(), feature) + "\n")
    }
    assertEquals(Json.parseToJsonElement(fixture.readText()), json.encodeToJsonElement(TechnicalMarketFeature.serializer(), feature))
  }

  @Test fun `readiness follows declared horizons and never publishes warmup values`() {
    var state = TechnicalFeatureState()
    for (index in 0..60) {
      val transition = advanceTechnicalFeature(state, bar(index), computed, "a".repeat(40))
      state = transition.state
      val values = assertNotNull(transition.feature).material.values
      for ((minimum, value) in listOf(
        12 to values.ema12PriceMicros,
        26 to values.ema26PriceMicros,
        34 to values.macdPriceMicros,
        15 to values.rsi14Micros,
        20 to values.bollingerMiddlePriceMicros,
        5 to values.weightedClose5mPriceMicros,
        61 to values.realizedVolatility60ReturnsPpm,
      )) {
        assertEquals(if (index + 1 >= minimum) TechnicalReadiness.READY else TechnicalReadiness.WARMING, value.status)
        if (index + 1 < minimum) assertNull(value.value)
      }
    }
  }

  @Test fun `gap repair and early correction reproduce canonical full session state`() {
    val source = (0..120).map { bar(it, 100.0 + kotlin.math.sin(it.toDouble())) }
    val incomplete = calculate(source.filterIndexed { index, _ -> index != 3 })
    val values = assertNotNull(incomplete.feature).material.values
    assertEquals(TechnicalReadiness.GAP, values.ema12PriceMicros.status)
    assertEquals(TechnicalReadiness.GAP, values.vwapSessionPriceMicros.status)
    assertEquals(TechnicalReadiness.READY, values.bollingerMiddlePriceMicros.status)
    assertEquals(TechnicalReadiness.READY, values.realizedVolatility60ReturnsPpm.status)
    val repaired = advanceTechnicalFeature(incomplete.state, source[3], computed, "a".repeat(40))
    assertEquals(calculate(source), repaired)
    val correction = source[0].copy(close = 99.0, low = 99.0, sourceOffset = 999, ingestionTime = start.plusSeconds(121 * 60))
    val revised = advanceTechnicalFeature(repaired.state, correction, computed, "a".repeat(40))
    assertEquals(calculate(listOf(correction) + source.drop(1)), revised)
    assertNotEquals(repaired.feature?.featureId, revised.feature?.featureId)
    assertNotEquals(
      repaired.feature
        ?.material
        ?.values
        ?.ema26PriceMicros,
      revised.feature
        ?.material
        ?.values
        ?.ema26PriceMicros,
    )
  }

  @Test fun `missing VWAP and zero volume are distinct from numerical zero`() {
    val missing = assertNotNull(calculate((0..4).map { bar(it).copy(vwap = null) }).feature).material.values
    assertEquals(TechnicalReadiness.SOURCE_MISSING, missing.vwap5mPriceMicros.status)
    assertNull(missing.vwap5mPriceMicros.value)
    assertEquals(ready("100000000"), missing.weightedClose5mPriceMicros)
    val zero = assertNotNull(calculate((0..4).map { bar(it).copy(volume = 0.0, vwap = null) }).feature).material.values
    assertEquals(TechnicalReadiness.ZERO_VOLUME, zero.vwap5mPriceMicros.status)
    assertEquals(TechnicalReadiness.ZERO_VOLUME, zero.weightedCloseSessionPriceMicros.status)
  }

  @Test fun `archive validates definition provenance readiness and preserves exact payload`() {
    val feature = assertNotNull(calculate((0..60).map { bar(it) }).feature)
    val route =
      mapOf(
        "torghut.bars.1m.v1" to
          ArchiveRoute(
            "iex",
            ArchiveUniverse("test-equity-v1", canonicalSymbolHash(listOf("AAPL")), setOf("AAPL")),
          ),
      )
    val json = Json { encodeDefaults = true }

    fun record(value: TechnicalMarketFeature) =
      ArchiveKafkaRecord(
        "torghut.technical-features.v1",
        2,
        123,
        json.encodeToString(TechnicalMarketFeature.serializer(), value),
      )
    val source = record(feature)
    val archived = decodeArchivedTechnicalFeature(source, route, computed + 100)
    assertEquals(source.value, archived.payload)
    assertEquals(123, archived.sourceOffset)
    assertEquals(feature.featureId, archived.featureId)

    fun rehash(material: TechnicalMarketFeatureMaterial) =
      feature.copy(
        material = material,
        featureId = featureHash(json.encodeToJsonElement(TechnicalMarketFeatureMaterial.serializer(), material)),
      )
    val invalid =
      listOf(
        feature.copy(featureId = "f".repeat(64)),
        rehash(feature.material.copy(definitionHash = "f".repeat(64))),
        rehash(feature.material.copy(inputs = feature.material.inputs.reversed())),
        rehash(feature.material.copy(values = feature.material.values.copy(ema12PriceMicros = ready("-1")))),
        rehash(feature.material.copy(values = feature.material.values.copy(rsi14Micros = ready("100000001")))),
        rehash(
          feature.material.copy(
            values = feature.material.values.copy(ema12PriceMicros = TechnicalFeatureValue(TechnicalReadiness.WARMING)),
          ),
        ),
      )
    invalid.forEach { assertFailsWith<IllegalArgumentException> { decodeArchivedTechnicalFeature(record(it), route, computed + 100) } }
    assertFailsWith<IllegalArgumentException> { decodeArchivedTechnicalFeature(source, emptyMap(), computed + 100) }
    assertFailsWith<IllegalArgumentException> { decodeArchivedTechnicalFeature(source, route, computed - 5001) }
  }

  @Test fun `published recursive values match pinned TA4J through a full session`() {
    val series = org.ta4j.core.BaseBarSeries("published-reference")
    val close =
      org.ta4j.core.indicators.helpers
        .ClosePriceIndicator(series)
    val ema12 =
      org.ta4j.core.indicators
        .EMAIndicator(close, 12)
    val ema26 =
      org.ta4j.core.indicators
        .EMAIndicator(close, 26)
    val macd =
      org.ta4j.core.indicators
        .MACDIndicator(close, 12, 26)
    val signal =
      org.ta4j.core.indicators
        .EMAIndicator(macd, 9)
    val rsi =
      org.ta4j.core.indicators
        .RSIIndicator(close, 14)
    var state = TechnicalFeatureState()
    for (index in 0..389) {
      val price = 100 + index * 0.05 + kotlin.math.sin(index.toDouble())
      val bar = bar(index, price)
      series.addBar(
        org.ta4j.core.BaseBar(
          java.time.Duration.ofMinutes(1),
          bar.eventTime.plusSeconds(60).atZone(java.time.ZoneOffset.UTC),
          price,
          price,
          price,
          price,
          bar.volume,
        ),
      )
      val transition = advanceTechnicalFeature(state, bar, computed, "a".repeat(40))
      state = transition.state
      val values = assertNotNull(transition.feature).material.values
      for ((expected, actual) in listOf(
        ema12.getValue(index).doubleValue() to values.ema12PriceMicros,
        ema26.getValue(index).doubleValue() to values.ema26PriceMicros,
        macd.getValue(index).doubleValue() to values.macdPriceMicros,
        signal.getValue(index).doubleValue() to values.macdSignalPriceMicros,
        rsi.getValue(index).doubleValue() to values.rsi14Micros,
      )) {
        if (actual.status == TechnicalReadiness.READY) assertEquals(expected, assertNotNull(actual.value).toDouble() / 1_000_000, 0.000001)
      }
    }
  }

  @Test fun `malformed computation bounds are rejected without erasing state`() {
    val state = calculate((0..29).map { bar(it) }).state
    val rejected = processTechnicalFeature(state, bar(30), Long.MAX_VALUE, "a".repeat(40))
    assertEquals(state, rejected.state)
    assertNull(rejected.feature)
    assertNotNull(rejected.rejection)
    assertFailsWith<IllegalArgumentException> {
      RollingMarketFeatureConfig.fromEnv(mapOf("TA_TECHNICAL_FEATURES_TOPIC" to "technical"))
    }
  }

  @Test fun `checkpoint restoration preserves canonical corrections and session isolation`() {
    val complete = calculate((0..389).map { bar(it) })
    val serializer =
      org.apache.flink.api.java.typeutils.runtime.kryo.KryoSerializer(
        TechnicalFeatureState::class.java,
        org.apache.flink.api.common.serialization
          .SerializerConfigImpl(),
      )
    val output =
      org.apache.flink.core.memory
        .DataOutputSerializer(4096)
    serializer.serialize(complete.state, output)
    val restored =
      serializer.deserialize(
        org.apache.flink.core.memory
          .DataInputDeserializer(output.copyOfBuffer),
      )
    assertEquals(complete.state, restored)
    val correction = bar(0, 101.0).copy(ingestionTime = start.plusSeconds(390 * 60), sourceOffset = 999)
    assertEquals(
      advanceTechnicalFeature(complete.state, correction, computed, "a".repeat(40)),
      advanceTechnicalFeature(restored, correction, computed, "a".repeat(40)),
    )
    val next = bar(0).copy(eventTime = start.plusSeconds(86400), ingestionTime = start.plusSeconds(86461), sourceOffset = 1000)
    val nextState = advanceTechnicalFeature(restored, next, computed + 86400_000, "a".repeat(40)).state
    assertEquals(1, nextState.bars.size)
    assertEquals(nextState, advanceTechnicalFeature(nextState, bar(389), computed + 86400_000, "a".repeat(40)).state)
    assertEquals(restored, processTechnicalFeature(restored, correction.copy(high = -1.0), computed, "a".repeat(40)).state)
    assertNull(advanceTechnicalFeature(restored, bar(389), computed, "a".repeat(40)).feature)
  }
}
