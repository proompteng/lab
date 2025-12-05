package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.KafkaAuth
import ai.proompteng.dorvud.platform.KafkaProducerSettings
import ai.proompteng.dorvud.platform.KafkaTls

data class TopicConfig(
  val trades: String,
  val quotes: String,
  val bars1m: String,
  val status: String,
  val tradeUpdates: String?,
)

data class ForwarderConfig(
  val alpacaKeyId: String,
  val alpacaSecretKey: String,
  val alpacaFeed: String,
  val alpacaBaseUrl: String,
  val symbols: List<String>,
  val enableTradeUpdates: Boolean,
  val reconnectBaseMs: Long,
  val reconnectMaxMs: Long,
  val dedupTtlSeconds: Long,
  val dedupMaxEntries: Int,
  val kafka: KafkaProducerSettings,
  val topics: TopicConfig,
  val healthPort: Int = 8080,
  val metricsPort: Int = 9090,
) {
  companion object {
    fun fromEnv(env: Map<String, String> = System.getenv()): ForwarderConfig {
      val symbols = env["SYMBOLS"]?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }
        ?: listOf("NVDA")
      val topics = TopicConfig(
        trades = env["TOPIC_TRADES"] ?: "torghut.nvda.trades.v1",
        quotes = env["TOPIC_QUOTES"] ?: "torghut.nvda.quotes.v1",
        bars1m = env["TOPIC_BARS_1M"] ?: "torghut.nvda.bars.1m.v1",
        status = env["TOPIC_STATUS"] ?: "torghut.nvda.status.v1",
        tradeUpdates = env["TOPIC_TRADE_UPDATES"],
      )

      val kafka = KafkaProducerSettings(
        bootstrapServers = env["KAFKA_BOOTSTRAP"] ?: "kafka-kafka-bootstrap.kafka:9092",
        clientId = env["KAFKA_CLIENT_ID"] ?: "dorvud-ws",
        lingerMs = env["KAFKA_LINGER_MS"]?.toIntOrNull() ?: 30,
        batchSize = env["KAFKA_BATCH_SIZE"]?.toIntOrNull() ?: 32768,
        acks = env["KAFKA_ACKS"] ?: "all",
        compressionType = env["KAFKA_COMPRESSION"] ?: "lz4",
        securityProtocol = env["KAFKA_SECURITY_PROTOCOL"] ?: "SASL_SSL",
        auth = KafkaAuth(
          username = env["KAFKA_SASL_USER"] ?: "dorvud-ws",
          password = env["KAFKA_SASL_PASSWORD"] ?: "changeme",
          mechanism = env["KAFKA_SASL_MECH"] ?: "SCRAM-SHA-512",
        ),
        tls = KafkaTls(
          truststorePath = env["KAFKA_TRUSTSTORE_PATH"],
          truststorePassword = env["KAFKA_TRUSTSTORE_PASSWORD"],
          endpointIdentification = env["KAFKA_SSL_ENDPOINT_IDENTIFICATION"] ?: "HTTPS",
        ),
      )

      return ForwarderConfig(
        alpacaKeyId = env.getValue("ALPACA_KEY_ID"),
        alpacaSecretKey = env.getValue("ALPACA_SECRET_KEY"),
        alpacaFeed = env["ALPACA_FEED"] ?: "iex",
        alpacaBaseUrl = env["ALPACA_BASE_URL"] ?: "https://data.alpaca.markets",
        symbols = symbols,
        enableTradeUpdates = env["ENABLE_TRADE_UPDATES"]?.toBooleanStrictOrNull() ?: false,
        reconnectBaseMs = env["RECONNECT_BASE_MS"]?.toLongOrNull() ?: 500,
        reconnectMaxMs = env["RECONNECT_MAX_MS"]?.toLongOrNull() ?: 30_000,
        dedupTtlSeconds = env["DEDUP_TTL_SEC"]?.toLongOrNull() ?: 5,
        dedupMaxEntries = env["DEDUP_MAX_ENTRIES"]?.toIntOrNull() ?: 10_000,
        kafka = kafka,
        topics = topics,
        healthPort = env["HEALTH_PORT"]?.toIntOrNull() ?: 8080,
        metricsPort = env["METRICS_PORT"]?.toIntOrNull() ?: 9090,
      )
    }
  }
}
