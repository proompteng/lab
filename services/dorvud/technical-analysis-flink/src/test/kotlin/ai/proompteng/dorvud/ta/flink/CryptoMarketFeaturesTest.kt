package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.CRYPTO_DELAY_CLASS
import ai.proompteng.dorvud.platform.CRYPTO_SESSION
import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.decodeCryptoMarketData
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import org.apache.flink.api.common.typeinfo.Types
import org.apache.flink.api.java.functions.KeySelector
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment
import org.apache.flink.streaming.api.operators.KeyedProcessOperator
import org.apache.flink.streaming.runtime.streamrecord.StreamRecord
import org.apache.flink.streaming.util.KeyedOneInputStreamOperatorTestHarness
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

internal object CryptoFeatureTestData {
  val start: Instant = Instant.parse("2026-10-10T23:30:00Z")
  val source = CryptoArchiveConfig("crypto-events", "us", setOf("BTC/USD"))
  val revision = "a".repeat(40)
  val computed: Long = start.plusSeconds(86_400).toEpochMilli()

  fun record(
    index: Int,
    price: String = "100",
    volume: String = "2",
    vwap: String = "99.5",
    eventStart: Instant = start,
    offset: Long = index.toLong(),
    ingestionTime: Instant = eventStart.plusSeconds((index + 1) * 60L).plusNanos(123456789),
    type: String = "b",
  ): ArchiveKafkaRecord {
    val payload =
      Json
        .parseToJsonElement(
          """{"T":"$type","S":"BTC/USD","t":"${eventStart.plusSeconds(
            index * 60L,
          )}","o":$price,"h":$price,"l":$price,"c":$price,"v":$volume,"vw":$vwap}""",
        ).jsonObject
    val event = decodeCryptoMarketData(payload)
    val envelope: Envelope<JsonElement> =
      Envelope(
        ingestTs = ingestionTime,
        eventTs = event.eventTs,
        feed = source.location,
        channel = event.channel.subscription,
        symbol = event.symbol,
        seq = offset + 1,
        payload = event.payload,
        provider = "alpaca",
        marketSession = CRYPTO_SESSION,
        delayClass = CRYPTO_DELAY_CLASS,
        version = 2,
      )
    return ArchiveKafkaRecord(source.topic, 1, offset, Json.encodeToString(Envelope.serializer(JsonElement.serializer()), envelope))
  }

  fun bar(
    index: Int,
    price: String = "100",
  ): CryptoFeatureBar = assertNotNull(decodeCryptoFeatureBar(record(index, price), source))

  fun calculate(bars: List<CryptoFeatureBar>): CryptoFeatureTransition =
    bars.fold(CryptoFeatureTransition(CryptoFeatureState())) { previous, bar ->
      advanceCryptoFeature(previous.state, bar, computed, revision)
    }
}

class CryptoMarketFeaturesTest {
  private val fixture = CryptoFeatureTestData

  private fun ready(value: String) = TechnicalFeatureValue(TechnicalReadiness.READY, value)

  @Test
  fun `clock skew cannot compound into publishing a minute ten seconds before completion`() {
    val bar =
      assertNotNull(
        decodeCryptoFeatureBar(fixture.record(0, ingestionTime = fixture.start.plusSeconds(55)), fixture.source),
      )
    assertFails {
      advanceCryptoFeature(CryptoFeatureState(), bar, fixture.start.plusSeconds(50).toEpochMilli(), fixture.revision)
    }
    assertNotNull(advanceCryptoFeature(CryptoFeatureState(), bar, fixture.start.plusSeconds(55).toEpochMilli(), fixture.revision).feature)
  }

