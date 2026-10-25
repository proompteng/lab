package ai.proompteng.dorvud.ta.flink

import kotlinx.serialization.json.Json
import org.apache.flink.api.common.functions.OpenContext
import org.apache.flink.api.common.state.ValueState
import org.apache.flink.api.common.state.ValueStateDescriptor
import org.apache.flink.connector.base.DeliveryGuarantee
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema
import org.apache.flink.connector.kafka.sink.KafkaSink
import org.apache.flink.metrics.Counter
import org.apache.flink.streaming.api.datastream.DataStream
import org.apache.flink.streaming.api.functions.KeyedProcessFunction
import org.apache.flink.util.Collector
import org.apache.kafka.clients.producer.ProducerRecord
import org.slf4j.LoggerFactory

internal fun configureTechnicalMarketFeatures(
  bars: DataStream<IntradayBarRecord>,
  ta: FlinkTaConfig,
  topic: String,
  producerRevision: String,
) {
  val sink =
    KafkaSink
      .builder<TechnicalMarketFeature>()
      .setBootstrapServers(ta.bootstrapServers)
      .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
      .setRecordSerializer(TechnicalMarketFeatureSerializer(topic))
  sink.setKafkaSecurity(ta)
  bars
    .keyBy(::rollingFeatureKey)
    .process(TechnicalMarketFeatureFunction(producerRevision))
    .name("technical-market-features")
    .uid("technical-market-features-v1")
    .sinkTo(sink.build())
    .name("technical-features-kafka")
    .uid("technical-features-kafka-v1")
}

internal class TechnicalMarketFeatureFunction(
  private val producerRevision: String,
) : KeyedProcessFunction<String, IntradayBarRecord, TechnicalMarketFeature>() {
  private lateinit var state: ValueState<TechnicalFeatureState>
  private lateinit var emitted: Counter
  private lateinit var rejected: Counter

  override fun open(openContext: OpenContext) {
    state = runtimeContext.getState(ValueStateDescriptor("technical-market-feature-state-v1", TechnicalFeatureState::class.java))
    emitted = runtimeContext.metricGroup.counter("technical_features_emitted_total")
    rejected = runtimeContext.metricGroup.counter("technical_features_rejected_total")
  }

  override fun processElement(
    value: IntradayBarRecord,
    ctx: Context,
    out: Collector<TechnicalMarketFeature>,
  ) {
    val transition =
      processTechnicalFeature(
        state.value() ?: TechnicalFeatureState(),
        value,
        ctx.timerService().currentProcessingTime(),
        producerRevision,
      )
    transition.rejection?.let { reason ->
      rejected.inc()
      LoggerFactory.getLogger("technical-market-features").warn(
        "Rejected technical input topic={} partition={} offset={} reason={}",
        value.sourceTopic,
        value.sourcePartition,
        value.sourceOffset,
        reason.replace(Regex("[\r\n]"), " ").take(240),
      )
    }
    state.update(transition.state)
    transition.feature?.let {
      out.collect(it)
      emitted.inc()
    }
  }
}

internal class TechnicalMarketFeatureSerializer(
  private val topic: String,
) : KafkaRecordSerializationSchema<TechnicalMarketFeature> {
  override fun serialize(
    element: TechnicalMarketFeature,
    context: KafkaRecordSerializationSchema.KafkaSinkContext,
    timestamp: Long?,
  ): ProducerRecord<ByteArray, ByteArray> {
    val key = with(element.material) { listOf(provider, feed, delayClass, universeId, universeSymbolHash, symbol).joinToString("|") }
    return ProducerRecord(
      topic,
      null,
      element.computedAtMs,
      key.toByteArray(),
      Json { encodeDefaults = true }
        .encodeToString(TechnicalMarketFeature.serializer(), element)
        .toByteArray(),
    )
  }
}
