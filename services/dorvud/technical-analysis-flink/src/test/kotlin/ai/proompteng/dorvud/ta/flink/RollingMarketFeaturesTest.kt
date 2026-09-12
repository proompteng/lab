package ai.proompteng.dorvud.ta.flink

import kotlinx.serialization.json.Json
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class RollingMarketFeaturesTest {
  private val start = Instant.parse("2026-09-11T13:30:00Z")
  private val computed = Instant.parse("2026-09-11T14:00:02Z").toEpochMilli()

  private fun bar(index: Int): IntradayBarRecord =
    IntradayBarRecord(
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
      open = 100.0 + index,
      high = 102.0 + index,
      low = 99.0 + index,
      close = 101.0 + index,
      volume = 10.25,
      vwap = 100.5 + index,
      tradeCount = 2,
      schemaVersion = 1,
    )

  private fun complete(order: List<Int> = (0..29).toList()): RollingFeatureTransition {
    var result = RollingFeatureTransition(RollingFeatureState(), null)
    for (index in order) result = advanceRollingFeature(result.state, bar(index), computed, "test-revision")
    return result
  }

  @Test fun `emits immediately with thirty finalized bars and stable shared fixture`() {
    val result = complete()
    val feature = assertNotNull(result.feature)
    assertEquals(RollingMarketValues("100000000", "131000000", "99000000", "130000000", "307500000"), feature.material.values)
    assertEquals(30, feature.material.inputs.size)
    assertEquals(start.toEpochMilli(), feature.material.windowStartMs)
    assertEquals(computed - 2000, feature.material.windowEndMs)
    val fixture = java.io.File("../../bayn/src/market-data/features/fixtures/rolling-price-v1.json")
    if (System.getProperty("writeMarketFeatureFixture") == "true") {
      fixture.parentFile.mkdirs()
      fixture.writeText(
        Json {
          encodeDefaults = true
          prettyPrint = true
        }.encodeToString(RollingMarketFeature.serializer(), feature) + "\n",
      )
    }
    assertEquals(
      Json.parseToJsonElement(fixture.readText()),
      Json {
        encodeDefaults = true
      }.encodeToJsonElement(RollingMarketFeature.serializer(), feature),
    )
  }

  @Test fun `checkpoint serializer restores the complete canonical rolling state`() {
    val serializer =
      org.apache.flink.api.java.typeutils.runtime.kryo.KryoSerializer(
        RollingFeatureState::class.java,
        org.apache.flink.api.common.serialization
          .SerializerConfigImpl(),
      )
    val state = complete().state
    val output =
      org.apache.flink.core.memory
        .DataOutputSerializer(4096)
    serializer.serialize(state, output)
    val restored =
      serializer.deserialize(
        org.apache.flink.core.memory
          .DataInputDeserializer(output.copyOfBuffer),
      )
    assertEquals(state, restored)
    assertEquals(
      advanceRollingFeature(state, bar(30), computed + 60_000, "test-revision"),
      advanceRollingFeature(restored, bar(30), computed + 60_000, "test-revision"),
    )
  }

  @Test fun `invalid input preserves completed history and the next minute publishes immediately`() {
    val state = complete().state
    val rejected = processRollingFeature(state, bar(30).copy(high = -1.0), computed + 60_000, "test-revision")
    assertEquals(state, rejected.state)
    assertNotNull(rejected.rejection)
    assertNull(rejected.feature)
    val recovered = processRollingFeature(rejected.state, bar(30), computed + 60_000, "test-revision")
    assertNotNull(recovered.feature)
    assertNull(recovered.rejection)
  }

  @Test fun `timestamp overflow is rejected without losing warm history`() {
    val state = complete().state
    val malformed =
      listOf(
        bar(30).copy(ingestionTime = Instant.MAX),
        bar(30).copy(ingestionTime = Instant.MIN),
        bar(30).copy(eventTime = Instant.MAX),
        bar(30).copy(eventTime = Instant.MIN),
      )
    for (input in malformed) {
      val result = processRollingFeature(state, input, computed + 60_000, "test-revision")
      assertEquals(state, result.state)
      assertNotNull(result.rejection)
      assertNull(result.feature)
    }
    val overflow = processRollingFeature(state, bar(30), Long.MAX_VALUE, "test-revision")
    assertEquals(state, overflow.state)
    assertNotNull(overflow.rejection)
    assertNotNull(processRollingFeature(state, bar(30), computed + 60_000, "test-revision").feature)
  }

  @Test fun `arrival ordering cannot change semantic feature identity`() {
    val ordered = assertNotNull(complete().feature)
    val reversed = assertNotNull(complete((0..29).reversed().toList()).feature)
    assertEquals(ordered, reversed)
  }

  @Test fun `gap stays unavailable and late bar completes the same window`() {
    val incomplete = complete((0..29).filter { it != 12 })
    assertNull(incomplete.feature)
    val recovered = advanceRollingFeature(incomplete.state, bar(12), computed, "test-revision")
    assertEquals(complete().feature, recovered.feature)
  }

  @Test fun `duplicates do not emit and corrections replace rather than accumulate`() {
    val original = complete()
    val duplicate = advanceRollingFeature(original.state, bar(29), computed + 1000, "test-revision")
    assertNull(duplicate.feature)
    val correction =
      bar(
        12,
      ).copy(channel = "updatedBars", high = 200.0, volume = 20.25, sourceOffset = 100, ingestionTime = Instant.ofEpochMilli(computed))
    val corrected = advanceRollingFeature(original.state, correction, computed + 1000, "test-revision")
    assertEquals("200000000", assertNotNull(corrected.feature).material.values.rangeHighPriceMicros)
    assertEquals("317500000", corrected.feature.material.values.totalVolumeMicros)
    assertNotEquals(original.feature?.featureId, corrected.feature.featureId)
    assertNull(advanceRollingFeature(corrected.state, bar(12), computed + 2000, "test-revision").feature)
  }

  @Test fun `partition tie break matches archive precedence before offset`() {
    val left = bar(1).copy(sourcePartition = 1, sourceOffset = 1)
    val right = bar(1).copy(sourcePartition = 0, sourceOffset = 999)
    assertEquals(1, compareFeatureBarRevision(left, right))
  }

  @Test fun `finalized bar close tolerates a bounded trailing ingestion clock`() {
    val accepted = processRollingFeature(RollingFeatureState(), bar(0).copy(ingestionTime = start.plusSeconds(59)), computed, "test")
    assertNull(accepted.rejection)
    assertEquals(1, accepted.state.bars.size)
    val rejected = processRollingFeature(RollingFeatureState(), bar(0).copy(ingestionTime = start.plusSeconds(54)), computed, "test")
    assertNotNull(rejected.rejection)
    assertEquals(0, rejected.state.bars.size)
  }

  @Test fun `pairwise host skew cannot accumulate beyond the completed window allowance`() {
    val early = bar(0).copy(ingestionTime = start.plusSeconds(55))
    val rejected = processRollingFeature(RollingFeatureState(), early, start.plusSeconds(50).toEpochMilli(), "test")
    assertNotNull(rejected.rejection)
    assertEquals(0, rejected.state.bars.size)
    val accepted = processRollingFeature(RollingFeatureState(), early, start.plusSeconds(55).toEpochMilli(), "test")
    assertNull(accepted.rejection)
    assertEquals(1, accepted.state.bars.size)
  }

  @Test fun `conflicting immutable coordinate and premature bars fail`() {
    val original = complete()
    assertFailsWith<IllegalArgumentException> {
      advanceRollingFeature(
        original.state,
        bar(29).copy(high = 200.0),
        computed,
        "test-revision",
      )
    }
    assertFailsWith<IllegalArgumentException> {
      advanceRollingFeature(RollingFeatureState(), bar(0).copy(ingestionTime = start), computed, "test-revision")
    }
    assertFailsWith<IllegalArgumentException> {
      advanceRollingFeature(original.state, bar(30).copy(symbol = "SPY"), computed + 60_000, "test-revision")
    }
  }

  @Test fun `new session resets rolling history and previous session cannot contaminate it`() {
    val original = complete()
    val tomorrow = bar(0).copy(eventTime = start.plusSeconds(86400), ingestionTime = start.plusSeconds(86461), sourceOffset = 200)
    val reset = advanceRollingFeature(original.state, tomorrow, computed + 86400_000, "test-revision")
    assertNull(reset.feature)
    assertEquals(1, reset.state.bars.size)
    assertEquals(reset.state, advanceRollingFeature(reset.state, bar(29), computed + 86400_000, "test-revision").state)
  }

  @Test fun `price rounding matches JavaScript positive half rounding`() {
    assertEquals(100000001, featureMicros(100.0000005))
    assertEquals(100000000, featureMicros(100.00000049))
    assertFailsWith<IllegalArgumentException> { featureMicros(Double.NaN) }
    assertFailsWith<IllegalArgumentException> { featureMicros(Double.MAX_VALUE) }
  }
}