  @Test
  fun `native fractional volume and decimal prices survive rolling features exactly`() {
    val price = "100.000000000000000123456789"
    val bars =
      (0..60).map {
        assertNotNull(decodeCryptoFeatureBar(fixture.record(it, price, "0.000000000123456789128", price), fixture.source))
      }
    val feature = assertNotNull(fixture.calculate(bars).feature)
    assertEquals(
      CryptoRollingValues(price, price, price, price, "0.00000000370370367384"),
      feature.material.priceWindow,
    )
    assertEquals(61, feature.material.inputs.size)
    assertEquals(
      featureNanos(bars.last().ingestionTime),
      feature.material.inputs
        .last()
        .ingestionTimeNanos,
    )
    assertEquals(
      cryptoHistoryHash(feature.material.historyPrefixHash, feature.material.inputs),
      feature.material.historyHash,
    )
  }

  @Test
  fun `constant source has literal indicator golden values and distinct source VWAP`() {
    val feature = assertNotNull(fixture.calculate((0..60).map { fixture.bar(it) }).feature)
    assertEquals(
      CryptoTechnicalValues(
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
      feature.material.technical,
    )
    val archived =
      decodeArchivedCryptoMarketFeature(
        ArchiveKafkaRecord(
          "crypto-features",
          2,
          42,
          Json { encodeDefaults = true }.encodeToString(CryptoMarketFeature.serializer(), feature),
        ),
        fixture.source,
        "crypto-features",
        fixture.computed,
      )
    assertEquals(feature, archived.feature)
  }

  @Test
  fun `continuous recursive state crosses Saturday midnight and stays bounded without reseeding`() {
    val result =
      fixture.calculate(
        (0..120).map {
          fixture.bar(it, (100.toBigDecimal() + it.toBigDecimal().movePointLeft(2)).toPlainString())
        },
      )
    val feature = assertNotNull(result.feature)
    assertEquals(61, result.state.bars.size)
    assertEquals(60, result.state.seed.values.count)
    assertEquals(ready("101145000"), feature.material.technical.ema12PriceMicros)
    assertEquals(ready("101075012"), feature.material.technical.ema26PriceMicros)
    assertEquals(CRYPTO_SESSION, feature.material.marketSession)
    assertEquals("100.91", feature.material.priceWindow.referencePrice)
    assertEquals(fixture.start.plusSeconds(121 * 60).toEpochMilli(), feature.material.windowEndMs)
  }

  @Test
  fun `late corrections within retained history reproduce fresh canonical indicators and old corrections fail`() {
    val bars = (0..120).map { fixture.bar(it, (100 + it).toString()) }
    val original = fixture.calculate(bars)
    val correction =
      assertNotNull(
        decodeCryptoFeatureBar(
          fixture.record(90, "150", vwap = "149", offset = 999, ingestionTime = fixture.start.plusSeconds(122 * 60), type = "u"),
          fixture.source,
        ),
      )
    val revised = advanceCryptoFeature(original.state, correction, fixture.computed, fixture.revision)
    val expected = fixture.calculate(bars.mapIndexed { index, value -> if (index == 90) correction else value })
    assertEquals(expected, revised)
    assertNotEquals(original.feature?.featureId, revised.feature?.featureId)
    assertNull(advanceCryptoFeature(revised.state, correction, fixture.computed, fixture.revision).feature)
    assertFails { advanceCryptoFeature(revised.state, fixture.bar(0), fixture.computed, fixture.revision) }
  }

  @Test
  fun `gaps and zero volume stay unavailable until actual source coverage recovers`() {
    val early = fixture.calculate((0..9).map { fixture.bar(it) })
    assertEquals(
      TechnicalReadiness.WARMING,
      early.feature
        ?.material
        ?.technical
        ?.ema12PriceMicros
        ?.status,
    )
    assertNull(
      early.feature
        ?.material
        ?.technical
        ?.ema12PriceMicros
        ?.value,
    )
    val missing = fixture.calculate((0..60).filter { it != 50 }.map { fixture.bar(it) })
    assertEquals(
      TechnicalReadiness.GAP,
      missing.feature
        ?.material
        ?.technical
        ?.ema26PriceMicros
        ?.status,
    )
    assertNotNull(missing.feature?.material?.priceWindow)
    assertEquals(29, missing.state.bars.count { it.eventTime >= fixture.start.plusSeconds(31 * 60) })
    val repaired = advanceCryptoFeature(missing.state, fixture.bar(50), fixture.computed, fixture.revision)
    assertEquals(fixture.calculate((0..60).map { fixture.bar(it) }), repaired)
    val zero =
      fixture.calculate(
        (0..60).map {
          assertNotNull(decodeCryptoFeatureBar(fixture.record(it, volume = "0", vwap = "0"), fixture.source))
        },
      )
    assertEquals(
      TechnicalReadiness.ZERO_VOLUME,
      zero.feature
        ?.material
        ?.technical
        ?.vwap30mPriceMicros
        ?.status,
    )
    assertNull(
      zero.feature
        ?.material
        ?.technical
        ?.vwap30mPriceMicros
        ?.value,
    )
    assertEquals(
      "0",
      zero.feature
        ?.material
        ?.priceWindow
        ?.totalVolume,
    )
  }

  @Test
  fun `Flink checkpoint restores recursive seed and deduplicates a replayed corrected bar`() {
    fun harness() =
      KeyedOneInputStreamOperatorTestHarness(
        KeyedProcessOperator(CryptoMarketFeatureFunction(fixture.revision)),
        KeySelector<CryptoFeatureBar, String> { "${it.location}|${it.symbol}" },
        Types.STRING,
      )
    val bars = (0..120).map { fixture.bar(it, (100 + it).toString()) }
    val snapshot =
      harness().use { h ->
        h.open()
        h.setProcessingTime(fixture.computed)
        bars.take(100).forEach { h.processElement(StreamRecord(it)) }
        h.snapshot(1, fixture.computed)
      }
    harness().use { h ->
      h.initializeState(snapshot)
      h.open()
      h.setProcessingTime(fixture.computed)
      h.processElement(StreamRecord(bars[99]))
      assertTrue(h.extractOutputValues().isEmpty())
      bars.drop(100).forEach { h.processElement(StreamRecord(it)) }
      assertEquals(fixture.calculate(bars).feature, h.extractOutputValues().last())
    }
  }

  @Test
  fun `crypto branch restores every generated checkpoint identity from the deployed full equity graph`() {
    val ta =
      FlinkTaConfig.fromEnv().copy(
        quotesTopic = "quotes",
        bars1mTopic = "bars",
        statusTopic = "status",
        parallelism = 8,
        clickhouseUrl = "jdbc:clickhouse://localhost:8123/torghut",
        securityProtocol = "PLAINTEXT",
      )
    val features =
      RollingMarketFeatureConfig(
        "rolling",
        "bars",
        ArchiveUniverse("test-v1", canonicalSymbolHash(listOf("AAPL")), setOf("AAPL")),
        fixture.revision,
        "technical",
        FeatureRestoreTopology.ROLLING_FEATURES,
      )
    val crypto = CryptoMarketFeatureConfig(fixture.source, "crypto-features", fixture.revision)
    for (equityFeatures in listOf(null, features)) {
      val previous = configureTechnicalAnalysisJob(StreamExecutionEnvironment.getExecutionEnvironment(), ta, equityFeatures).jobGraph
      val next = configureTechnicalAnalysisJob(StreamExecutionEnvironment.getExecutionEnvironment(), ta, equityFeatures, crypto).jobGraph
      val prior =
        previous.vertices
          .flatMap { it.operatorIDs }
          .map { it.generatedOperatorID.toHexString() }
          .toSet()
      val restored =
        next.vertices
          .flatMap { it.operatorIDs }
          .flatMap {
            listOfNotNull(it.generatedOperatorID.toHexString(), it.userDefinedOperatorID?.orElse(null)?.toHexString())
          }.toSet()
      assertTrue(restored.containsAll(prior), "missing prior checkpoint IDs: ${prior - restored}")
      assertTrue(next.vertices.any { it.name.contains("crypto-market-features") })
    }
  }
}
