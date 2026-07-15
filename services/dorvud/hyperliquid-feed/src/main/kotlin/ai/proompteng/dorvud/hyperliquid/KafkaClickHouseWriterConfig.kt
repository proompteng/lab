package ai.proompteng.dorvud.hyperliquid

import ai.proompteng.dorvud.platform.KafkaConsumerSettings

data class KafkaWriterBatchPolicy(
  val batchSize: Int,
  val maxAgeMs: Long,
)

data class KafkaClickHouseWriterConfig(
  val kafka: KafkaConsumerSettings,
  val topicTables: Map<String, String>,
  val destinationSuffix: String,
  val clickHouse: ClickHouseConfig,
  val pollMs: Long,
  val retryInitialMs: Long,
  val retryMaxMs: Long,
  val lagRefreshMs: Long,
  val kafkaOperationTimeoutMs: Long,
  val maxFlushesPerPoll: Int,
  val shutdownFlushTimeoutMs: Long,
  val consumerCloseTimeoutMs: Long,
  val maxBufferedRecordsPerPartition: Int,
  val readinessMaxAgeMs: Long,
  val catchUpMaxPartitionLagRecords: Long,
  val healthPort: Int,
  val metricsPort: Int,
  val batchPolicies: Map<String, KafkaWriterBatchPolicy>,
) {
  init {
    require(topicTables.isNotEmpty()) { "CLICKHOUSE_WRITER_TOPICS must include at least one enabled topic" }
    require(clickHouse.enabled) { "CLICKHOUSE_ENABLED must be true for the Kafka ClickHouse writer" }
    require(destinationSuffix.isEmpty() || destinationSuffix.matches(Regex("_[a-z0-9_]+"))) {
      "CLICKHOUSE_WRITER_DESTINATION_SUFFIX must be empty or a lowercase SQL identifier suffix"
    }
    require(kafka.groupId.isNotBlank()) { "CLICKHOUSE_WRITER_GROUP_ID must not be blank" }
    require(kafka.clientId.isNotBlank()) { "CLICKHOUSE_WRITER_CLIENT_ID must not be blank" }
    require(kafka.autoOffsetReset in setOf("earliest", "latest", "none")) {
      "CLICKHOUSE_WRITER_AUTO_OFFSET_RESET must be earliest, latest, or none"
    }
    require(kafka.heartbeatIntervalMs * 3 <= kafka.sessionTimeoutMs) {
      "CLICKHOUSE_WRITER_HEARTBEAT_INTERVAL_MS must be at most one third of the session timeout"
    }
    require(retryInitialMs <= retryMaxMs) {
      "CLICKHOUSE_WRITER_RETRY_INITIAL_MS must not exceed CLICKHOUSE_WRITER_RETRY_MAX_MS"
    }
    require(maxBufferedRecordsPerPartition >= batchPolicies.values.maxOf { it.batchSize }) {
      "CLICKHOUSE_WRITER_MAX_BUFFERED_RECORDS_PER_PARTITION must cover the largest batch"
    }
    require(maxBufferedRecordsPerPartition >= kafka.maxPollRecords) {
      "CLICKHOUSE_WRITER_MAX_BUFFERED_RECORDS_PER_PARTITION must cover one Kafka poll"
    }
  }

  fun destinationTable(sourceTable: String): String = "$sourceTable$destinationSuffix"

  fun batchPolicy(sourceTable: String): KafkaWriterBatchPolicy =
    checkNotNull(batchPolicies[sourceTable]) { "No Kafka writer batch policy for $sourceTable" }

  companion object {
    private val highThroughputTables =
      setOf(
        "hyperliquid_raw",
        "hyperliquid_trades",
        "hyperliquid_l2_books",
        "hyperliquid_bbo",
      )

    fun fromEnv(env: Map<String, String>? = null): KafkaClickHouseWriterConfig {
      val base = HyperliquidConfig.fromEnv(env)
      val sourceEnv = env ?: System.getenv()
      val allTopicTables = topicTableMapping(base.topics)
      val enabledTopicTables = allTopicTables.filterValues { it in base.clickHouse.enabledTables }
      val configuredTopics = csv(sourceEnv["CLICKHOUSE_WRITER_TOPICS"] ?: enabledTopicTables.keys.joinToString(",")).toSet()
      val unknownTopics = configuredTopics - enabledTopicTables.keys
      require(unknownTopics.isEmpty()) {
        "CLICKHOUSE_WRITER_TOPICS contains unknown or disabled topics: ${unknownTopics.sorted().joinToString(",")}"
      }

      val highThroughputPolicy =
        KafkaWriterBatchPolicy(
          batchSize = intEnv(sourceEnv, "CLICKHOUSE_WRITER_HIGH_THROUGHPUT_BATCH_SIZE", 1_000).coerceIn(1, 5_000),
          maxAgeMs = longEnv(sourceEnv, "CLICKHOUSE_WRITER_HIGH_THROUGHPUT_MAX_AGE_MS", 300_000).coerceIn(1_000, 900_000),
        )
      val sparsePolicy =
        KafkaWriterBatchPolicy(
          batchSize = intEnv(sourceEnv, "CLICKHOUSE_WRITER_SPARSE_BATCH_SIZE", 100).coerceIn(1, 5_000),
          maxAgeMs = longEnv(sourceEnv, "CLICKHOUSE_WRITER_SPARSE_MAX_AGE_MS", 300_000).coerceIn(1_000, 900_000),
        )
      val batchPolicies =
        enabledTopicTables.values
          .toSet()
          .associateWith { table -> if (table in highThroughputTables) highThroughputPolicy else sparsePolicy }
      val largestBatch = batchPolicies.values.maxOf { it.batchSize }
      val maxAgeMs = batchPolicies.values.maxOf { it.maxAgeMs }
      val producerKafka = base.kafka

      return KafkaClickHouseWriterConfig(
        kafka =
          KafkaConsumerSettings(
            bootstrapServers = producerKafka.bootstrapServers,
            groupId = sourceEnv["CLICKHOUSE_WRITER_GROUP_ID"] ?: "torghut-hyperliquid-clickhouse-writer-v1",
            clientId = sourceEnv["CLICKHOUSE_WRITER_CLIENT_ID"] ?: "torghut-hyperliquid-clickhouse-writer",
            maxPollRecords = intEnv(sourceEnv, "CLICKHOUSE_WRITER_MAX_POLL_RECORDS", 1_000).coerceIn(1, 5_000),
            maxPollIntervalMs =
              intEnv(sourceEnv, "CLICKHOUSE_WRITER_MAX_POLL_INTERVAL_MS", 900_000).coerceIn(60_000, 1_800_000),
            sessionTimeoutMs = intEnv(sourceEnv, "CLICKHOUSE_WRITER_SESSION_TIMEOUT_MS", 45_000).coerceIn(6_000, 300_000),
            heartbeatIntervalMs =
              intEnv(sourceEnv, "CLICKHOUSE_WRITER_HEARTBEAT_INTERVAL_MS", 3_000).coerceIn(1_000, 100_000),
            autoOffsetReset = sourceEnv["CLICKHOUSE_WRITER_AUTO_OFFSET_RESET"] ?: "earliest",
            securityProtocol = producerKafka.securityProtocol,
            auth = producerKafka.auth,
            tls = producerKafka.tls,
          ),
        topicTables = enabledTopicTables.filterKeys { it in configuredTopics },
        destinationSuffix = sourceEnv["CLICKHOUSE_WRITER_DESTINATION_SUFFIX"] ?: "_kafka_staging",
        clickHouse =
          base.clickHouse.copy(
            requestTimeoutMs =
              longEnv(sourceEnv, "CLICKHOUSE_WRITER_REQUEST_TIMEOUT_MS", 10_000).coerceIn(1_000, 30_000),
          ),
        pollMs = longEnv(sourceEnv, "CLICKHOUSE_WRITER_POLL_MS", 1_000).coerceIn(10, 10_000),
        retryInitialMs = longEnv(sourceEnv, "CLICKHOUSE_WRITER_RETRY_INITIAL_MS", 1_000).coerceIn(100, 60_000),
        retryMaxMs = longEnv(sourceEnv, "CLICKHOUSE_WRITER_RETRY_MAX_MS", 30_000).coerceIn(1_000, 300_000),
        lagRefreshMs = longEnv(sourceEnv, "CLICKHOUSE_WRITER_LAG_REFRESH_MS", 30_000).coerceIn(1_000, 300_000),
        kafkaOperationTimeoutMs =
          longEnv(sourceEnv, "CLICKHOUSE_WRITER_KAFKA_OPERATION_TIMEOUT_MS", 10_000).coerceIn(1_000, 30_000),
        maxFlushesPerPoll = intEnv(sourceEnv, "CLICKHOUSE_WRITER_MAX_FLUSHES_PER_POLL", 4).coerceIn(1, 100),
        shutdownFlushTimeoutMs =
          longEnv(sourceEnv, "CLICKHOUSE_WRITER_SHUTDOWN_FLUSH_TIMEOUT_MS", 35_000).coerceIn(1_000, 40_000),
        consumerCloseTimeoutMs =
          longEnv(sourceEnv, "CLICKHOUSE_WRITER_CONSUMER_CLOSE_TIMEOUT_MS", 10_000).coerceIn(1_000, 10_000),
        maxBufferedRecordsPerPartition =
          intEnv(sourceEnv, "CLICKHOUSE_WRITER_MAX_BUFFERED_RECORDS_PER_PARTITION", largestBatch * 5)
            .coerceAtMost(100_000),
        readinessMaxAgeMs =
          longEnv(sourceEnv, "CLICKHOUSE_WRITER_READINESS_MAX_AGE_MS", maxAgeMs + 60_000)
            .coerceAtLeast(maxAgeMs + 1_000),
        catchUpMaxPartitionLagRecords =
          longEnv(
            sourceEnv,
            "CLICKHOUSE_WRITER_CATCH_UP_MAX_PARTITION_LAG_RECORDS",
            sourceEnv["CLICKHOUSE_WRITER_READINESS_MAX_PARTITION_LAG_RECORDS"]?.toLongOrNull() ?: 1_000,
          ).coerceIn(0, 1_000_000),
        healthPort = intEnv(sourceEnv, "HEALTH_PORT", 8080),
        metricsPort = intEnv(sourceEnv, "METRICS_PORT", 9090),
        batchPolicies = batchPolicies,
      )
    }

    private fun topicTableMapping(topics: HyperliquidTopics): Map<String, String> =
      mapOf(
        topics.raw to "hyperliquid_raw",
        topics.markets to "hyperliquid_market_catalog",
        topics.trades to "hyperliquid_trades",
        topics.booksL2 to "hyperliquid_l2_books",
        topics.bbo to "hyperliquid_bbo",
        topics.candles to "hyperliquid_candles",
        topics.assetCtx to "hyperliquid_asset_contexts",
        topics.funding to "hyperliquid_funding",
        topics.status to "hyperliquid_status",
      )

    private fun csv(value: String): List<String> = value.split(",").map(String::trim).filter(String::isNotEmpty)

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
