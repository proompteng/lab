package ai.proompteng.flinkta;

import ai.proompteng.flinkta.functions.MicroBarAggregator;
import ai.proompteng.flinkta.functions.MicroBarWindowFunction;
import ai.proompteng.flinkta.functions.QuoteDedupFunction;
import ai.proompteng.flinkta.functions.SignalProcessFunction;
import ai.proompteng.flinkta.functions.TradeDedupFunction;
import ai.proompteng.flinkta.model.Quote;
import ai.proompteng.flinkta.model.TaBar;
import ai.proompteng.flinkta.model.TaSignal;
import ai.proompteng.flinkta.model.Trade;
import ai.proompteng.flinkta.serialization.JsonSerde;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Properties;
import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.restartstrategy.RestartStrategies;
import org.apache.flink.api.common.time.Time;
import org.apache.flink.connector.base.DeliveryGuarantee;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.contrib.streaming.state.EmbeddedRocksDBStateBackend;
import org.apache.flink.streaming.api.CheckpointingMode;
import org.apache.flink.streaming.api.environment.CheckpointConfig;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.windowing.assigners.TumblingEventTimeWindows;

public class FlinkTaJob {
  public static void main(String[] args) throws Exception {
    JobConfig config = JobConfig.fromEnv();

    StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
    env.setParallelism(config.parallelism);
    env.setRestartStrategy(RestartStrategies.failureRateRestart(
        3, Time.hours(1), Time.seconds(10)));

    configureCheckpointing(env, config);

    Properties kafkaConsumerProps = KafkaProps.consumer(config);
    Properties kafkaProducerProps = KafkaProps.producer(config);

    WatermarkStrategy<Trade> tradeWm = WatermarkStrategy
        .<Trade>forBoundedOutOfOrderness(Duration.ofSeconds(config.allowedLatenessSeconds))
        .withTimestampAssigner((event, ts) -> event.getEventTs());

    WatermarkStrategy<Quote> quoteWm = WatermarkStrategy
        .<Quote>forBoundedOutOfOrderness(Duration.ofSeconds(config.allowedLatenessSeconds))
        .withTimestampAssigner((event, ts) -> event.getEventTs());

    KafkaSource<Trade> tradesSource = KafkaSource.<Trade>builder()
        .setBootstrapServers(config.bootstrapServers)
        .setTopics(config.tradesTopic)
        .setGroupId("flink-ta-trades")
        .setValueOnlyDeserializer(JsonSerde.deserializer(Trade.class))
        .setProperties(kafkaConsumerProps)
        .setStartingOffsets(OffsetsInitializer.committedOffsets())
        .build();

    KafkaSource<Quote> quotesSource = KafkaSource.<Quote>builder()
        .setBootstrapServers(config.bootstrapServers)
        .setTopics(config.quotesTopic)
        .setGroupId("flink-ta-quotes")
        .setValueOnlyDeserializer(JsonSerde.deserializer(Quote.class))
        .setProperties(kafkaConsumerProps)
        .setStartingOffsets(OffsetsInitializer.committedOffsets())
        .build();

    var trades = env.fromSource(tradesSource, tradeWm, "alpaca-trades")
        .name("alpaca-trades")
        .keyBy(Trade::getSymbol)
        .process(new TradeDedupFunction(config.dedupeTtlMinutes))
        .name("trade-dedupe");

    var quotes = env.fromSource(quotesSource, quoteWm, "alpaca-quotes")
        .name("alpaca-quotes")
        .keyBy(Quote::getSymbol)
        .process(new QuoteDedupFunction(config.dedupeTtlMinutes))
        .name("quote-dedupe");

    var bars = trades
        .keyBy(Trade::getSymbol)
        .window(TumblingEventTimeWindows.of(org.apache.flink.streaming.api.windowing.time.Time.seconds(1)))
        .allowedLateness(org.apache.flink.streaming.api.windowing.time.Time.seconds(config.allowedLatenessSeconds))
        .aggregate(new MicroBarAggregator(), new MicroBarWindowFunction())
        .name("micro-bars");

    var signals = bars
        .keyBy(TaBar::getSymbol)
        .connect(quotes.keyBy(Quote::getSymbol))
        .process(new SignalProcessFunction())
        .name("signals");

    KafkaSink<TaBar> barSink = KafkaSink.<TaBar>builder()
        .setBootstrapServers(config.bootstrapServers)
        .setKafkaProducerConfig(kafkaProducerProps)
        .setRecordSerializer(KafkaRecordSerializationSchema.<TaBar>builder()
            .setTopic(config.taBarsTopic)
            .setKeySerializationSchema((TaBar bar) -> bar.getSymbol() == null
                ? null
                : bar.getSymbol().getBytes(StandardCharsets.UTF_8))
            .setValueSerializationSchema(JsonSerde.serializer())
            .build())
        .setDeliveryGuarantee(DeliveryGuarantee.EXACTLY_ONCE)
        .setTransactionalIdPrefix(config.transactionalIdPrefix + "-bars")
        .build();

    KafkaSink<TaSignal> signalSink = KafkaSink.<TaSignal>builder()
        .setBootstrapServers(config.bootstrapServers)
        .setKafkaProducerConfig(kafkaProducerProps)
        .setRecordSerializer(KafkaRecordSerializationSchema.<TaSignal>builder()
            .setTopic(config.taSignalsTopic)
            .setKeySerializationSchema((TaSignal sig) -> sig.getSymbol() == null
                ? null
                : sig.getSymbol().getBytes(StandardCharsets.UTF_8))
            .setValueSerializationSchema(JsonSerde.serializer())
            .build())
        .setDeliveryGuarantee(DeliveryGuarantee.EXACTLY_ONCE)
        .setTransactionalIdPrefix(config.transactionalIdPrefix + "-signals")
        .build();

    bars.sinkTo(barSink).name("ta-bars-sink");
    signals.sinkTo(signalSink).name("ta-signals-sink");

    env.execute("torghut-flink-ta");
  }

