package ai.proompteng.dorvud.ws

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class BrokerFeedSettingsTest {
  private val environment =
    mapOf(
      "BAYN_ALPACA_ACCOUNT_ID" to "00000000-0000-4000-8000-000000000001",
      "BAYN_ALPACA_KEY_ID" to "test-key",
      "BAYN_ALPACA_SECRET_KEY" to "test-secret",
      "BAYN_ALPACA_BASE_URL" to "https://paper-api.alpaca.markets",
      "BAYN_ALPACA_PROXY_URL" to "http://bayn-egress-proxy:3128",
      "DORVUD_SOURCE_REVISION" to "a".repeat(40),
      "BAYN_BROKER_NOTIFICATIONS_TOPIC" to "bayn.broker-notifications.v1",
      "KAFKA_BOOTSTRAP" to "kafka:9092",
      "KAFKA_SASL_USER" to "bayn-broker-feed",
      "KAFKA_SASL_PASSWORD" to "test-kafka-password",
      "KAFKA_SECURITY_PROTOCOL" to "SASL_PLAINTEXT",
    )

  @Test
  fun `uses the existing paper destination and proxy with authenticated idempotent publication`() {
    val config = BrokerFeedSettings.fromEnv(environment)
    assertEquals("http://bayn-egress-proxy:3128", config.proxyUrl)
    assertEquals("wss://paper-api.alpaca.markets/stream", config.connection.streamUrl)
    assertEquals("all", config.kafka.acks)
    assertEquals(true, config.kafka.enableIdempotence)
  }

  @Test
  fun `rejects incomplete identity unverified destination or reused Torghut topic`() {
    for ((key, value) in listOf(
      "BAYN_ALPACA_ACCOUNT_ID" to "account-label",
      "BAYN_ALPACA_BASE_URL" to "https://api.alpaca.markets",
      "BAYN_ALPACA_PROXY_URL" to "http://another-proxy:3128",
      "DORVUD_SOURCE_REVISION" to "main",
      "BAYN_BROKER_NOTIFICATIONS_TOPIC" to "torghut.trade-updates.v2",
      "KAFKA_SECURITY_PROTOCOL" to "PLAINTEXT",
    )) {
      assertFailsWith<IllegalArgumentException> { BrokerFeedSettings.fromEnv(environment + (key to value)) }
    }
    assertFailsWith<IllegalArgumentException> { BrokerFeedSettings.fromEnv(environment - "BAYN_ALPACA_SECRET_KEY") }
  }
}
