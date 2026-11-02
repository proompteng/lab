package ai.proompteng.dorvud.ta.flink

import kotlinx.serialization.json.Json
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment
import org.apache.flink.streaming.api.graph.StreamGraphHasherV2
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CryptoMarketFeatureArchiveTest {
  private val fixture = CryptoFeatureTestData
  private val json = Json { encodeDefaults = true }
  private val topic = "crypto-features"

  private fun record(feature: CryptoMarketFeature): ArchiveKafkaRecord =
    ArchiveKafkaRecord(topic, 2, 42, json.encodeToString(CryptoMarketFeature.serializer(), feature))

  private fun rehash(
    feature: CryptoMarketFeature,
    material: CryptoMarketFeatureMaterial,
  ): CryptoMarketFeature =
    feature.copy(material = material, featureId = featureHash(json.encodeToJsonElement(CryptoMarketFeatureMaterial.serializer(), material)))

  @Test
  fun `archive rejects forged definitions source identities hashes and raw provenance`() {
    val feature = assertNotNull(fixture.calculate((0..60).map { fixture.bar(it) }).feature)
    val original = feature.material
    val first = original.inputs.first()
    for (material in listOf(
      original.copy(schemaVersion = "unknown"),
      original.copy(definitionHash = "0".repeat(64)),
      original.copy(location = "us-1"),
      original.copy(symbol = "ETH/USD"),
      original.copy(marketSession = "regular"),
      original.copy(delayClass = "real_time_exchange_only"),
      original.copy(windowStartMs = original.windowStartMs + 1),
      original.copy(historyHash = "0".repeat(64)),
      original.copy(inputs = original.inputs.reversed()),
      original.copy(inputs = listOf(first.copy(sourceTopic = "equity-bars")) + original.inputs.drop(1)),
      original.copy(inputs = listOf(first.copy(sourceOffset = "-1")) + original.inputs.drop(1)),
      original.copy(inputs = listOf(first, original.inputs[1].copy(sourceOffset = first.sourceOffset)) + original.inputs.drop(2)),
    )) {
      assertFails { decodeArchivedCryptoMarketFeature(record(rehash(feature, material)), fixture.source, topic, fixture.computed) }
    }
    assertFails {
      decodeArchivedCryptoMarketFeature(record(feature.copy(featureId = "0".repeat(64))), fixture.source, topic, fixture.computed)
    }
    assertFails {
      decodeArchivedCryptoMarketFeature(record(feature.copy(producerRevision = "unverified")), fixture.source, topic, fixture.computed)
    }
    assertFails {
      decodeArchivedCryptoMarketFeature(
        record(feature.copy(computedAtMs = original.windowStartMs)),
        fixture.source,
        topic,
        fixture.computed,
      )
    }
    assertFails { decodeArchivedCryptoMarketFeature(record(feature).copy(topic = "raw"), fixture.source, topic, fixture.computed) }
    assertFails { decodeArchivedCryptoMarketFeature(record(feature), fixture.source, topic, fixture.computed - 6000) }
  }

  @Test
  fun `configuration requires canonical native pairs and an isolated versioned feature route`() {
    val env =
      mapOf(
        "TA_CRYPTO_TOPIC" to fixture.source.topic,
        "TA_CRYPTO_FEATURES_TOPIC" to topic,
        "TA_CRYPTO_LOCATION" to "us",
        "TA_CRYPTO_SYMBOLS" to "BTC/USD,ETH/USD",
        "TORGHUT_TA_COMMIT" to fixture.revision,
      )
    assertNull(CryptoMarketFeatureConfig.fromEnv(emptyMap()))
    val valid = assertNotNull(CryptoMarketFeatureConfig.fromEnv(env))
    assertEquals(setOf("BTC/USD", "ETH/USD"), valid.source.symbols)
    for (key in env.keys) assertFails { CryptoMarketFeatureConfig.fromEnv(env - key) }
    for (entry in listOf(
      "TA_CRYPTO_FEATURES_TOPIC" to fixture.source.topic,
      "TA_CRYPTO_LOCATION" to "iex",
      "TA_CRYPTO_SYMBOLS" to "ETH/USD,BTC/USD",
      "TA_CRYPTO_SYMBOLS" to "BTC/USD,BTC/USD",
      "TA_CRYPTO_SYMBOLS" to "BTCUSD",
      "TORGHUT_TA_COMMIT" to "unknown",
    )) {
      assertFails { CryptoMarketFeatureConfig.fromEnv(env + entry) }
    }
  }

  @Test
  fun `derived archive retains every raw and equity feature checkpoint identity`() {
    val base =
      MarketDataArchiveConfig.fromEnv(MarketDataArchiveJobTest().validEnvironment()).copy(
        crypto = fixture.source,
        featuresTopic = "rolling",
        technicalFeaturesTopic = "technical",
      )

    fun stateful(config: MarketDataArchiveConfig): Set<String> {
      val env = StreamExecutionEnvironment.getExecutionEnvironment()
      configureMarketDataArchiveJob(env, config)
      val graph = env.streamGraph
      val hashes = StreamGraphHasherV2().traverseStreamGraphAndGenerateHashes(graph)
      return graph.streamNodes
        .filter {
          it.operatorName.startsWith("Source:") || it.operatorName.endsWith(": Writer") || it.operatorName.endsWith(": Committer")
        }.map { hashes.getValue(it.id).contentToString() }
        .toSet()
    }
    val previous = stateful(base)
    val current = stateful(base.copy(cryptoFeaturesTopic = topic))
    assertEquals(16, previous.size)
    assertEquals(19, current.size)
    assertTrue(current.containsAll(previous))
    for (invalid in listOf(fixture.source.topic, "rolling", "technical", base.routes.keys.first())) {
      assertFails { stateful(base.copy(cryptoFeaturesTopic = invalid)) }
    }
  }
}
