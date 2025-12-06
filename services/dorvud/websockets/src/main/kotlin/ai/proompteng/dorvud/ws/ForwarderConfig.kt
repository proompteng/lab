package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.KafkaAuth
import ai.proompteng.dorvud.platform.KafkaProducerSettings
import ai.proompteng.dorvud.platform.KafkaTls
import io.github.cdimascio.dotenv.dotenv
import java.io.File

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
  val alpacaStreamUrl: String,
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
    fun fromEnv(env: Map<String, String>? = null): ForwarderConfig {
      val mergedEnv = env ?: mergeEnv()

      val symbols = mergedEnv["SYMBOLS"]?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }
        ?: listOf("NVDA")
      val topics = TopicConfig(
        trades = mergedEnv["TOPIC_TRADES"] ?: "torghut.nvda.trades.v1",
        quotes = mergedEnv["TOPIC_QUOTES"] ?: "torghut.nvda.quotes.v1",
        bars1m = mergedEnv["TOPIC_BARS_1M"] ?: "torghut.nvda.bars.1m.v1",
        status = mergedEnv["TOPIC_STATUS"] ?: "torghut.nvda.status.v1",
        tradeUpdates = mergedEnv["TOPIC_TRADE_UPDATES"],
      )

      val kafka = KafkaProducerSettings(
        bootstrapServers = mergedEnv["KAFKA_BOOTSTRAP"] ?: "kafka-kafka-bootstrap.kafka:9092",
        clientId = mergedEnv["KAFKA_CLIENT_ID"] ?: "dorvud-ws",
        lingerMs = mergedEnv["KAFKA_LINGER_MS"]?.toIntOrNull() ?: 30,
        batchSize = mergedEnv["KAFKA_BATCH_SIZE"]?.toIntOrNull() ?: 32768,
        acks = mergedEnv["KAFKA_ACKS"] ?: "all",
        compressionType = mergedEnv["KAFKA_COMPRESSION"] ?: "lz4",
        securityProtocol = mergedEnv["KAFKA_SECURITY_PROTOCOL"] ?: "SASL_SSL",
        auth = KafkaAuth(
          username = mergedEnv["KAFKA_SASL_USER"] ?: "dorvud-ws",
          password = mergedEnv["KAFKA_SASL_PASSWORD"] ?: "changeme",
          mechanism = mergedEnv["KAFKA_SASL_MECH"] ?: "SCRAM-SHA-512",
        ),
        tls = KafkaTls(
          truststorePath = mergedEnv["KAFKA_TRUSTSTORE_PATH"],
          truststorePassword = mergedEnv["KAFKA_TRUSTSTORE_PASSWORD"],
          endpointIdentification = mergedEnv["KAFKA_SSL_ENDPOINT_IDENTIFICATION"] ?: "HTTPS",
        ),
      )

      return ForwarderConfig(
        alpacaKeyId = mergedEnv.getValue("ALPACA_KEY_ID"),
        alpacaSecretKey = mergedEnv.getValue("ALPACA_SECRET_KEY"),
        alpacaFeed = mergedEnv["ALPACA_FEED"] ?: "iex",
        alpacaStreamUrl = mergedEnv["ALPACA_STREAM_URL"] ?: "wss://stream.data.alpaca.markets",
        alpacaBaseUrl = mergedEnv["ALPACA_BASE_URL"] ?: "https://data.alpaca.markets",
        symbols = symbols,
        enableTradeUpdates = mergedEnv["ENABLE_TRADE_UPDATES"]?.toBooleanStrictOrNull() ?: false,
        reconnectBaseMs = mergedEnv["RECONNECT_BASE_MS"]?.toLongOrNull() ?: 500,
        reconnectMaxMs = mergedEnv["RECONNECT_MAX_MS"]?.toLongOrNull() ?: 30_000,
        dedupTtlSeconds = mergedEnv["DEDUP_TTL_SEC"]?.toLongOrNull() ?: 5,
        dedupMaxEntries = mergedEnv["DEDUP_MAX_ENTRIES"]?.toIntOrNull() ?: 10_000,
        kafka = kafka,
        topics = topics,
        healthPort = mergedEnv["HEALTH_PORT"]?.toIntOrNull() ?: 8080,
        metricsPort = mergedEnv["METRICS_PORT"]?.toIntOrNull() ?: 9090,
      )
    }

    private fun mergeEnv(): Map<String, String> {
      val dotEnvEntries = loadDotEnv()
      val merged = dotEnvEntries.toMutableMap()
      merged.putAll(System.getenv())
      return merged
    }

    private fun loadDotEnv(): Map<String, String> {
      val customPath = System.getProperty("dotenv.path") ?: System.getenv("DOTENV_PATH")
      val dotenv = dotenv {
        ignoreIfMissing = true
        ignoreIfMalformed = true
        if (customPath != null) {
          val file = File(customPath)
          directory = file.parent ?: "."
          filename = file.name
        }
      }

      return dotenv.entries().associate { it.key to it.value }
    }
  }
}