  private static void configureCheckpointing(StreamExecutionEnvironment env, JobConfig config) {
    env.enableCheckpointing(config.checkpointIntervalMs, CheckpointingMode.EXACTLY_ONCE);
    env.setStateBackend(new EmbeddedRocksDBStateBackend(true));
    CheckpointConfig ck = env.getCheckpointConfig();
    ck.setCheckpointTimeout(config.checkpointTimeoutMs);
    ck.setMinPauseBetweenCheckpoints(config.minPauseBetweenCheckpointsMs);
    ck.setTolerableCheckpointFailureNumber(3);
    ck.enableExternalizedCheckpoints(CheckpointConfig.ExternalizedCheckpointCleanup.RETAIN_ON_CANCELLATION);
    if (config.checkpointUri != null && !config.checkpointUri.isEmpty()) {
      ck.setCheckpointStorage(config.checkpointUri);
    }
  }

  private static class JobConfig {
    final String bootstrapServers;
    final String tradesTopic;
    final String quotesTopic;
    final String taBarsTopic;
    final String taSignalsTopic;
    final String transactionalIdPrefix;
    final String checkpointUri;
    final int parallelism;
    final int allowedLatenessSeconds;
    final int dedupeTtlMinutes;
    final long checkpointIntervalMs;
    final long checkpointTimeoutMs;
    final long minPauseBetweenCheckpointsMs;
    final String kafkaUsername;
    final String kafkaPassword;
    final String kafkaTruststorePath;
    final String kafkaTruststorePassword;
    final String kafkaSecurityProtocol;
    final String kafkaSaslMechanism;
    final String s3Endpoint;
    final boolean s3PathStyle;
    final String s3AccessKey;
    final String s3SecretKey;

    static JobConfig fromEnv() {
      String bootstrap = env("KAFKA_BOOTSTRAP", "kafka-kafka-bootstrap.kafka:9092");
      return new JobConfig(
          bootstrap,
          env("TOPIC_TRADES", "alpaca.trades.v1"),
          env("TOPIC_QUOTES", "alpaca.quotes.v1"),
          env("TOPIC_TA_BARS", "ta.bars.1s.v1"),
          env("TOPIC_TA_SIGNALS", "ta.signals.v1"),
          env("TRANSACTION_PREFIX", "flink-ta"),
          env("CHECKPOINT_URI", ""),
          envInt("PARALLELISM", 4),
          envInt("ALLOWED_LATENESS_SECONDS", 2),
          envInt("DEDUPE_TTL_MINUTES", 10),
          envLong("CHECKPOINT_INTERVAL_MS", 10_000L),
          envLong("CHECKPOINT_TIMEOUT_MS", 120_000L),
          envLong("CHECKPOINT_MIN_PAUSE_MS", 2_000L),
          env("KAFKA_USERNAME", null),
          env("KAFKA_PASSWORD", null),
          env("KAFKA_TRUSTSTORE_PATH", null),
          env("KAFKA_TRUSTSTORE_PASSWORD", null),
          env("KAFKA_SECURITY_PROTOCOL", "SASL_SSL"),
          env("KAFKA_SASL_MECHANISM", "SCRAM-SHA-512"),
          env("S3_ENDPOINT", null),
          envBool("S3_PATH_STYLE", true),
          env("S3_ACCESS_KEY", null),
          env("S3_SECRET_KEY", null));
    }

