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

  @Test fun `archive rejects tampered content and wrong universe`() {
    assertFailsWith<IllegalArgumentException> {
      decodeArchivedMarketFeature(record().copy(value = fixture().replace("131000000", "132000000")), routes(), archivedAt)
    }
    assertFailsWith<IllegalArgumentException> { decodeArchivedMarketFeature(record(), emptyMap(), archivedAt) }
    assertFailsWith<IllegalArgumentException> { decodeArchivedMarketFeature(record(), routes(), archivedAt - 2000) }
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

  @Test fun `feature branch is opt in and rejects noncanonical universe configuration`() {
    assertNull(RollingMarketFeatureConfig.fromEnv(emptyMap()))
    assertFailsWith<IllegalArgumentException> { RollingMarketFeatureConfig.fromEnv(mapOf("TA_MARKET_FEATURES_TOPIC" to "features")) }
  }
}
