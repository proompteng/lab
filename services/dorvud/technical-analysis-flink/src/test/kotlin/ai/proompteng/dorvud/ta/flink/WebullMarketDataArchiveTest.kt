package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.WebullSource
import ai.proompteng.dorvud.platform.encodeWebullCapture
import ai.proompteng.dorvud.platform.webullCapture
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment
import org.apache.flink.streaming.api.graph.StreamGraphHasherV2
import java.lang.reflect.Proxy
import java.sql.PreparedStatement
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertTrue

class WebullMarketDataArchiveTest {
  private val topic = "dorvud.webull.raw.v1"

  @Test
  fun `Webull raw archive retains payload and nanosecond receipt time under exact Kafka coordinates`() {
    val capture =
      webullCapture(
        WebullSource.Collector("coverage"),
        "{\"candidateSymbols\":12295}".toByteArray(),
        Instant.parse("2026-11-01T00:00:00.123456789Z"),
      )
    val record = ArchiveKafkaRecord(topic, 2, 1234, encodeWebullCapture(capture))
    val archived = decodeArchivedWebullMarketData(record, topic)
    assertEquals(record.value, archived.capture)
    assertEquals(capture.receivedAt, archived.receivedAt)
    assertEquals("VALID", archived.validationStatus)
    val bound = mutableMapOf<Int, Any?>()
    val statement =
      Proxy.newProxyInstance(javaClass.classLoader, arrayOf(PreparedStatement::class.java)) { _, method, args ->
        require(method.name in setOf("setString", "setInt", "setLong"))
        bound[args[0] as Int] = args[1]
        null
      } as PreparedStatement
    webullMarketDataStatement().accept(statement, archived)
    assertEquals(14, bound.size)
    assertEquals(record.value, bound[12])
    assertEquals("[]", bound[13])
    assertEquals("[]", bound[14])
    assertEquals(2, bound[5])
    assertEquals(1234L, bound[6])
    assertFails { decodeArchivedWebullMarketData(record.copy(topic = "torghut.trades.v1"), topic) }
    assertFails { decodeArchivedWebullMarketData(record.copy(value = record.value.replace(capture.payloadSha256, "0".repeat(64))), topic) }
  }

  @Test
  fun `malformed native data stays archived as rejected instead of disappearing`() {
    val capture = webullCapture(WebullSource.Http("/market-data/stocks/bars/list", listOf("AAPL")), "{\"unrecognized\":true}".toByteArray())
    val record = ArchiveKafkaRecord(topic, 0, 1, encodeWebullCapture(capture))
    val archived = decodeArchivedWebullMarketData(record, topic)
    assertEquals("REJECTED", archived.validationStatus)
    assertTrue(archived.validationError.isNotBlank())
    assertEquals(record.value, archived.capture)
    assertEquals("[]", archived.minuteBarsJson)
    assertEquals("[[\"AAPL\",\"REJECTED\",0,0]]", archived.barRequestsJson)
  }

  @Test
  fun `adding the Webull branch preserves all existing archive savepoint identities`() {
    fun hashes(enabled: Boolean): Map<String, String> {
      val env = StreamExecutionEnvironment.getExecutionEnvironment()
      val config = MarketDataArchiveConfig.fromEnv(MarketDataArchiveJobTest().validEnvironment())
      configureMarketDataArchiveJob(env, config.copy(webullTopic = if (enabled) topic else null))
      val graph = env.streamGraph
      val hashes = StreamGraphHasherV2().traverseStreamGraphAndGenerateHashes(graph)
      return graph.streamNodes.filter { it.operatorName.startsWith("Source:") || it.operatorName.endsWith(": Writer") }.associate {
        it.operatorName to
          hashes.getValue(it.id).contentToString()
      }
    }
    val original = hashes(false)
    val extended = hashes(true)
    original.forEach { (name, hash) -> assertEquals(hash, extended[name], name) }
    assertTrue(extended.size > original.size)
  }
}
