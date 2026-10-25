package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.CRYPTO_LOCATIONS
import ai.proompteng.dorvud.platform.isCryptoPair
import org.apache.flink.api.common.eventtime.WatermarkStrategy
import org.apache.flink.api.common.functions.OpenContext
import org.apache.flink.api.common.functions.RichFlatMapFunction
import org.apache.flink.api.common.state.ValueState
import org.apache.flink.api.common.state.ValueStateDescriptor
import org.apache.flink.api.common.typeinfo.TypeInformation
import org.apache.flink.connector.base.DeliveryGuarantee
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema
import org.apache.flink.connector.kafka.sink.KafkaSink
import org.apache.flink.connector.kafka.source.KafkaSource
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer
import org.apache.flink.metrics.Counter
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment
import org.apache.flink.streaming.api.functions.KeyedProcessFunction
import org.apache.flink.util.Collector
import org.apache.kafka.clients.producer.ProducerRecord
import org.slf4j.LoggerFactory
import java.io.Serializable
import java.time.DateTimeException

internal data class CryptoMarketFeatureConfig(
  val source: CryptoArchiveConfig,
  val topic: String,
  val producerRevision: String,
) : Serializable {
  companion object {
    fun fromEnv(env: Map<String, String> = System.getenv()): CryptoMarketFeatureConfig? {
      val keys = listOf("TA_CRYPTO_TOPIC", "TA_CRYPTO_LOCATION", "TA_CRYPTO_SYMBOLS", "TA_CRYPTO_FEATURES_TOPIC")
      if (keys.none { it in env }) return null

      fun required(key: String) = requireNotNull(env[key]?.trim()?.takeIf { it.isNotEmpty() }) { "$key is required for crypto features" }
      val input = required("TA_CRYPTO_TOPIC")
      val output = required("TA_CRYPTO_FEATURES_TOPIC")
      val location = required("TA_CRYPTO_LOCATION")
      val symbols = required("TA_CRYPTO_SYMBOLS").split(',').map { it.trim() }
      require(location in CRYPTO_LOCATIONS) { "unsupported crypto feature location" }
      require(symbols == symbols.distinct().sorted() && symbols.all(::isCryptoPair)) { "crypto feature pairs must be canonical" }
      require(output != input) { "crypto feature output must differ from its source" }
      val revision = required("TORGHUT_TA_COMMIT")
      require(revision.matches(Regex("[0-9a-f]{40}"))) { "crypto features require an exact producer revision" }
      return CryptoMarketFeatureConfig(CryptoArchiveConfig(input, location, symbols.toSet()), output, revision)
    }
  }
}

internal fun configureCryptoMarketFeatures(
  env: StreamExecutionEnvironment,
  ta: FlinkTaConfig,
  config: CryptoMarketFeatureConfig,
) {
  val equityTopics = setOfNotNull(ta.tradesTopic, ta.quotesTopic, ta.bars1mTopic, ta.microBarsTopic, ta.signalsTopic, ta.statusTopic)
  require(config.source.topic !in equityTopics && config.topic !in equityTopics) {
    "crypto topics must differ from equity topics"
  }
  val source =
    KafkaSource
      .builder<ArchiveKafkaRecord>()
      .setBootstrapServers(ta.bootstrapServers)
      .setTopics(config.source.topic)
      .setGroupId("${ta.groupId}-crypto-features-v1")
      .setClientIdPrefix("${ta.clientId}-crypto-features-v1")
      .setDeserializer(ArchiveKafkaRecordDeserializer())
      .setStartingOffsets(OffsetsInitializer.earliest())
      .setProperty("enable.auto.commit", "false")
      .setProperty("isolation.level", "read_committed")
  applyKafkaSecurity(source, ta)
  val sink =
    KafkaSink
      .builder<CryptoMarketFeature>()
      .setBootstrapServers(ta.bootstrapServers)
      .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
      .setRecordSerializer(CryptoMarketFeatureSerializer(config.topic))
  sink.setKafkaSecurity(ta)
  env
    .fromSource(source.build(), WatermarkStrategy.noWatermarks(), "crypto-feature-source")
    .uid("crypto-feature-source-v1")
    .flatMap(ParseCryptoFeatureBar(config.source))
    .returns(TypeInformation.of(CryptoFeatureBar::class.java))
    .name("crypto-feature-bars")
    .uid("crypto-feature-bars-v1")
    .keyBy { "${it.location}|${it.symbol}" }
    .process(CryptoMarketFeatureFunction(config.producerRevision))
    .name("crypto-market-features")
    .uid("crypto-market-features-v1")
    .sinkTo(sink.build())
    .name("crypto-features-kafka")
    .uid("crypto-features-kafka-v1")
}

