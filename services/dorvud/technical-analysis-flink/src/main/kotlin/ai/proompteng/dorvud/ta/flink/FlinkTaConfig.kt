package ai.proompteng.dorvud.ta.flink

import org.apache.flink.connector.base.DeliveryGuarantee
import java.io.Serializable
import java.time.Duration

data class FlinkTaConfig(
  val bootstrapServers: String,
  val tradesTopic: String,
  val quotesTopic: String?,
  val bars1mTopic: String?,
  val microBarsTopic: String,
  val signalsTopic: String,
  val statusTopic: String?,
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
  val vwapWindow: Duration,
  val realizedVolWindow: Int,
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
) : Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L

    fun fromEnv(): FlinkTaConfig {
      fun env(key: String): String? = System.getenv(key)

      fun env(
        key: String,
        default: String,
      ): String = env(key) ?: default

      fun envInt(
        key: String,
        default: Int,
      ): Int = env(key)?.toIntOrNull() ?: default

      fun envLong(
        key: String,
        default: Long,
      ): Long = env(key)?.toLongOrNull() ?: default

      fun envBool(
        key: String,
        default: Boolean,
      ): Boolean = env(key)?.lowercase()?.let { it in setOf("1", "true", "yes") } ?: default

      fun envDeliveryGuarantee(
        key: String,
        default: DeliveryGuarantee,
      ): DeliveryGuarantee =
        when (env(key)?.trim()?.uppercase()) {
          null -> default
          "EXACTLY_ONCE" -> DeliveryGuarantee.EXACTLY_ONCE
          "AT_LEAST_ONCE" -> DeliveryGuarantee.AT_LEAST_ONCE
          "NONE" -> DeliveryGuarantee.NONE
          else -> default
        }

      val checkpointBase = env("TA_CHECKPOINT_DIR", "s3a://flink-checkpoints/torghut/technical-analysis")
      val clickhouseUrl = env("TA_CLICKHOUSE_URL")?.takeIf { it.isNotBlank() }

      return FlinkTaConfig(
        bootstrapServers = env("TA_KAFKA_BOOTSTRAP", "kafka-kafka-bootstrap.kafka:9092"),
        tradesTopic = env("TA_TRADES_TOPIC", "torghut.trades.v1"),
        quotesTopic = env("TA_QUOTES_TOPIC"),
        bars1mTopic = env("TA_BARS1M_TOPIC"),
        microBarsTopic = env("TA_MICROBARS_TOPIC", "torghut.ta.bars.1s.v1"),
        signalsTopic = env("TA_SIGNALS_TOPIC", "torghut.ta.signals.v1"),
        statusTopic = env("TA_STATUS_TOPIC"),
        groupId = env("TA_GROUP_ID", "torghut-ta-flink"),
        clientId = env("TA_CLIENT_ID", "torghut-ta-flink"),
        securityProtocol = env("TA_KAFKA_SECURITY", "SASL_PLAINTEXT"),
        saslMechanism = env("TA_KAFKA_SASL_MECH", "SCRAM-SHA-512"),
        saslUsername = env("TA_KAFKA_USERNAME", "torghut-ws"),
        saslPassword = env("TA_KAFKA_PASSWORD"),
        autoOffsetReset = env("TA_AUTO_OFFSET_RESET", "latest"),
        checkpointDir = "$checkpointBase/checkpoints",
        savepointDir = env("TA_SAVEPOINT_DIR", "$checkpointBase/savepoints"),
        checkpointIntervalMs = envLong("TA_CHECKPOINT_INTERVAL_MS", 10_000),
        checkpointTimeoutMs = envLong("TA_CHECKPOINT_TIMEOUT_MS", 120_000),
        minPauseBetweenCheckpointsMs = envLong("TA_CHECKPOINT_PAUSE_MS", 5_000),
        maxOutOfOrderMs = envLong("TA_MAX_OUT_OF_ORDER_MS", 2_000),
        parallelism = envInt("TA_PARALLELISM", 1),
        vwapWindow = Duration.ofSeconds(envLong("TA_VWAP_WINDOW_SECONDS", 300)),
        realizedVolWindow = envInt("TA_REALIZED_VOL_WINDOW", 60),
        s3Endpoint = env("TA_S3_ENDPOINT", "http://observability-minio.minio.svc.cluster.local:9000"),
        s3PathStyle = envBool("TA_S3_PATH_STYLE", true),
        s3Secure = envBool("TA_S3_SECURE", false),
        s3AccessKey = env("TA_S3_ACCESS_KEY"),
        s3SecretKey = env("TA_S3_SECRET_KEY"),
        deliveryGuarantee = envDeliveryGuarantee("TA_KAFKA_DELIVERY_GUARANTEE", DeliveryGuarantee.EXACTLY_ONCE),
        transactionTimeoutMs = envLong("TA_KAFKA_TRANSACTION_TIMEOUT_MS", 120_000),
        clickhouseUrl = clickhouseUrl,
        clickhouseUsername = env("TA_CLICKHOUSE_USERNAME", "torghut"),
        clickhousePassword = env("TA_CLICKHOUSE_PASSWORD"),
        clickhouseInsertBatchSize = envInt("TA_CLICKHOUSE_BATCH_SIZE", 500),
        clickhouseInsertFlushMs = envLong("TA_CLICKHOUSE_FLUSH_MS", 1_000),
        clickhouseInsertMaxRetries = envInt("TA_CLICKHOUSE_MAX_RETRIES", 3),
        clickhouseConnectionTimeoutSeconds = envInt("TA_CLICKHOUSE_CONN_TIMEOUT_SECONDS", 30),
      )
    }
  }
}
