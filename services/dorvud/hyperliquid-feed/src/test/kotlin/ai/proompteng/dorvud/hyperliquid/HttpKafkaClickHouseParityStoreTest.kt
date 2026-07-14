package ai.proompteng.dorvud.hyperliquid

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class HttpKafkaClickHouseParityStoreTest {
  @Test
  fun `reads range statistics and exact retained offset counts`() {
    val queries = mutableListOf<String>()
    val client =
      HttpClient(
        MockEngine { request ->
          val query = request.url.parameters["query"].orEmpty()
          queries += query
          if (query.contains("uniqExact")) {
            respond("""{"rows":4,"distinct_offsets":3,"first_offset":10,"last_offset":19}""")
          } else {
            respond(
              """
              {"kafka_offset":10,"rows":2}
              {"kafka_offset":19,"rows":1}
              """.trimIndent(),
            )
          }
        },
      )
    val store = HttpKafkaClickHouseParityStore(clickHouseConfig(), client, Json)
    val snapshot = snapshot()

    val stats = store.rangeStats(snapshot)
    val counts = store.offsetCounts(snapshot, listOf(10, 13, 19))

    assertEquals(4, stats.rows)
    assertEquals(3, stats.distinctOffsets)
    assertEquals(mapOf(10L to 2L, 19L to 1L), counts)
    assertTrue(queries.all { it.contains("kafka_partition = 2") })
    assertTrue(queries[1].contains("kafka_offset IN (10,13,19)"))
    store.close()
  }

  @Test
  fun `preserves null range bounds for an empty partition`() {
    val store =
      HttpKafkaClickHouseParityStore(
        clickHouseConfig(),
        HttpClient(MockEngine { respond("""{"rows":0,"distinct_offsets":0,"first_offset":null,"last_offset":null}""") }),
        Json,
      )

    val stats = store.rangeStats(snapshot())

    assertEquals(null, stats.firstOffset)
    assertEquals(null, stats.lastOffset)
    store.close()
  }

  private fun snapshot(): KafkaPartitionSnapshot =
    KafkaPartitionSnapshot(
      topic = "torghut.hyperliquid.status.v1",
      table = "hyperliquid_status_kafka_staging",
      partition = 2,
      cleanupPolicy = KafkaCleanupPolicy.COMPACT_DELETE,
      beginningOffset = 10,
      highWatermarkExclusive = 20,
    )

  private fun clickHouseConfig(): ClickHouseConfig =
    ClickHouseConfig(
      enabled = true,
      requiredForReadiness = true,
      httpUrl = "http://clickhouse:8123",
      database = "torghut",
      username = "torghut",
      password = "secret",
      batchSize = 100,
      flushMs = 30_000,
      requestTimeoutMs = 10_000,
      readyMaxAgeMs = 360_000,
      failureHoldMs = 1_000,
      enabledTables = setOf("hyperliquid_status"),
    )
}
