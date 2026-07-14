package ai.proompteng.dorvud.hyperliquid

import kotlin.test.Test
import kotlin.test.assertEquals

class KafkaClickHouseParityConfigTest {
  @Test
  fun `uses an isolated manual-assignment client and bounded verifier limits`() {
    val config =
      KafkaClickHouseParityConfig.fromEnv(
        mapOf(
          "KAFKA_BOOTSTRAP" to "kafka:9092",
          "KAFKA_SECURITY_PROTOCOL" to "SASL_PLAINTEXT",
          "KAFKA_SASL_USER" to "writer",
          "KAFKA_SASL_PASSWORD" to "secret",
          "CLICKHOUSE_ENABLED" to "true",
          "CLICKHOUSE_ENABLED_TABLES" to "hyperliquid_bbo,hyperliquid_status",
          "CLICKHOUSE_READY_TABLES" to "hyperliquid_bbo,hyperliquid_status",
          "CLICKHOUSE_PARITY_GROUP_ID" to "cutover-parity",
          "CLICKHOUSE_PARITY_OFFSET_QUERY_BATCH_SIZE" to "250",
          "CLICKHOUSE_WRITER_REQUEST_TIMEOUT_MS" to "1000",
          "CLICKHOUSE_PARITY_REQUEST_TIMEOUT_MS" to "90000",
        ),
      )

    assertEquals("cutover-parity", config.kafka.groupId)
    assertEquals("none", config.kafka.autoOffsetReset)
    assertEquals(5_000, config.kafka.maxPollRecords)
    assertEquals(250, config.offsetQueryBatchSize)
    assertEquals(1_000_000, config.maxCompactedRecordsPerPartition)
    assertEquals(90_000, config.clickHouse.requestTimeoutMs)
    assertEquals("hyperliquid_bbo_kafka_staging", config.destinationTable("hyperliquid_bbo"))
  }
}
