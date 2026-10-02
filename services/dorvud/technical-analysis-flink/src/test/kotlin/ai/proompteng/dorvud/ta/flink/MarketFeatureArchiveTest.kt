package ai.proompteng.dorvud.ta.flink

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class MarketFeatureArchiveTest {
  private val json = Json { encodeDefaults = true }

  private fun fixture() = java.io.File("../../bayn/src/market-data/features/fixtures/rolling-price-v1.json").readText()

  private fun record() = ArchiveKafkaRecord("torghut.market-features.v1", 2, 12, fixture())

  private fun routes() =
    mapOf(
      "torghut.bars.1m.v1" to ArchiveRoute("iex", ArchiveUniverse("test-equity-v1", canonicalSymbolHash(listOf("AAPL")), setOf("AAPL"))),
    )

  private val archivedAt =
    java.time.Instant
      .parse("2026-09-11T14:00:03Z")
      .toEpochMilli()

  @Test fun `archive retains exact feature message and transport coordinates`() {
    val decoded = decodeArchivedMarketFeature(record(), routes(), archivedAt)
    assertEquals(2, decoded.sourcePartition)
    assertEquals(12, decoded.sourceOffset)
    assertEquals(fixture(), decoded.payload)
    assertEquals("AAPL", decoded.symbol)
    assertEquals(archivedAt, decoded.archivedAtMs)
  }

  @Test fun `non-object JSON is rejected through the normal validation path`() {
    for (payload in listOf("[]", "null", "true", "1", "\"text\"", "{}", "{\"material\":[]}", "{\"material\":null}")) {
      assertFailsWith<IllegalArgumentException> {
        decodeArchivedMarketFeature(record().copy(value = payload), routes(), archivedAt)
      }
    }
  }

  @Test fun `archive rejects tampered content and wrong universe`() {
    assertFailsWith<IllegalArgumentException> {
      decodeArchivedMarketFeature(record().copy(value = fixture().replace("131000000", "132000000")), routes(), archivedAt)
    }
    assertFailsWith<IllegalArgumentException> { decodeArchivedMarketFeature(record(), emptyMap(), archivedAt) }
    assertFailsWith<IllegalArgumentException> { decodeArchivedMarketFeature(record(), routes(), archivedAt - 7000) }
  }

  @Test fun `archive accepts bounded producer clock lead without changing either timestamp`() {
    val decoded = decodeArchivedMarketFeature(record(), routes(), archivedAt - 2000)
    assertEquals(archivedAt - 1000, decoded.computedAtMs)
    assertEquals(archivedAt - 2000, decoded.archivedAtMs)
  }

  @Test fun `archive shares the finalized bar clock allowance`() {
    val feature = json.decodeFromString(RollingMarketFeature.serializer(), fixture())
    for ((leadMs, accepted) in listOf(1000L to true, 6000L to false)) {
      val input = feature.material.inputs.first()
      val changedInput =
        input.copy(
          ingestionTimeNanos =
            (input.eventTimeNanos.toBigInteger() + (60_000 - leadMs).toBigInteger() * 1_000_000L.toBigInteger()).toString(),
        )
      val material = feature.material.copy(inputs = listOf(changedInput) + feature.material.inputs.drop(1))
      val changed =
        feature.copy(
          material = material,
          featureId = featureHash(json.encodeToJsonElement(RollingMarketFeatureMaterial.serializer(), material)),
        )
      val record = record().copy(value = json.encodeToString(RollingMarketFeature.serializer(), changed))
      if (accepted) {
        assertEquals(feature.computedAtMs, decodeArchivedMarketFeature(record, routes(), archivedAt).computedAtMs)
      } else {
        assertFailsWith<IllegalArgumentException> { decodeArchivedMarketFeature(record, routes(), archivedAt) }
      }
    }
  }

  @Test fun `archive rejects incomplete provenance even with recomputed content hash`() {
    val feature = json.decodeFromString(RollingMarketFeature.serializer(), fixture())
    val material = feature.material.copy(inputs = feature.material.inputs.drop(1))
    val changed =
      feature.copy(
        material = material,
        featureId = featureHash(json.encodeToJsonElement(RollingMarketFeatureMaterial.serializer(), material)),
      )
    assertFailsWith<IllegalArgumentException> {
      decodeArchivedMarketFeature(
        record().copy(value = json.encodeToString(RollingMarketFeature.serializer(), changed)),
        routes(),
        archivedAt,
      )
    }
  }

  @Test fun `feature input offsets must fit nonnegative Kafka int64`() {
    val feature = json.decodeFromString(RollingMarketFeature.serializer(), fixture())
    for ((offset, accepted) in listOf(Long.MAX_VALUE.toString() to true, "9223372036854775808" to false, "-1" to false, "01" to false)) {
      val material =
        feature.material.copy(
          inputs =
            listOf(
              feature.material.inputs
                .first()
                .copy(sourceOffset = offset),
            ) + feature.material.inputs.drop(1),
        )
      val changed =
        feature.copy(
          material = material,
          featureId = featureHash(json.encodeToJsonElement(RollingMarketFeatureMaterial.serializer(), material)),
        )
      val record = record().copy(value = json.encodeToString(RollingMarketFeature.serializer(), changed))
      if (accepted) {
        decodeArchivedMarketFeature(record, routes(), archivedAt)
      } else {
        assertFailsWith<IllegalArgumentException> { decodeArchivedMarketFeature(record, routes(), archivedAt) }
      }
    }
  }

  @Test fun `feature branch is opt in and rejects noncanonical universe configuration`() {
    assertNull(RollingMarketFeatureConfig.fromEnv(emptyMap()))
    assertFailsWith<IllegalArgumentException> { RollingMarketFeatureConfig.fromEnv(mapOf("TA_MARKET_FEATURES_TOPIC" to "features")) }
  }
}