internal class ParseCryptoFeatureBar(
  private val source: CryptoArchiveConfig,
) : RichFlatMapFunction<ArchiveKafkaRecord, CryptoFeatureBar>() {
  private lateinit var rejected: Counter

  override fun open(openContext: OpenContext) {
    rejected = runtimeContext.metricGroup.counter("crypto_feature_source_rejected_total")
  }

  override fun flatMap(
    value: ArchiveKafkaRecord,
    out: Collector<CryptoFeatureBar>,
  ) {
    val parsed =
      runCatching { decodeCryptoFeatureBar(value, source) }.getOrElse { error ->
        if (error !is IllegalArgumentException && error !is IllegalStateException && error !is DateTimeException &&
          error !is ArithmeticException
        ) {
          throw error
        }
        rejected.inc()
        LoggerFactory.getLogger("crypto-market-features").warn(
          "Rejected crypto feature input topic={} partition={} offset={}",
          value.topic,
          value.partition,
          value.offset,
          error,
        )
        return
      }
    parsed?.let(out::collect)
  }
}

internal class CryptoMarketFeatureFunction(
  private val producerRevision: String,
) : KeyedProcessFunction<String, CryptoFeatureBar, CryptoMarketFeature>() {
  private lateinit var state: ValueState<CryptoFeatureState>
  private lateinit var emitted: Counter
  private lateinit var rejected: Counter

  override fun open(openContext: OpenContext) {
    state = runtimeContext.getState(ValueStateDescriptor("crypto-market-feature-state-v1", CryptoFeatureState::class.java))
    emitted = runtimeContext.metricGroup.counter("crypto_features_emitted_total")
    rejected = runtimeContext.metricGroup.counter("crypto_features_rejected_total")
  }

  override fun processElement(
    value: CryptoFeatureBar,
    ctx: Context,
    out: Collector<CryptoMarketFeature>,
  ) {
    val previous = state.value() ?: CryptoFeatureState()
    val transition =
      runCatching {
        advanceCryptoFeature(previous, value, ctx.timerService().currentProcessingTime(), producerRevision)
      }.getOrElse { error ->
        if (error !is IllegalArgumentException && error !is IllegalStateException && error !is DateTimeException &&
          error !is ArithmeticException
        ) {
          throw error
        }
        rejected.inc()
        LoggerFactory.getLogger("crypto-market-features").warn(
          "Rejected crypto feature transition topic={} partition={} offset={}",
          value.sourceTopic,
          value.sourcePartition,
          value.sourceOffset,
          error,
        )
        return
      }
    state.update(transition.state)
    transition.feature?.let {
      out.collect(it)
      emitted.inc()
    }
  }
}

internal class CryptoMarketFeatureSerializer(
  private val topic: String,
) : KafkaRecordSerializationSchema<CryptoMarketFeature> {
  override fun serialize(
    element: CryptoMarketFeature,
    context: KafkaRecordSerializationSchema.KafkaSinkContext,
    timestamp: Long?,
  ): ProducerRecord<ByteArray, ByteArray> =
    ProducerRecord(
      topic,
      null,
      element.computedAtMs,
      "${element.material.location}|${element.material.symbol}".toByteArray(Charsets.UTF_8),
      cryptoFeatureJson.encodeToString(CryptoMarketFeature.serializer(), element).toByteArray(Charsets.UTF_8),
    )
}
