package ai.proompteng.dorvud.hyperliquid

import ai.proompteng.dorvud.platform.toProperties
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class KafkaClickHouseWriterConfigTest {
  @Test
  fun `builds partition-scoped writer policies for enabled topics`() {
    val config = KafkaClickHouseWriterConfig.fromEnv(baseEnv())

    assertEquals("torghut-hyperliquid-clickhouse-writer-v1", config.kafka.groupId)
    assertEquals(false, config.kafka.toProperties()["enable.auto.commit"])
    assertEquals("_kafka_staging", config.destinationSuffix)
    assertEquals(1_000, config.batchPolicy("hyperliquid_bbo").batchSize)
    assertEquals(100, config.batchPolicy("hyperliquid_candles").batchSize)
    assertEquals(300_000, config.batchPolicy("hyperliquid_bbo").maxAgeMs)
    assertEquals(360_000, config.readinessMaxAgeMs)
    assertEquals(1_000, config.catchUpMaxPartitionLagRecords)
    assertEquals(10_000, config.clickHouse.requestTimeoutMs)
    assertEquals(10_000, config.kafkaOperationTimeoutMs)
    assertEquals(
      setOf("torghut.hyperliquid.bbo.v1", "torghut.hyperliquid.candles.v1"),
      config.topicTables.keys,
    )
  }

  @Test
  fun `accepts the legacy readiness lag key during rollout`() {
    val config =
      KafkaClickHouseWriterConfig.fromEnv(
        baseEnv() + ("CLICKHOUSE_WRITER_READINESS_MAX_PARTITION_LAG_RECORDS" to "2500"),
      )

    assertEquals(2_500, config.catchUpMaxPartitionLagRecords)
  }

  @Test
  fun `rejects a topic outside the enabled clickhouse table set`() {
    val error =
      assertFailsWith<IllegalArgumentException> {
        KafkaClickHouseWriterConfig.fromEnv(
          baseEnv() + ("CLICKHOUSE_WRITER_TOPICS" to "torghut.hyperliquid.raw.v1"),
        )
      }

    assertTrue(error.message.orEmpty().contains("unknown or disabled"))
  }

  @Test
  fun `requires buffer capacity to cover the largest batch`() {
    val error =
      assertFailsWith<IllegalArgumentException> {
        KafkaClickHouseWriterConfig.fromEnv(
          baseEnv() +
            mapOf(
              "CLICKHOUSE_WRITER_HIGH_THROUGHPUT_BATCH_SIZE" to "1000",
              "CLICKHOUSE_WRITER_MAX_BUFFERED_RECORDS_PER_PARTITION" to "100",
            ),
        )
      }

    assertTrue(error.message.orEmpty().contains("largest batch"))
  }

  private fun baseEnv(): Map<String, String> =
    mapOf(
      "KAFKA_BOOTSTRAP" to "kafka:9092",
      "KAFKA_SECURITY_PROTOCOL" to "SASL_PLAINTEXT",
      "KAFKA_SASL_USER" to "writer",
      "KAFKA_SASL_PASSWORD" to "secret",
      "CLICKHOUSE_ENABLED" to "true",
      "CLICKHOUSE_ENABLED_TABLES" to "hyperliquid_bbo,hyperliquid_candles",
      "CLICKHOUSE_READY_TABLES" to "hyperliquid_bbo,hyperliquid_candles",
    )
}
