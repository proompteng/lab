package ai.proompteng.dorvud.hyperliquid

import ai.proompteng.dorvud.platform.KafkaConsumerSettings

internal data class KafkaClickHouseParityConfig(
  val kafka: KafkaConsumerSettings,
  val topicTables: Map<String, String>,
  val destinationSuffix: String,
  val clickHouse: ClickHouseConfig,
  val operationTimeoutMs: Long,
  val pollTimeoutMs: Long,
  val maxIdlePolls: Int,
  val maxCompactedRecordsPerPartition: Int,
  val offsetQueryBatchSize: Int,
  val maxRuntimeMs: Long,
) {
  init {
    require(topicTables.isNotEmpty()) { "Kafka ClickHouse parity requires at least one topic" }
    require(operationTimeoutMs > 0) { "CLICKHOUSE_PARITY_OPERATION_TIMEOUT_MS must be positive" }
    require(pollTimeoutMs > 0) { "CLICKHOUSE_PARITY_POLL_TIMEOUT_MS must be positive" }
    require(maxIdlePolls > 0) { "CLICKHOUSE_PARITY_MAX_IDLE_POLLS must be positive" }
    require(maxCompactedRecordsPerPartition > 0) {
      "CLICKHOUSE_PARITY_MAX_COMPACTED_RECORDS_PER_PARTITION must be positive"
    }
    require(offsetQueryBatchSize in 1..5_000) {
      "CLICKHOUSE_PARITY_OFFSET_QUERY_BATCH_SIZE must be within 1..5000"
    }
    require(maxRuntimeMs >= operationTimeoutMs) {
      "CLICKHOUSE_PARITY_MAX_RUNTIME_MS must cover the operation timeout"
    }
  }

  fun destinationTable(sourceTable: String): String = "$sourceTable$destinationSuffix"

  companion object {
    fun fromEnv(env: Map<String, String>? = null): KafkaClickHouseParityConfig {
      val sourceEnv = env ?: System.getenv()
      val writer = KafkaClickHouseWriterConfig.fromEnv(sourceEnv)
      return KafkaClickHouseParityConfig(
        kafka =
          writer.kafka.copy(
            groupId =
              sourceEnv["CLICKHOUSE_PARITY_GROUP_ID"]
                ?: "torghut-hyperliquid-clickhouse-parity-v1",
            clientId =
              sourceEnv["CLICKHOUSE_PARITY_CLIENT_ID"]
                ?: "torghut-hyperliquid-clickhouse-parity",
            maxPollRecords =
              intEnv(sourceEnv, "CLICKHOUSE_PARITY_MAX_POLL_RECORDS", 5_000).coerceIn(1, 5_000),
            autoOffsetReset = "none",
          ),
        topicTables = writer.topicTables,
        destinationSuffix = writer.destinationSuffix,
        clickHouse =
          writer.clickHouse.copy(
            requestTimeoutMs =
              longEnv(sourceEnv, "CLICKHOUSE_PARITY_REQUEST_TIMEOUT_MS", 120_000).coerceIn(5_000, 300_000),
          ),
        operationTimeoutMs =
          longEnv(sourceEnv, "CLICKHOUSE_PARITY_OPERATION_TIMEOUT_MS", 30_000).coerceIn(1_000, 120_000),
        pollTimeoutMs =
          longEnv(sourceEnv, "CLICKHOUSE_PARITY_POLL_TIMEOUT_MS", 1_000).coerceIn(100, 10_000),
        maxIdlePolls =
          intEnv(sourceEnv, "CLICKHOUSE_PARITY_MAX_IDLE_POLLS", 30).coerceIn(1, 300),
        maxCompactedRecordsPerPartition =
          intEnv(sourceEnv, "CLICKHOUSE_PARITY_MAX_COMPACTED_RECORDS_PER_PARTITION", 1_000_000)
            .coerceIn(1, 5_000_000),
        offsetQueryBatchSize =
          intEnv(sourceEnv, "CLICKHOUSE_PARITY_OFFSET_QUERY_BATCH_SIZE", 1_000).coerceIn(1, 5_000),
        maxRuntimeMs =
          longEnv(sourceEnv, "CLICKHOUSE_PARITY_MAX_RUNTIME_MS", 1_200_000).coerceIn(60_000, 1_800_000),
      )
    }

    private fun intEnv(
      env: Map<String, String>,
      name: String,
      default: Int,
    ): Int = env[name]?.toIntOrNull() ?: default

    private fun longEnv(
      env: Map<String, String>,
      name: String,
      default: Long,
    ): Long = env[name]?.toLongOrNull() ?: default
  }
}
