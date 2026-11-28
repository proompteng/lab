package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.CRYPTO_DELAY_CLASS
import ai.proompteng.dorvud.platform.CRYPTO_SESSION
import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.decodeCryptoMarketData
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment
import org.apache.flink.streaming.api.graph.StreamGraphHasherV2
import java.io.File
import java.lang.reflect.Proxy
import java.sql.PreparedStatement
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertTrue

class CryptoMarketDataArchiveTest {
  private val payloads = (Json.parseToJsonElement(File("../fixtures/alpaca-crypto-v1.json").readText()) as JsonArray).map { it.jsonObject }
  private val config = CryptoArchiveConfig("crypto-events", "us", setOf("BTC/USD"))

  private fun envelope(payload: JsonObject): Envelope<JsonElement> {
    val event = decodeCryptoMarketData(payload)
    return Envelope(
      ingestTs = Instant.parse("2026-10-10T02:04:01.987654321Z"),
      eventTs = event.eventTs,
      feed = "us",
      channel = event.channel.subscription,
      symbol = event.symbol,
      seq = 1,
      payload = event.payload,
      provider = "alpaca",
      marketSession = CRYPTO_SESSION,
      delayClass = CRYPTO_DELAY_CLASS,
      version = 2,
    )
  }

  private fun record(envelope: Envelope<JsonElement>): ArchiveKafkaRecord =
    ArchiveKafkaRecord(config.topic, 2, 42, Json.encodeToString(Envelope.serializer(JsonElement.serializer()), envelope))

  @Test
  fun `Kafka to JDBC retains crypto wire payload precision and transport coordinates`() {
    for (payload in payloads) {
      val archived = decodeArchivedCryptoMarketData(record(envelope(payload)), config)
      assertEquals(payload, Json.parseToJsonElement(archived.payload))
      assertEquals(2, archived.sourcePartition)
      assertEquals(42L, archived.sourceOffset)
      assertEquals(config.topic, archived.sourceTopic)
      val bound = mutableMapOf<Int, Any?>()
      val statement =
        Proxy.newProxyInstance(javaClass.classLoader, arrayOf(PreparedStatement::class.java)) { _, method, args ->
          require(method.name in setOf("setString", "setInt", "setLong")) { "unexpected JDBC call: ${method.name}" }
          bound[args[0] as Int] = args[1]
          null
        } as PreparedStatement
      cryptoMarketDataStatement().accept(statement, archived)
      assertEquals(10, bound.size)
      assertEquals(archived.eventTs, bound[4])
      assertEquals("2026-10-10T02:04:01.987654321Z", bound[5])
      assertEquals(payload.toString(), bound[10])
    }
  }

  @Test
  fun `archive rejects cross-feed metadata drift and invalid source identity`() {
    val original = envelope(payloads.first())
    for (invalid in listOf(
      original.copy(feed = "iex"),
      original.copy(marketSession = "regular"),
      original.copy(delayClass = "real_time_exchange_only"),
      original.copy(symbol = "ETH/USD"),
      original.copy(eventTs = original.eventTs.plusNanos(1)),
      original.copy(channel = "quotes"),
      original.copy(source = "rest"),
      original.copy(version = 1),
      original.copy(seq = 0),
    )) {
      assertFails { decodeArchivedCryptoMarketData(record(invalid), config) }
    }
    assertFails { decodeArchivedCryptoMarketData(record(original).copy(offset = -1), config) }
    assertFails { decodeArchivedCryptoMarketData(record(original).copy(topic = "equity-events"), config) }
    assertFails { decodeArchivedCryptoMarketData(record(original), config.copy(symbols = setOf("ETH/USD"))) }
  }

  @Test
  fun `crypto source has independent state and retains existing stateful archive restore identities`() {
    val fixture = MarketDataArchiveJobTest()

    fun hashes(crypto: CryptoArchiveConfig?): Map<String, String> {
      val environment = StreamExecutionEnvironment.getExecutionEnvironment()
      configureMarketDataArchiveJob(
        environment,
        MarketDataArchiveConfig
          .fromEnv(
            fixture.validEnvironment(),
          ).copy(crypto = crypto, featuresTopic = "features", technicalFeaturesTopic = "technical-features"),
      )
      val graph = environment.streamGraph
      val hashes = StreamGraphHasherV2().traverseStreamGraphAndGenerateHashes(graph)
      return graph.streamNodes
        .filter { it.operatorName.startsWith("Source:") || it.operatorName.endsWith(": Writer") || it.operatorName.endsWith(": Committer") }
        .associate { hashes.getValue(it.id).contentToString() to it.operatorName }
    }
    val original = hashes(null)
    val extended = hashes(config)
    assertEquals(13, original.size)
    assertEquals(16, extended.size)
    original.forEach { (hash, name) -> assertTrue(hash in extended, "restored operator: $name") }
    assertTrue(extended.values.any { it.contains("crypto-market-data-source") })
  }
}
