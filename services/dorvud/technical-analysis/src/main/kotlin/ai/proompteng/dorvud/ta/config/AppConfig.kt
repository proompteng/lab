package ai.proompteng.dorvud.ta.config

import com.typesafe.config.ConfigFactory
import java.time.Duration

/**
 * Aggregated configuration for the TA service. Values are loaded from Typesafe Config with
 * environment-variable overrides (see reference.conf or application.conf if present).
 */
data class TaServiceConfig(
  val serviceName: String = "torghut-ta",
  val bootstrapServers: String,
  val tradesTopic: String,
  val quotesTopic: String? = null,
  val bars1mTopic: String? = null,
  val microBarsTopic: String,
  val signalsTopic: String,
  val groupId: String = "torghut-ta-service",
  val clientId: String = "torghut-ta-service",
  val securityProtocol: String = "PLAINTEXT",
  val saslMechanism: String? = null,
  val saslUsername: String? = null,
  val saslPassword: String? = null,
  val autoOffsetReset: String = "latest",
  val httpHost: String = "0.0.0.0",
  val httpPort: Int = 8080,
  val vwapWindow: Duration = Duration.ofMinutes(5),
  val realizedVolWindow: Int = 60,
  val gracefulShutdown: Duration = Duration.ofSeconds(15),
)

object ConfigLoader {
  fun load(): TaServiceConfig {
    val cfg = ConfigFactory.load()

    fun cfgString(
      path: String,
      default: String? = null,
    ): String? = if (cfg.hasPath(path)) cfg.getString(path) else default

    fun cfgInt(
      path: String,
      default: Int,
    ): Int = if (cfg.hasPath(path)) cfg.getInt(path) else default

    fun cfgDuration(
      path: String,
      default: Duration,
    ): Duration = if (cfg.hasPath(path)) cfg.getDuration(path) else default

    val bootstrap = envOr("TA_KAFKA_BOOTSTRAP", cfgString("ta.kafka.bootstrap", "localhost:9092"))
    val tradesTopic = envOr("TA_TRADES_TOPIC", cfgString("ta.topics.trades", "torghut.trades.v1"))

    return TaServiceConfig(
      serviceName = envOr("TA_SERVICE_NAME", cfgString("ta.service.name", "torghut-ta"))!!,
      bootstrapServers = bootstrap!!,
      tradesTopic = tradesTopic!!,
      quotesTopic = envOr("TA_QUOTES_TOPIC", cfgString("ta.topics.quotes")),
      bars1mTopic = envOr("TA_BARS1M_TOPIC", cfgString("ta.topics.bars1m")),
      microBarsTopic = envOr("TA_MICROBARS_TOPIC", cfgString("ta.topics.microbars", "torghut.ta.bars.1s.v1"))!!,
      signalsTopic = envOr("TA_SIGNALS_TOPIC", cfgString("ta.topics.signals", "torghut.ta.signals.v1"))!!,
      groupId = envOr("TA_GROUP_ID", cfgString("ta.kafka.groupId", "torghut-ta-service"))!!,
      clientId = envOr("TA_CLIENT_ID", cfgString("ta.kafka.clientId", "torghut-ta-service"))!!,
      securityProtocol = envOr("TA_KAFKA_SECURITY", cfgString("ta.kafka.security", "PLAINTEXT"))!!,
      saslMechanism = envOr("TA_KAFKA_SASL_MECH", cfgString("ta.kafka.sasl.mechanism")),
      saslUsername = envOr("TA_KAFKA_USERNAME", cfgString("ta.kafka.sasl.username")),
      saslPassword = envOr("TA_KAFKA_PASSWORD", cfgString("ta.kafka.sasl.password")),
      autoOffsetReset = envOr("TA_AUTO_OFFSET_RESET", cfgString("ta.kafka.autoOffsetReset", "latest"))!!,
      httpHost = envOr("TA_HTTP_HOST", cfgString("ta.http.host", "0.0.0.0"))!!,
      httpPort = envOr("TA_HTTP_PORT", cfgInt("ta.http.port", 8080)),
      vwapWindow = cfgDuration("ta.indicators.vwapWindow", Duration.ofMinutes(5)),
      realizedVolWindow = cfgInt("ta.indicators.realizedVolWindow", 60),
      gracefulShutdown = cfgDuration("ta.service.shutdown", Duration.ofSeconds(15)),
    )
  }

  private fun envOr(
    key: String,
    fallback: String?,
  ): String? = System.getenv(key) ?: fallback

  private fun envOr(
    key: String,
    fallback: Int,
  ): Int = System.getenv(key)?.toIntOrNull() ?: fallback
}
