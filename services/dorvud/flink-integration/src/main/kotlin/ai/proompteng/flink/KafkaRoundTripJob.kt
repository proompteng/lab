package ai.proompteng.flink

import java.util.Properties
import org.apache.flink.api.common.eventtime.WatermarkStrategy
import org.apache.flink.api.common.serialization.SimpleStringSchema
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema
import org.apache.flink.connector.kafka.sink.KafkaSink
import org.apache.flink.connector.kafka.source.KafkaSource
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment

object KafkaRoundTripJob {
  @JvmStatic
  fun main(args: Array<String>) {
    val bootstrapServers = requiredEnv("KAFKA_BOOTSTRAP_SERVERS")
    val inputTopic = requiredEnv("KAFKA_INPUT_TOPIC")
    val outputTopic = requiredEnv("KAFKA_OUTPUT_TOPIC")
    val securityProtocol = envOrDefault("KAFKA_SECURITY_PROTOCOL", "SASL_PLAINTEXT")
    val saslMechanism = envOrDefault("KAFKA_SASL_MECHANISM", "SCRAM-SHA-512")
    val saslUsername = requiredEnv("KAFKA_SASL_USERNAME")
    val saslPassword = requiredEnv("KAFKA_SASL_PASSWORD")

    val kafkaProps = buildKafkaProperties(
      bootstrapServers = bootstrapServers,
      securityProtocol = securityProtocol,
      saslMechanism = saslMechanism,
      saslUsername = saslUsername,
      saslPassword = saslPassword,
    )

    val source = KafkaSource.builder<String>()
      .setBootstrapServers(bootstrapServers)
      .setTopics(inputTopic)
      .setGroupId("flink-kafka-roundtrip")
      .setValueOnlyDeserializer(SimpleStringSchema())
      .setProperties(kafkaProps)
      .build()

    val sink = KafkaSink.builder<String>()
      .setBootstrapServers(bootstrapServers)
      .setKafkaProducerConfig(kafkaProps)
      .setRecordSerializer(
        KafkaRecordSerializationSchema.builder<String>()
          .setTopic(outputTopic)
          .setValueSerializationSchema(SimpleStringSchema())
          .build(),
      )
      .build()

    val env = StreamExecutionEnvironment.getExecutionEnvironment()
    env.enableCheckpointing(30_000)

    env.fromSource(source, WatermarkStrategy.noWatermarks(), "kafka-source")
      .name("kafka-source")
      .map { value -> value.uppercase() }
      .name("uppercase-transform")
      .sinkTo(sink)
      .name("kafka-sink")

    env.execute("flink-kafka-roundtrip")
  }

  private fun buildKafkaProperties(
    bootstrapServers: String,
    securityProtocol: String,
    saslMechanism: String,
    saslUsername: String,
    saslPassword: String,
  ): Properties {
    val props = Properties()
    props["bootstrap.servers"] = bootstrapServers
    props["security.protocol"] = securityProtocol
    props["sasl.mechanism"] = saslMechanism
    props["sasl.jaas.config"] =
      "org.apache.kafka.common.security.scram.ScramLoginModule required username=\"$saslUsername\" password=\"$saslPassword\";"
    props["enable.idempotence"] = "true"
    props["max.in.flight.requests.per.connection"] = "1"
    props["acks"] = "all"
    props["transaction.timeout.ms"] = "60000"
    return props
  }

  private fun requiredEnv(key: String): String = System.getenv(key)?.takeIf { it.isNotBlank() }
    ?: error("Missing required env var: $key")

  private fun envOrDefault(key: String, defaultValue: String): String = System.getenv(key)?.takeIf { it.isNotBlank() }
    ?: defaultValue
}
