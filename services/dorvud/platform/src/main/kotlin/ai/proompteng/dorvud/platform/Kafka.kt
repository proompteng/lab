package ai.proompteng.dorvud.platform

import java.util.Properties
import org.apache.kafka.clients.producer.KafkaProducer
import org.apache.kafka.clients.producer.ProducerConfig
import org.apache.kafka.common.config.SaslConfigs
import org.apache.kafka.common.config.SslConfigs
import org.apache.kafka.common.serialization.StringSerializer

data class KafkaAuth(
  val username: String,
  val password: String,
  val mechanism: String = "SCRAM-SHA-512",
)

data class KafkaTls(
  val truststorePath: String? = null,
  val truststorePassword: String? = null,
  val endpointIdentification: String = "HTTPS",
)

data class KafkaProducerSettings(
  val bootstrapServers: String,
  val clientId: String = "dorvud-ws",
  val lingerMs: Int = 30,
  val batchSize: Int = 32768,
  val acks: String = "all",
  val enableIdempotence: Boolean = true,
  val compressionType: String = "lz4",
  val securityProtocol: String = "SASL_SSL",
  val auth: KafkaAuth,
  val tls: KafkaTls = KafkaTls(),
)

fun KafkaProducerSettings.toProperties(): Properties = Properties().also { props ->
  props[ProducerConfig.BOOTSTRAP_SERVERS_CONFIG] = bootstrapServers
  props[ProducerConfig.CLIENT_ID_CONFIG] = clientId
  props[ProducerConfig.ACKS_CONFIG] = acks
  props[ProducerConfig.LINGER_MS_CONFIG] = lingerMs
  props[ProducerConfig.BATCH_SIZE_CONFIG] = batchSize
  props[ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG] = enableIdempotence
  props[ProducerConfig.COMPRESSION_TYPE_CONFIG] = compressionType
  props[ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION] = 5
  props[ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG] = StringSerializer::class.java
  props[ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG] = StringSerializer::class.java

  props["security.protocol"] = securityProtocol
  props[SaslConfigs.SASL_MECHANISM] = auth.mechanism
  props[SaslConfigs.SASL_JAAS_CONFIG] =
    "org.apache.kafka.common.security.scram.ScramLoginModule required username=\"${auth.username}\" password=\"${auth.password}\";"
  props[SslConfigs.SSL_ENDPOINT_IDENTIFICATION_ALGORITHM_CONFIG] = tls.endpointIdentification
  tls.truststorePath?.let { props[SslConfigs.SSL_TRUSTSTORE_LOCATION_CONFIG] = it }
  tls.truststorePassword?.let { props[SslConfigs.SSL_TRUSTSTORE_PASSWORD_CONFIG] = it }
}

fun buildProducer(settings: KafkaProducerSettings): KafkaProducer<String, String> =
  KafkaProducer(settings.toProperties())
