package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.KafkaAuth
import ai.proompteng.dorvud.platform.KafkaProducerSettings
import java.net.URI
import java.util.UUID

internal class BrokerFeedSettings(
  val connection: BrokerFeedConnection,
  val topic: String,
  val kafka: KafkaProducerSettings,
  val proxyUrl: String,
) {
  companion object {
    fun fromEnv(env: Map<String, String>): BrokerFeedSettings {
      fun required(name: String): String = requireNotNull(env[name]?.takeIf { it.isNotBlank() }) { "$name is required" }
      val accountId = required("BAYN_ALPACA_ACCOUNT_ID")
      require(UUID.fromString(accountId).toString() == accountId) { "broker account ID must be canonical" }
      require(required("BAYN_ALPACA_BASE_URL") == "https://paper-api.alpaca.markets") {
        "the verified broker feed requires the existing PAPER destination"
      }
      val revision = required("DORVUD_SOURCE_REVISION")
      require(revision.matches(Regex("[a-f0-9]{40}"))) { "broker feed source revision must be a Git commit" }
      val topic = required("BAYN_BROKER_NOTIFICATIONS_TOPIC")
      require(topic.matches(Regex("bayn\\.broker-notifications\\.v1"))) { "broker notifications require the isolated Bayn topic" }
      val securityProtocol = required("KAFKA_SECURITY_PROTOCOL")
      require(securityProtocol in setOf("SASL_SSL", "SASL_PLAINTEXT")) { "broker notifications require Kafka authentication" }
      val proxyUrl = required("BAYN_ALPACA_PROXY_URL")
      val proxy = URI(proxyUrl)
      require(
        proxy.scheme == "http" && proxy.host == "bayn-egress-proxy" && proxy.port == 3128 &&
          proxy.rawUserInfo == null && proxy.rawQuery == null && proxy.rawFragment == null && proxy.path.isEmpty(),
      ) { "broker feed requires the existing Bayn egress proxy" }
      return BrokerFeedSettings(
        BrokerFeedConnection(
          accountId = accountId,
          keyId = required("BAYN_ALPACA_KEY_ID"),
          secretKey = required("BAYN_ALPACA_SECRET_KEY"),
          sourceRevision = revision,
        ),
        topic,
        KafkaProducerSettings(
          bootstrapServers = required("KAFKA_BOOTSTRAP"),
          clientId = "bayn-broker-feed",
          securityProtocol = securityProtocol,
          auth = KafkaAuth(required("KAFKA_SASL_USER"), required("KAFKA_SASL_PASSWORD")),
        ),
        proxyUrl,
      )
    }
  }
}
