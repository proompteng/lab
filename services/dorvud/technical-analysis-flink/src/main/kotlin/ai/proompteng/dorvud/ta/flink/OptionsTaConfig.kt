package ai.proompteng.dorvud.ta.flink

import org.apache.flink.connector.base.DeliveryGuarantee
import java.io.Serializable

data class OptionsTaConfig(
  val bootstrapServers: String,
  val tradesTopic: String,
  val quotesTopic: String,
  val snapshotsTopic: String,
  val contractBarsTopic: String,
  val contractFeaturesTopic: String,
  val surfaceFeaturesTopic: String,
  val statusTopic: String,
  val groupId: String,
  val clientId: String,
  val securityProtocol: String,
  val saslMechanism: String?,
  val saslUsername: String?,
  val saslPassword: String?,
  val autoOffsetReset: String,
  val checkpointDir: String,
  val savepointDir: String,
  val checkpointIntervalMs: Long,
  val checkpointTimeoutMs: Long,
  val minPauseBetweenCheckpointsMs: Long,
  val maxOutOfOrderMs: Long,
  val parallelism: Int,
  val quoteStaleAfterMs: Long,
  val snapshotStaleAfterMs: Long,
  val watermarkLagTargetMs: Long,
  val s3Endpoint: String,
  val s3PathStyle: Boolean,
  val s3Secure: Boolean,
  val s3AccessKey: String?,
  val s3SecretKey: String?,
  val deliveryGuarantee: DeliveryGuarantee,
  val transactionTimeoutMs: Long,
  val clickhouseUrl: String?,
  val clickhouseUsername: String?,
  val clickhousePassword: String?,
  val clickhouseInsertBatchSize: Int,
  val clickhouseInsertFlushMs: Long,
  val clickhouseInsertMaxRetries: Int,
  val clickhouseConnectionTimeoutSeconds: Int,
  val clickhouseSchemaInitMaxRetries: Int,
  val clickhouseSchemaInitRetryDelayMs: Long,
  val clickhouseSchemaInitStrict: Boolean,
) : Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L

    fun fromEnv(): OptionsTaConfig {
      fun env(key: String): String? = System.getenv(key)

      fun envEither(
        preferred: String,
        fallback: String? = null,
        default: String? = null,
      ): String? = env(preferred) ?: fallback?.let(::env) ?: default

      fun envInt(
        preferred: String,
        fallback: String? = null,
        default: Int,
      ): Int = envEither(preferred, fallback)?.toIntOrNull() ?: default

      fun envLong(
        preferred: String,
        fallback: String? = null,
        default: Long,
      ): Long = envEither(preferred, fallback)?.toLongOrNull() ?: default

      fun envBool(
        preferred: String,
        fallback: String? = null,
        default: Boolean,
      ): Boolean = envEither(preferred, fallback)?.lowercase()?.let { it in setOf("1", "true", "yes") } ?: default

      fun envDeliveryGuarantee(
        preferred: String,
        fallback: String? = null,
        default: DeliveryGuarantee,
      ): DeliveryGuarantee =
        when (envEither(preferred, fallback)?.trim()?.uppercase()) {
          null -> default
          "EXACTLY_ONCE" -> DeliveryGuarantee.EXACTLY_ONCE
          "AT_LEAST_ONCE" -> DeliveryGuarantee.AT_LEAST_ONCE
          "NONE" -> DeliveryGuarantee.NONE
          else -> default
        }

      val checkpointBase =
        envEither(
          "OPTIONS_TA_CHECKPOINT_DIR",
          "TA_CHECKPOINT_DIR",
          "s3a://flink-checkpoints/torghut/options-technical-analysis",
        )!!
      val clickhouseUrl = envEither("OPTIONS_TA_CLICKHOUSE_URL", "TA_CLICKHOUSE_URL")

      return OptionsTaConfig(
        bootstrapServers = envEither("OPTIONS_TA_KAFKA_BOOTSTRAP", "TA_KAFKA_BOOTSTRAP", "kafka-kafka-bootstrap.kafka:9092")!!,
        tradesTopic = envEither("TOPIC_OPTIONS_TRADES", default = "torghut.options.trades.v1")!!,
        quotesTopic = envEither("TOPIC_OPTIONS_QUOTES", default = "torghut.options.quotes.v1")!!,
        snapshotsTopic = envEither("TOPIC_OPTIONS_SNAPSHOTS", default = "torghut.options.snapshots.v1")!!,
        contractBarsTopic =
          envEither("OPTIONS_TA_CONTRACT_BARS_TOPIC", default = "torghut.options.ta.contract-bars.1s.v1")!!,
        contractFeaturesTopic =
          envEither("OPTIONS_TA_CONTRACT_FEATURES_TOPIC", default = "torghut.options.ta.contract-features.v1")!!,
        surfaceFeaturesTopic =
          envEither("OPTIONS_TA_SURFACE_FEATURES_TOPIC", default = "torghut.options.ta.surface-features.v1")!!,
        statusTopic = envEither("OPTIONS_TA_STATUS_TOPIC", default = "torghut.options.ta.status.v1")!!,
        groupId = envEither("OPTIONS_TA_GROUP_ID", "TA_GROUP_ID", "torghut-options-ta-flink")!!,
        clientId = envEither("OPTIONS_TA_CLIENT_ID", "TA_CLIENT_ID", "torghut-options-ta")!!,
        securityProtocol = envEither("OPTIONS_TA_KAFKA_SECURITY", "TA_KAFKA_SECURITY", "SASL_PLAINTEXT")!!,
        saslMechanism = envEither("OPTIONS_TA_KAFKA_SASL_MECH", "TA_KAFKA_SASL_MECH", "SCRAM-SHA-512"),
        saslUsername = envEither("OPTIONS_TA_KAFKA_USERNAME", "TA_KAFKA_USERNAME", "torghut-options"),
        saslPassword = envEither("OPTIONS_TA_KAFKA_PASSWORD", "TA_KAFKA_PASSWORD"),
        autoOffsetReset = envEither("OPTIONS_TA_AUTO_OFFSET_RESET", "TA_AUTO_OFFSET_RESET", "latest")!!,
        checkpointDir = "$checkpointBase/checkpoints",
        savepointDir = envEither("OPTIONS_TA_SAVEPOINT_DIR", "TA_SAVEPOINT_DIR", "$checkpointBase/savepoints")!!,
        checkpointIntervalMs = envLong("OPTIONS_TA_CHECKPOINT_INTERVAL_MS", "TA_CHECKPOINT_INTERVAL_MS", 60_000),
        checkpointTimeoutMs = envLong("OPTIONS_TA_CHECKPOINT_TIMEOUT_MS", "TA_CHECKPOINT_TIMEOUT_MS", 300_000),
        minPauseBetweenCheckpointsMs = envLong("OPTIONS_TA_CHECKPOINT_PAUSE_MS", "TA_CHECKPOINT_PAUSE_MS", 10_000),
        maxOutOfOrderMs = envLong("OPTIONS_TA_MAX_OUT_OF_ORDER_MS", "TA_MAX_OUT_OF_ORDER_MS", 2_000),
        parallelism = envInt("OPTIONS_TA_PARALLELISM", "TA_PARALLELISM", 4),
        quoteStaleAfterMs =
          (envEither("OPTIONS_TA_QUOTE_STALE_AFTER_SEC", "OPTIONS_SLO_HOT_SNAPSHOT_FRESHNESS_SEC", "30")!!.toLong()) * 1_000,
        snapshotStaleAfterMs =
          (envEither("OPTIONS_TA_SNAPSHOT_STALE_AFTER_SEC", "OPTIONS_SLO_HOT_SNAPSHOT_FRESHNESS_SEC", "30")!!.toLong()) * 1_000,
        watermarkLagTargetMs = envLong("OPTIONS_SLO_TA_WATERMARK_LAG_SEC", default = 30) * 1_000,
        s3Endpoint = envEither("OPTIONS_TA_S3_ENDPOINT", "TA_S3_ENDPOINT", "http://rook-ceph-rgw-objectstore.rook-ceph.svc:80")!!,
        s3PathStyle = envBool("OPTIONS_TA_S3_PATH_STYLE", "TA_S3_PATH_STYLE", true),
        s3Secure = envBool("OPTIONS_TA_S3_SECURE", "TA_S3_SECURE", false),
        s3AccessKey = envEither("OPTIONS_TA_S3_ACCESS_KEY", "TA_S3_ACCESS_KEY"),
        s3SecretKey = envEither("OPTIONS_TA_S3_SECRET_KEY", "TA_S3_SECRET_KEY"),
        deliveryGuarantee =
          envDeliveryGuarantee("OPTIONS_TA_KAFKA_DELIVERY_GUARANTEE", "TA_KAFKA_DELIVERY_GUARANTEE", DeliveryGuarantee.EXACTLY_ONCE),
        transactionTimeoutMs = envLong("OPTIONS_TA_KAFKA_TRANSACTION_TIMEOUT_MS", "TA_KAFKA_TRANSACTION_TIMEOUT_MS", 120_000),
        clickhouseUrl = clickhouseUrl,
        clickhouseUsername = envEither("OPTIONS_TA_CLICKHOUSE_USERNAME", "TA_CLICKHOUSE_USERNAME", "torghut"),
        clickhousePassword = envEither("OPTIONS_TA_CLICKHOUSE_PASSWORD", "TA_CLICKHOUSE_PASSWORD"),
        clickhouseInsertBatchSize = envInt("OPTIONS_TA_CLICKHOUSE_BATCH_SIZE", "TA_CLICKHOUSE_BATCH_SIZE", 500),
        clickhouseInsertFlushMs = envLong("OPTIONS_TA_CLICKHOUSE_FLUSH_MS", "TA_CLICKHOUSE_FLUSH_MS", 1_000),
        clickhouseInsertMaxRetries = envInt("OPTIONS_TA_CLICKHOUSE_MAX_RETRIES", "TA_CLICKHOUSE_MAX_RETRIES", 3),
        clickhouseConnectionTimeoutSeconds =
          envInt("OPTIONS_TA_CLICKHOUSE_CONN_TIMEOUT_SECONDS", "TA_CLICKHOUSE_CONN_TIMEOUT_SECONDS", 30),
        clickhouseSchemaInitMaxRetries =
          envInt("OPTIONS_TA_CLICKHOUSE_SCHEMA_INIT_MAX_RETRIES", "TA_CLICKHOUSE_SCHEMA_INIT_MAX_RETRIES", 180),
        clickhouseSchemaInitRetryDelayMs =
          envLong("OPTIONS_TA_CLICKHOUSE_SCHEMA_INIT_RETRY_DELAY_MS", "TA_CLICKHOUSE_SCHEMA_INIT_RETRY_DELAY_MS", 2_000),
        clickhouseSchemaInitStrict =
          envBool("OPTIONS_TA_CLICKHOUSE_SCHEMA_INIT_STRICT", "TA_CLICKHOUSE_SCHEMA_INIT_STRICT", true),
      )
    }
  }
}
