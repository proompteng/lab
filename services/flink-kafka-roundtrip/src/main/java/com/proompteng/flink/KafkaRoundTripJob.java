package com.proompteng.flink;

import java.util.Objects;
import java.util.Properties;
import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.serialization.SimpleStringSchema;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;

public class KafkaRoundTripJob {
  public static void main(String[] args) throws Exception {
    final String bootstrapServers = requiredEnv("KAFKA_BOOTSTRAP_SERVERS");
    final String inputTopic = requiredEnv("KAFKA_INPUT_TOPIC");
    final String outputTopic = requiredEnv("KAFKA_OUTPUT_TOPIC");
    final String securityProtocol = envOrDefault("KAFKA_SECURITY_PROTOCOL", "SASL_PLAINTEXT");
    final String saslMechanism = envOrDefault("KAFKA_SASL_MECHANISM", "SCRAM-SHA-512");
    final String saslUsername = requiredEnv("KAFKA_SASL_USERNAME");
    final String saslPassword = requiredEnv("KAFKA_SASL_PASSWORD");

    final Properties kafkaProps = buildKafkaProperties(
        bootstrapServers, securityProtocol, saslMechanism, saslUsername, saslPassword);

    final KafkaSource<String> source =
        KafkaSource.<String>builder()
            .setBootstrapServers(bootstrapServers)
            .setTopics(inputTopic)
            .setGroupId("flink-kafka-roundtrip")
            .setValueOnlyDeserializer(new SimpleStringSchema())
            .setProperties(kafkaProps)
            .build();

    final KafkaSink<String> sink =
        KafkaSink.<String>builder()
            .setBootstrapServers(bootstrapServers)
            .setKafkaProducerConfig(kafkaProps)
            .setRecordSerializer(
                KafkaRecordSerializationSchema.builder()
                    .setTopic(outputTopic)
                    .setValueSerializationSchema(new SimpleStringSchema())
                    .build())
            .build();

    final StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
    env.enableCheckpointing(30_000);

    env.fromSource(source, WatermarkStrategy.noWatermarks(), "kafka-source")
        .name("kafka-source")
        .map(String::toUpperCase)
        .name("uppercase-transform")
        .sinkTo(sink)
        .name("kafka-sink");

    env.execute("flink-kafka-roundtrip");
  }

  private static Properties buildKafkaProperties(
      String bootstrapServers,
      String securityProtocol,
      String saslMechanism,
      String saslUsername,
      String saslPassword) {
    final Properties props = new Properties();
    props.setProperty("bootstrap.servers", bootstrapServers);
    props.setProperty("security.protocol", securityProtocol);
    props.setProperty("sasl.mechanism", saslMechanism);
    props.setProperty(
        "sasl.jaas.config",
        String.format(
            "org.apache.kafka.common.security.scram.ScramLoginModule required username=\"%s\" password=\"%s\";",
            saslUsername, saslPassword));
    props.setProperty("enable.idempotence", "true");
    props.setProperty("max.in.flight.requests.per.connection", "1");
    props.setProperty("acks", "all");
    props.setProperty("transaction.timeout.ms", "60000");
    return props;
  }

  private static String requiredEnv(String key) {
    final String value = System.getenv(key);
    if (value == null || value.isBlank()) {
      throw new IllegalArgumentException("Missing required env var: " + key);
    }
    return value;
  }

  private static String envOrDefault(String key, String defaultValue) {
    return Objects.requireNonNullElse(System.getenv(key), defaultValue);
  }
}