    JobConfig(String bootstrapServers, String tradesTopic, String quotesTopic, String taBarsTopic, String taSignalsTopic,
        String transactionalIdPrefix, String checkpointUri, int parallelism, int allowedLatenessSeconds,
        int dedupeTtlMinutes, long checkpointIntervalMs, long checkpointTimeoutMs, long minPauseBetweenCheckpointsMs,
        String kafkaUsername, String kafkaPassword, String kafkaTruststorePath, String kafkaTruststorePassword,
        String kafkaSecurityProtocol, String kafkaSaslMechanism, String s3Endpoint, boolean s3PathStyle,
        String s3AccessKey, String s3SecretKey) {
      this.bootstrapServers = bootstrapServers;
      this.tradesTopic = tradesTopic;
      this.quotesTopic = quotesTopic;
      this.taBarsTopic = taBarsTopic;
      this.taSignalsTopic = taSignalsTopic;
      this.transactionalIdPrefix = transactionalIdPrefix;
      this.checkpointUri = checkpointUri;
      this.parallelism = parallelism;
      this.allowedLatenessSeconds = allowedLatenessSeconds;
      this.dedupeTtlMinutes = dedupeTtlMinutes;
      this.checkpointIntervalMs = checkpointIntervalMs;
      this.checkpointTimeoutMs = checkpointTimeoutMs;
      this.minPauseBetweenCheckpointsMs = minPauseBetweenCheckpointsMs;
      this.kafkaUsername = kafkaUsername;
      this.kafkaPassword = kafkaPassword;
      this.kafkaTruststorePath = kafkaTruststorePath;
      this.kafkaTruststorePassword = kafkaTruststorePassword;
      this.kafkaSecurityProtocol = kafkaSecurityProtocol;
      this.kafkaSaslMechanism = kafkaSaslMechanism;
      this.s3Endpoint = s3Endpoint;
      this.s3PathStyle = s3PathStyle;
      this.s3AccessKey = s3AccessKey;
      this.s3SecretKey = s3SecretKey;
    }
  }

  private static class KafkaProps {
    static Properties consumer(JobConfig config) {
      Properties props = base(config);
      props.put("group.id", "flink-ta");
      props.put("auto.offset.reset", "earliest");
      props.put("isolation.level", "read_committed");
      return props;
    }

    static Properties producer(JobConfig config) {
      Properties props = base(config);
      props.put("enable.idempotence", "true");
      props.put("acks", "all");
      props.put("compression.type", "lz4");
      props.put("transaction.timeout.ms", String.valueOf(envLong("TRANSACTION_TIMEOUT_MS", 900000L)));
      props.put("max.in.flight.requests.per.connection", "5");
      return props;
    }

    private static Properties base(JobConfig config) {
      Properties props = new Properties();
      if (config.kafkaSecurityProtocol != null) {
        props.put("security.protocol", config.kafkaSecurityProtocol);
      }
      if (config.kafkaSaslMechanism != null) {
        props.put("sasl.mechanism", config.kafkaSaslMechanism);
      }
      if (config.kafkaUsername != null && config.kafkaPassword != null) {
        String jaas = String.format(
            "org.apache.kafka.common.security.scram.ScramLoginModule required username=\"%s\" password=\"%s\";",
            config.kafkaUsername, config.kafkaPassword);
        props.put("sasl.jaas.config", jaas);
      }
      if (config.kafkaTruststorePath != null) {
        props.put("ssl.truststore.type", "PEM");
        props.put("ssl.truststore.location", config.kafkaTruststorePath);
        if (config.kafkaTruststorePassword != null) {
          props.put("ssl.truststore.password", config.kafkaTruststorePassword);
        }
      }
      props.put("client.dns.lookup", "use_all_dns_ips");
      props.put("reconnect.backoff.ms", "50");
      props.put("reconnect.backoff.max.ms", "1000");
      return props;
    }
  }

  private static String env(String key, String defaultValue) {
    String value = System.getenv(key);
    return value == null || value.isEmpty() ? defaultValue : value;
  }

  private static int envInt(String key, int defaultValue) {
    try {
      return Integer.parseInt(env(key, String.valueOf(defaultValue)));
    } catch (NumberFormatException e) {
      return defaultValue;
    }
  }

  private static long envLong(String key, long defaultValue) {
    try {
      return Long.parseLong(env(key, String.valueOf(defaultValue)));
    } catch (NumberFormatException e) {
      return defaultValue;
    }
  }

  private static boolean envBool(String key, boolean defaultValue) {
    String raw = System.getenv(key);
    if (raw == null || raw.isEmpty()) {
      return defaultValue;
    }
    return Boolean.parseBoolean(raw);
  }
}
