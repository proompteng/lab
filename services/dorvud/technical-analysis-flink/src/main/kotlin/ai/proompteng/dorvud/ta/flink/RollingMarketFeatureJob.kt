package ai.proompteng.dorvud.ta.flink

import kotlinx.serialization.json.Json
import org.apache.flink.api.common.eventtime.WatermarkStrategy
import org.apache.flink.api.common.functions.OpenContext
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

internal data class RollingMarketFeatureConfig(
  val topic: String,
  val barsTopic: String,
  val universe: ArchiveUniverse,
  val producerRevision: String,
) : Serializable {
  companion object {
    fun fromEnv(env: Map<String, String> = System.getenv()): RollingMarketFeatureConfig? {
      val topic = env["TA_MARKET_FEATURES_TOPIC"]?.trim()?.takeIf { it.isNotEmpty() } ?: return null

      fun required(key: String) =
        requireNotNull(
          env[key]?.trim()?.takeIf {
            it.isNotEmpty()
          },
        ) { "$key must be set when market features are enabled" }
      val symbols = required("ARCHIVE_CORE_UNIVERSE_SYMBOLS").split(',')
      require(
        symbols.isNotEmpty() && symbols == symbols.distinct().sorted() &&
          symbols.all {
            it.matches(Regex("[A-Z][A-Z0-9.]{0,9}"))
          },
      ) { "feature universe must be canonical" }
      val symbolHash = required("ARCHIVE_CORE_UNIVERSE_SYMBOL_HASH")
      require(symbolHash == canonicalSymbolHash(symbols)) { "feature universe hash mismatch" }
      require(required("ARCHIVE_CORE_FEED") == "iex") { "market features currently require IEX" }
      val barsTopic = required("ARCHIVE_CORE_BARS_TOPIC")
      require(topic != barsTopic) { "feature output must differ from its input" }
      return RollingMarketFeatureConfig(
        topic,
        barsTopic,
        ArchiveUniverse(required("ARCHIVE_CORE_UNIVERSE_ID"), symbolHash, symbols.toSet()),
        required("TORGHUT_TA_COMMIT"),
      )
    }
  }
}

internal fun configureRollingMarketFeatures(
  env: StreamExecutionEnvironment,
  ta: FlinkTaConfig,
  config: RollingMarketFeatureConfig,
) {
  val source =
    KafkaSource
      .builder<ArchiveKafkaRecord>()
      .setBootstrapServers(ta.bootstrapServers)
      .setTopics(config.barsTopic)
      .setGroupId("${ta.groupId}-market-features-v1")
      .setClientIdPrefix("${ta.clientId}-market-features-v1")
      .setDeserializer(ArchiveKafkaRecordDeserializer())
      .setStartingOffsets(OffsetsInitializer.earliest())
      .setProperty("enable.auto.commit", "false")
      .setProperty("isolation.level", "read_committed")
  applyKafkaSecurity(source, ta)
  val sink =
    KafkaSink
      .builder<RollingMarketFeature>()
      .setBootstrapServers(ta.bootstrapServers)
      .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
      .setRecordSerializer(RollingMarketFeatureSerializer(config.topic))
  sink.setKafkaSecurity(ta)
  env
    .fromSource(source.build(), WatermarkStrategy.noWatermarks(), "market-feature-bars-source")
    .uid("market-feature-bars-source-v1")
    .flatMap(ParseArchiveBar(mapOf(config.barsTopic to ArchiveRoute("iex", config.universe))))
    .returns(TypeInformation.of(IntradayBarRecord::class.java))
    .filter { it.marketSession == "regular" && it.final }
    .keyBy(::rollingFeatureKey)
    .process(RollingMarketFeatureFunction(config.producerRevision))
    .name("rolling-market-features")
    .uid("rolling-market-features-v1")
    .sinkTo(sink.build())
    .name("market-features-kafka")
    .uid("market-features-kafka-v1")
}

internal class RollingMarketFeatureFunction(
  private val producerRevision: String,
) : KeyedProcessFunction<String, IntradayBarRecord, RollingMarketFeature>() {
  private lateinit var state: ValueState<RollingFeatureState>
  private lateinit var emitted: Counter
  private lateinit var rejected: Counter

  override fun open(openContext: OpenContext) {
    state = runtimeContext.getState(ValueStateDescriptor("rolling-market-feature-state-v1", RollingFeatureState::class.java))
    emitted = runtimeContext.metricGroup.counter("market_features_emitted_total")
    rejected = runtimeContext.metricGroup.counter("market_features_rejected_total")
  }

  override fun processElement(
    value: IntradayBarRecord,
    ctx: Context,
    out: Collector<RollingMarketFeature>,
  ) {
    val transition =
      processRollingFeature(state.value() ?: RollingFeatureState(), value, ctx.timerService().currentProcessingTime(), producerRevision)
    if (transition.rejection != null) {
      rejected.inc()
      LoggerFactory.getLogger("rolling-market-features").warn(
        "Rejected rolling input topic={} partition={} offset={} reason={}",
        value.sourceTopic,
        value.sourcePartition,
        value.sourceOffset,
        transition.rejection.replace(Regex("[\\r\\n]"), " ").take(240),
      )
    }
    state.update(transition.state)
    transition.feature?.let {
      out.collect(it)
      emitted.inc()
    }
  }
}

internal class RollingMarketFeatureSerializer(
  private val topic: String,
) : KafkaRecordSerializationSchema<RollingMarketFeature> {
  override fun serialize(
    element: RollingMarketFeature,
    context: KafkaRecordSerializationSchema.KafkaSinkContext,
    timestamp: Long?,
  ): ProducerRecord<ByteArray, ByteArray> {
    val key = with(element.material) { listOf(provider, feed, delayClass, universeId, universeSymbolHash, symbol).joinToString("|") }
    val json = Json { encodeDefaults = true }
    return ProducerRecord(
      topic,
      null,
      element.computedAtMs,
      key.toByteArray(),
      json.encodeToString(RollingMarketFeature.serializer(), element).toByteArray(),
    )
  }
}
