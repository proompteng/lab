package ai.proompteng.dorvud.platform

import org.apache.kafka.clients.admin.AdminClientConfig
import org.apache.kafka.clients.consumer.ConsumerConfig
import org.apache.kafka.common.config.SaslConfigs
import org.apache.kafka.common.config.SslConfigs
import org.apache.kafka.common.serialization.StringDeserializer
import kotlin.test.Test
import kotlin.test.assertEquals

class KafkaSettingsTest {
  @Test
  fun `consumer properties require manual commits and preserve security settings`() {
    val properties =
      KafkaConsumerSettings(
        bootstrapServers = "kafka:9092",
        groupId = "test-consumer",
        clientId = "test-consumer-1",
        maxPollRecords = 321,
        maxPollIntervalMs = 600_000,
        sessionTimeoutMs = 45_000,
        heartbeatIntervalMs = 3_000,
        securityProtocol = "SASL_PLAINTEXT",
        auth = KafkaAuth(username = "consumer", password = "secret"),
      ).toProperties()

    assertEquals(false, properties[ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG])
    assertEquals("earliest", properties[ConsumerConfig.AUTO_OFFSET_RESET_CONFIG])
    assertEquals(321, properties[ConsumerConfig.MAX_POLL_RECORDS_CONFIG])
    assertEquals(600_000, properties[ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG])
    assertEquals(StringDeserializer::class.java, properties[ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG])
    assertEquals("SASL_PLAINTEXT", properties["security.protocol"])
    assertEquals("SCRAM-SHA-512", properties[SaslConfigs.SASL_MECHANISM])
    assertEquals("HTTPS", properties[SslConfigs.SSL_ENDPOINT_IDENTIFICATION_ALGORITHM_CONFIG])
  }

  @Test
  fun `admin properties preserve security without consumer-only settings`() {
    val properties =
      KafkaConsumerSettings(
        bootstrapServers = "kafka:9092",
        groupId = "test-consumer",
        clientId = "test-admin",
        securityProtocol = "SASL_PLAINTEXT",
        auth = KafkaAuth(username = "consumer", password = "secret"),
      ).toAdminProperties()

    assertEquals("kafka:9092", properties[AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG])
    assertEquals("test-admin-admin", properties[AdminClientConfig.CLIENT_ID_CONFIG])
    assertEquals(null, properties[ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG])
    assertEquals("SASL_PLAINTEXT", properties["security.protocol"])
    assertEquals("SCRAM-SHA-512", properties[SaslConfigs.SASL_MECHANISM])
  }
}
