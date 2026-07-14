package ai.proompteng.dorvud.hyperliquid

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class KafkaClickHouseStoreTest {
  @Test
  fun `queries persisted lineage and inserts immutable offset rows with a token`() {
    val queries = mutableListOf<String>()
    val bodies = mutableListOf<String>()
    val client =
      HttpClient(
        MockEngine { request ->
          val query = request.url.parameters["query"].orEmpty()
          queries += query
          if (query.startsWith("SELECT")) {
            respond(
              """
              {"kafka_offset":10}
              {"kafka_offset":13}
              """.trimIndent(),
            )
          } else {
            bodies += (request.body as TextContent).text
            respond("", status = HttpStatusCode.OK)
          }
        },
      )
    val store = HttpKafkaClickHouseStore(clickHouseConfig(), client, Json)
    val records = listOf(record(10), record(13))
    val token = kafkaBatchDeduplicationToken(records)

    val persisted =
      store.persistedOffsets(
        table = "hyperliquid_bbo_kafka_staging",
        topic = TOPIC,
        partition = 2,
        firstOffset = 10,
        lastOffset = 13,
      )
    val result = store.insert("hyperliquid_bbo_kafka_staging", records, token)

    assertEquals(setOf(10L, 13L), persisted)
    assertTrue(queries[0].contains("kafka_partition = 2"))
    assertTrue(queries[0].contains("kafka_offset BETWEEN 10 AND 13"))
    assertTrue(queries[1].contains("insert_deduplication_token = '$token'"))
    assertEquals(2, result.rows)
    assertTrue(result.bytes > 0)
    val rows =
      bodies
        .single()
        .lineSequence()
        .map { Json.decodeFromString<JsonObject>(it) }
        .toList()
    assertEquals(listOf(10L, 13L), rows.map { it.getValue("kafka_offset").jsonPrimitive.long })
    assertEquals(listOf(2, 2), rows.map { it.getValue("kafka_partition").jsonPrimitive.int })
    assertEquals(listOf(TOPIC, TOPIC), rows.map { it.getValue("kafka_topic").jsonPrimitive.content })
    store.close()
  }

  @Test
  fun `wraps non-successful clickhouse responses as store failures`() {
    val store =
      HttpKafkaClickHouseStore(
        clickHouseConfig(),
        HttpClient(MockEngine { respond("replica unavailable", status = HttpStatusCode.ServiceUnavailable) }),
        Json,
      )

    val error =
      assertFailsWith<KafkaClickHouseStoreException> {
        store.insert("hyperliquid_bbo_kafka_staging", listOf(record(1)), kafkaBatchDeduplicationToken(listOf(record(1))))
      }

    assertTrue(
      error.cause
        ?.message
        .orEmpty()
        .contains("clickhouse_http_503"),
    )
  }

  private fun record(offset: Long): KafkaClickHouseRecord =
    KafkaClickHouseRecord(
      topic = TOPIC,
      partition = 2,
      offset = offset,
      key = "BTC",
      envelope =
        HyperliquidEnvelope(
          ingestTs = "2026-07-14T12:00:00Z",
          eventTs = "2026-07-14T12:00:00Z",
          network = "mainnet",
          feed = "hyperliquid-mainnet",
          channel = "bbo",
          symbol = "BTC",
          marketType = "perp",
          marketId = "hl:perp:default:BTC",
          dex = null,
          coin = "BTC",
          spotIndex = null,
          seq = offset,
          source = "ws",
          payload = buildJsonObject { put("bid", "100000") },
        ),
    )

  private fun clickHouseConfig(): ClickHouseConfig =
    ClickHouseConfig(
      enabled = true,
      requiredForReadiness = true,
      httpUrl = "http://clickhouse.local:8123",
      database = "torghut",
      username = "torghut",
      password = "",
      batchSize = 1,
      flushMs = 1,
      requestTimeoutMs = 1_000,
      readyMaxAgeMs = 360_000,
      failureHoldMs = 1_000,
      enabledTables = setOf("hyperliquid_bbo"),
    )

  private companion object {
    const val TOPIC = "torghut.hyperliquid.bbo.v1"
  }
}
