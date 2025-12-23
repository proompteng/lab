package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.Window
import ai.proompteng.dorvud.ta.producer.AvroSerde
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import ai.proompteng.dorvud.ta.stream.QuotePayload
import ai.proompteng.dorvud.ta.stream.TaSignalsPayload
import ai.proompteng.dorvud.ta.stream.TradePayload
import ai.proompteng.dorvud.ta.stream.withPayload
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import org.apache.flink.api.common.eventtime.SerializableTimestampAssigner
import org.apache.flink.api.common.eventtime.WatermarkStrategy
import org.apache.flink.api.common.functions.OpenContext
import org.apache.flink.api.common.functions.RichFlatMapFunction
import org.apache.flink.api.common.serialization.SimpleStringSchema
import org.apache.flink.api.common.state.ListState
import org.apache.flink.api.common.state.ListStateDescriptor
import org.apache.flink.api.common.state.ValueState
import org.apache.flink.api.common.state.ValueStateDescriptor
import org.apache.flink.api.common.typeinfo.TypeHint
import org.apache.flink.api.common.typeinfo.TypeInformation
import org.apache.flink.connector.base.DeliveryGuarantee
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema
import org.apache.flink.connector.kafka.sink.KafkaSink
import org.apache.flink.connector.kafka.sink.KafkaSinkBuilder
import org.apache.flink.connector.kafka.source.KafkaSource
import org.apache.flink.connector.kafka.source.KafkaSourceBuilder
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer
import org.apache.flink.connector.kafka.source.reader.deserializer.KafkaRecordDeserializationSchema
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment
import org.apache.flink.streaming.api.functions.KeyedProcessFunction
import org.apache.flink.streaming.api.functions.co.KeyedCoProcessFunction
import org.apache.flink.util.Collector
import org.apache.kafka.clients.consumer.OffsetResetStrategy
import org.apache.kafka.clients.producer.ProducerRecord
import org.slf4j.LoggerFactory
import org.ta4j.core.BaseBar
import org.ta4j.core.BaseBarSeries
import org.ta4j.core.indicators.EMAIndicator
import org.ta4j.core.indicators.MACDIndicator
import org.ta4j.core.indicators.RSIIndicator
import org.ta4j.core.indicators.SMAIndicator
import org.ta4j.core.indicators.bollinger.BollingerBandsLowerIndicator
import org.ta4j.core.indicators.bollinger.BollingerBandsMiddleIndicator
import org.ta4j.core.indicators.bollinger.BollingerBandsUpperIndicator
import org.ta4j.core.indicators.helpers.ClosePriceIndicator
import org.ta4j.core.indicators.statistics.StandardDeviationIndicator
import java.io.Serializable
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit

fun main() {
  val config = FlinkTaConfig.fromEnv()
  val serde = AvroSerde()
  applyS3SystemProperties(config)
  val env = StreamExecutionEnvironment.getExecutionEnvironment()

  configureEnvironment(env, config)

  val trades =
    env
      .fromSource(
        kafkaSource(config, config.tradesTopic),
        WatermarkStrategy.noWatermarks(),
        "ta-trades-source",
      ).flatMap(ParseEnvelopeFlatMap(SerializerFactory { TradePayload.serializer() }))
      .returns(object : TypeHint<Envelope<TradePayload>>() {})
      .assignTimestampsAndWatermarks(watermarkStrategy(config))

  val quotesStream =
    if (config.quotesTopic != null) {
      env
        .fromSource(
          kafkaSource(config, config.quotesTopic),
          WatermarkStrategy.noWatermarks(),
          "ta-quotes-source",
        ).flatMap(ParseEnvelopeFlatMap(SerializerFactory { QuotePayload.serializer() }))
        .returns(object : TypeHint<Envelope<QuotePayload>>() {})
        .assignTimestampsAndWatermarks(watermarkStrategy(config))
    } else {
      env
        .fromData(emptyList<Envelope<QuotePayload>>())
        .assignTimestampsAndWatermarks(emptyWatermarks())
    }

  val bars1mStream =
    if (config.bars1mTopic != null) {
      env
        .fromSource(
          kafkaSource(config, config.bars1mTopic),
          WatermarkStrategy.noWatermarks(),
          "ta-bars1m-source",
        ).flatMap(ParseEnvelopeFlatMap(SerializerFactory { MicroBarPayload.serializer() }))
        .returns(object : TypeHint<Envelope<MicroBarPayload>>() {})
        .assignTimestampsAndWatermarks(watermarkStrategy(config))
    } else {
      env
        .fromData(emptyList<Envelope<MicroBarPayload>>())
        .assignTimestampsAndWatermarks(emptyWatermarks())
    }

  val microBars =
    trades
      .keyBy { it.symbol }
      .process(MicrobarProcessFunction())
      .name("ta-microbars")
      .uid("ta-microbars")

  val microBarsForSignals = if (config.bars1mTopic != null) microBars.union(bars1mStream) else microBars

  val signals =
    microBarsForSignals
      .keyBy { it.symbol }
      .connect(quotesStream.keyBy { it.symbol })
      .process(TaSignalsFunction(config))
      .name("ta-signals")
      .uid("ta-signals")

  microBars.sinkTo(microBarSink(config, serde)).name("sink-microbars")
  signals.sinkTo(signalSink(config, serde)).name("sink-signals")

  env.execute("torghut-technical-analysis-flink")
}

private fun configureEnvironment(
  env: StreamExecutionEnvironment,
  config: FlinkTaConfig,
) {
  env.setParallelism(config.parallelism)
  env.enableCheckpointing(config.checkpointIntervalMs)
  val checkpointConfig = env.checkpointConfig
  checkpointConfig.checkpointTimeout = config.checkpointTimeoutMs
  checkpointConfig.minPauseBetweenCheckpoints = config.minPauseBetweenCheckpointsMs
  env.config.setAutoWatermarkInterval(1_000)
}

private fun applyS3SystemProperties(config: FlinkTaConfig) {
  System.setProperty("fs.s3a.endpoint", config.s3Endpoint)
  System.setProperty("fs.s3a.path.style.access", config.s3PathStyle.toString())
  System.setProperty("fs.s3a.connection.ssl.enabled", config.s3Secure.toString())
  System.setProperty("fs.s3a.fast.upload", "true")
  config.s3AccessKey?.let { System.setProperty("fs.s3a.access.key", it) }
  config.s3SecretKey?.let { System.setProperty("fs.s3a.secret.key", it) }
}

private fun <T> watermarkStrategy(config: FlinkTaConfig): WatermarkStrategy<Envelope<T>> =
  WatermarkStrategy
    .forBoundedOutOfOrderness<Envelope<T>>(Duration.ofMillis(config.maxOutOfOrderMs))
    .withTimestampAssigner(SerializableTimestampAssigner<Envelope<T>> { event, _ -> event.eventTs.toEpochMilli() })

private fun <T> emptyWatermarks(): WatermarkStrategy<T> = WatermarkStrategy.noWatermarks()

private fun kafkaSource(
  config: FlinkTaConfig,
  topic: String,
): KafkaSource<String> {
  val offsetResetStrategy =
    when (config.autoOffsetReset.trim().lowercase()) {
      "earliest" -> OffsetResetStrategy.EARLIEST
      "latest" -> OffsetResetStrategy.LATEST
      "none" -> OffsetResetStrategy.NONE
      else -> OffsetResetStrategy.LATEST
    }

  val builder =
    KafkaSource
      .builder<String>()
      .setBootstrapServers(config.bootstrapServers)
      .setTopics(topic)
      .setClientIdPrefix(config.clientId)
      .setGroupId(config.groupId)
      .setValueOnlyDeserializer(SimpleStringSchema())
      .setStartingOffsets(OffsetsInitializer.committedOffsets(offsetResetStrategy))

  builder.setProperty("auto.offset.reset", config.autoOffsetReset)
  builder.setProperty("isolation.level", "read_committed")
  builder.setProperty("enable.auto.commit", "false")
  applyKafkaSecurity(builder, config)
  return builder.build()
}

private fun applyKafkaSecurity(
  builder: KafkaSourceBuilder<String>,
  config: FlinkTaConfig,
) {
  builder.setProperty("security.protocol", config.securityProtocol)
  config.saslMechanism?.let { builder.setProperty("sasl.mechanism", it) }
  if (!config.saslUsername.isNullOrBlank() && !config.saslPassword.isNullOrBlank()) {
    val jaas = kafkaJaas(config)
    builder.setProperty("sasl.jaas.config", jaas)
  }
}

private fun microBarSink(
  config: FlinkTaConfig,
  serde: AvroSerde,
): KafkaSink<Envelope<MicroBarPayload>> {
  val sinkBuilder =
    KafkaSink
      .builder<Envelope<MicroBarPayload>>()
      .setBootstrapServers(config.bootstrapServers)
      .setDeliveryGuarantee(config.deliveryGuarantee)

  if (config.deliveryGuarantee == DeliveryGuarantee.EXACTLY_ONCE) {
    sinkBuilder.setTransactionalIdPrefix("${config.clientId}-microbars")
    sinkBuilder.setProperty("transaction.timeout.ms", config.transactionTimeoutMs.toString())
  }

  sinkBuilder.setRecordSerializer(MicroBarSerializationSchema(config.microBarsTopic, serde))
  sinkBuilder.setKafkaSecurity(config)
  return sinkBuilder.build()
}

private fun signalSink(
  config: FlinkTaConfig,
  serde: AvroSerde,
): KafkaSink<Envelope<TaSignalsPayload>> {
  val sinkBuilder =
    KafkaSink
      .builder<Envelope<TaSignalsPayload>>()
      .setBootstrapServers(config.bootstrapServers)
      .setDeliveryGuarantee(config.deliveryGuarantee)

  if (config.deliveryGuarantee == DeliveryGuarantee.EXACTLY_ONCE) {
    sinkBuilder.setTransactionalIdPrefix("${config.clientId}-signals")
    sinkBuilder.setProperty("transaction.timeout.ms", config.transactionTimeoutMs.toString())
  }

  sinkBuilder.setRecordSerializer(SignalSerializationSchema(config.signalsTopic, serde))
  sinkBuilder.setKafkaSecurity(config)
  return sinkBuilder.build()
}

internal class MicroBarSerializationSchema(
  private val topic: String,
  private val serde: AvroSerde,
) : KafkaRecordSerializationSchema<Envelope<MicroBarPayload>>,
  Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L
  }

  override fun serialize(
    element: Envelope<MicroBarPayload>?,
    context: KafkaRecordSerializationSchema.KafkaSinkContext,
    timestamp: Long?,
  ): ProducerRecord<ByteArray, ByteArray>? {
    if (element == null) return null
    val key = element.symbol.toByteArray(StandardCharsets.UTF_8)
    val value = serde.encodeMicroBar(element, topic)
    return ProducerRecord(topic, null, timestamp ?: System.currentTimeMillis(), key, value)
  }
}

internal class SignalSerializationSchema(
  private val topic: String,
  private val serde: AvroSerde,
) : KafkaRecordSerializationSchema<Envelope<TaSignalsPayload>>,
  Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L
  }

  override fun serialize(
    element: Envelope<TaSignalsPayload>?,
    context: KafkaRecordSerializationSchema.KafkaSinkContext,
    timestamp: Long?,
  ): ProducerRecord<ByteArray, ByteArray>? {
    if (element == null) return null
    val key = element.symbol.toByteArray(StandardCharsets.UTF_8)
    val value = serde.encodeSignals(element, topic)
    return ProducerRecord(topic, null, timestamp ?: System.currentTimeMillis(), key, value)
  }
}

internal fun interface SerializerFactory<T> : Serializable {
  fun serializer(): KSerializer<T>
}

internal class ParseEnvelopeFlatMap<T>(
  private val serializerFactory: SerializerFactory<T>,
) : RichFlatMapFunction<String, Envelope<T>>(),
  Serializable {
  companion object {
    private const val serialVersionUID: Long = 1L
  }

  @Transient
  private lateinit var json: Json

  @Transient
  private lateinit var payloadSerializer: KSerializer<T>

  override fun open(openContext: OpenContext) {
    json = Json { ignoreUnknownKeys = true }
    payloadSerializer = serializerFactory.serializer()
  }

  override fun flatMap(
    value: String,
    out: Collector<Envelope<T>>,
  ) {
    runCatching { json.decodeFromString(Envelope.serializer(payloadSerializer), value) }
      .onSuccess { out.collect(it) }
      .onFailure { LoggerFactory.getLogger("parse-envelope").warn("Failed to decode envelope", it) }
  }
}

private fun <T> KafkaSinkBuilder<T>.setKafkaSecurity(config: FlinkTaConfig): KafkaSinkBuilder<T> {
  setProperty("security.protocol", config.securityProtocol)
  config.saslMechanism?.let { setProperty("sasl.mechanism", it) }
  if (!config.saslUsername.isNullOrBlank() && !config.saslPassword.isNullOrBlank()) {
    val jaas = kafkaJaas(config)
    setProperty("sasl.jaas.config", jaas)
  }
  setProperty("enable.idempotence", "true")
  setProperty("acks", "all")
  return this
}

private fun kafkaJaas(config: FlinkTaConfig): String {
  val username = requireNotNull(config.saslUsername) { "saslUsername missing" }
  val password = requireNotNull(config.saslPassword) { "saslPassword missing" }
  return buildString {
    append("org.apache.kafka.common.security.scram.ScramLoginModule required ")
    append("username=\"")
    append(username)
    append("\" password=\"")
    append(password)
    append("\";")
  }
}

private class MicrobarProcessFunction : KeyedProcessFunction<String, Envelope<TradePayload>, Envelope<MicroBarPayload>>() {
  private lateinit var bucketState: ValueState<BucketState>
  private lateinit var seqState: ValueState<Long>

  override fun open(openContext: OpenContext) {
    bucketState = runtimeContext.getState(ValueStateDescriptor("bucket", BucketState::class.java))
    seqState = runtimeContext.getState(ValueStateDescriptor("seq", Long::class.java))
  }

  override fun processElement(
    value: Envelope<TradePayload>,
    ctx: Context,
    out: Collector<Envelope<MicroBarPayload>>,
  ) {
    val windowStart = value.payload.t.truncatedTo(ChronoUnit.SECONDS)
    val windowStartMillis = windowStart.toEpochMilli()
    val windowEndMillis = windowStartMillis + 1_000

    val existing = bucketState.value()
    if (existing == null) {
      bucketState.update(BucketState.fromTrade(windowStartMillis, windowEndMillis, value.payload))
      ctx.timerService().registerEventTimeTimer(windowEndMillis)
      return
    }

    if (existing.windowStartMillis == windowStartMillis) {
      existing.update(value.payload)
      bucketState.update(existing)
    } else {
      emit(existing, value.symbol, out)
      bucketState.update(BucketState.fromTrade(windowStartMillis, windowEndMillis, value.payload))
      ctx.timerService().registerEventTimeTimer(windowEndMillis)
    }
  }

  override fun onTimer(
    timestamp: Long,
    ctx: OnTimerContext,
    out: Collector<Envelope<MicroBarPayload>>,
  ) {
    val bucket = bucketState.value() ?: return
    if (bucket.windowEndMillis <= timestamp) {
      emit(bucket, ctx.currentKey, out)
      bucketState.clear()
    }
  }

  private fun emit(
    bucket: BucketState,
    symbol: String,
    out: Collector<Envelope<MicroBarPayload>>,
  ) {
    val seq = (seqState.value() ?: 0L) + 1
    seqState.update(seq)
    val end = Instant.ofEpochMilli(bucket.windowEndMillis)
    val payload = bucket.toPayload()
    val envelope =
      Envelope(
        ingestTs = Instant.now(),
        eventTs = end,
        feed = "alpaca",
        channel = "trades",
        symbol = symbol,
        seq = seq,
        payload = payload,
        isFinal = true,
        source = "ta",
        window =
          Window(
            size = "PT1S",
            step = "PT1S",
            start = Instant.ofEpochMilli(bucket.windowStartMillis).toString(),
            end = end.toString(),
          ),
        version = 1,
      )
    out.collect(envelope)
  }
}

private data class BucketState(
  val windowStartMillis: Long,
  val windowEndMillis: Long,
  var open: Double,
  var high: Double,
  var low: Double,
  var close: Double,
  var volume: Double,
  var vwapNumerator: Double,
  var count: Long,
) : Serializable {
  fun update(trade: TradePayload) {
    high = kotlin.math.max(high, trade.p)
    low = kotlin.math.min(low, trade.p)
    close = trade.p
    volume += trade.s
    vwapNumerator += trade.p * trade.s
    count += 1
  }

  fun toPayload(): MicroBarPayload {
    val vwap = if (volume == 0.0) null else vwapNumerator / volume
    val end = Instant.ofEpochMilli(windowEndMillis)
    return MicroBarPayload(
      o = open,
      h = high,
      l = low,
      c = close,
      v = volume,
      vwap = vwap,
      count = count,
      t = end,
    )
  }

  companion object {
    fun fromTrade(
      windowStartMillis: Long,
      windowEndMillis: Long,
      trade: TradePayload,
    ): BucketState =
      BucketState(
        windowStartMillis = windowStartMillis,
        windowEndMillis = windowEndMillis,
        open = trade.p,
        high = trade.p,
        low = trade.p,
        close = trade.p,
        volume = trade.s.toDouble(),
        vwapNumerator = trade.p * trade.s,
        count = 1,
      )
  }
}

private class TaSignalsFunction(
  private val config: FlinkTaConfig,
) : KeyedCoProcessFunction<String, Envelope<MicroBarPayload>, Envelope<QuotePayload>, Envelope<TaSignalsPayload>>() {
  private lateinit var barsState: ListState<MicroBarPayload>
  private lateinit var quoteState: ValueState<QuotePayload>
  private lateinit var sessionState: ValueState<SessionAccumulatorState>

  override fun open(openContext: OpenContext) {
    barsState = runtimeContext.getListState(ListStateDescriptor("bars", TypeInformation.of(MicroBarPayload::class.java)))
    quoteState = runtimeContext.getState(ValueStateDescriptor("quote", QuotePayload::class.java))
    sessionState = runtimeContext.getState(ValueStateDescriptor("session", SessionAccumulatorState::class.java))
  }

  override fun processElement1(
    value: Envelope<MicroBarPayload>,
    ctx: Context,
    out: Collector<Envelope<TaSignalsPayload>>,
  ) {
    val bars = barsState.get().toMutableList()
    bars.add(value.payload)
    val historyLimit = maxOf(config.realizedVolWindow + 5, (config.vwapWindow.seconds + 60).toInt())
    while (bars.size > historyLimit) {
      bars.removeAt(0)
    }
    bars.sortBy { it.t }
    barsState.update(bars)

    val session = sessionState.value() ?: SessionAccumulatorState()
    session.pv += value.payload.c * value.payload.v
    session.vol += value.payload.v
    sessionState.update(session)

    val signalsPayload = computeSignals(value, bars, session)
    out.collect(signalsPayload)
  }

  override fun processElement2(
    value: Envelope<QuotePayload>,
    ctx: Context,
    out: Collector<Envelope<TaSignalsPayload>>,
  ) {
    quoteState.update(value.payload)
  }

  private fun computeSignals(
    envelope: Envelope<MicroBarPayload>,
    bars: List<MicroBarPayload>,
    session: SessionAccumulatorState,
  ): Envelope<TaSignalsPayload> {
    val series = BaseBarSeries("ta-${envelope.symbol}")
    bars.forEach { bar ->
      val barTime = ZonedDateTime.ofInstant(bar.t, ZoneOffset.UTC)
      val baseBar = BaseBar(Duration.ofSeconds(1), barTime, bar.o, bar.h, bar.l, bar.c, bar.v)
      if (series.barCount == 0) {
        series.addBar(baseBar)
      } else {
        val lastEndTime = series.getBar(series.endIndex).endTime
        when {
          barTime.isAfter(lastEndTime) -> series.addBar(baseBar)
          barTime.isEqual(lastEndTime) -> series.addBar(baseBar, true)
          else -> Unit
        }
      }
    }

    val close = ClosePriceIndicator(series)
    val ema12Indicator = EMAIndicator(close, 12)
    val ema26Indicator = EMAIndicator(close, 26)
    val ema12 = ema12Indicator.getValue(series.endIndex).doubleValue()
    val ema26 = ema26Indicator.getValue(series.endIndex).doubleValue()

    val macdIndicator = MACDIndicator(close, 12, 26)
    val macdVal = macdIndicator.getValue(series.endIndex).doubleValue()
    val signalVal = EMAIndicator(macdIndicator, 9).getValue(series.endIndex).doubleValue()
    val histVal = macdVal - signalVal

    val rsiVal = if (series.endIndex + 1 >= 2) RSIIndicator(close, 14).getValue(series.endIndex).doubleValue() else null

    val sma20 = SMAIndicator(close, 20)
    val middle = BollingerBandsMiddleIndicator(sma20)
    val stdDev = StandardDeviationIndicator(close, 20)
    val upperIndicator = BollingerBandsUpperIndicator(middle, stdDev)
    val lowerIndicator = BollingerBandsLowerIndicator(middle, stdDev)
    val boll =
      if (series.endIndex + 1 >= 20) {
        ai.proompteng.dorvud.ta.stream.Bollinger(
          mid = middle.getValue(series.endIndex).doubleValue(),
          upper = upperIndicator.getValue(series.endIndex).doubleValue(),
          lower = lowerIndicator.getValue(series.endIndex).doubleValue(),
        )
      } else {
        null
      }

    val vwapSession = session.value()
    val vwap5m = rollingVwap(bars, config.vwapWindow)
    val realizedVol = realizedVol(series, config.realizedVolWindow)

    val quote = quoteState.value()
    val imbalance =
      quote?.let {
        val spread = it.ap - it.bp
        ai.proompteng.dorvud.ta.stream.Imbalance(
          spread = spread,
          bid_px = it.bp,
          ask_px = it.ap,
          bid_sz = it.bs,
          ask_sz = it.`as`,
        )
      }

    val payload =
      TaSignalsPayload(
        macd =
          ai.proompteng.dorvud.ta.stream
            .Macd(macd = macdVal, signal = signalVal, hist = histVal),
        ema =
          ai.proompteng.dorvud.ta.stream
            .Ema(ema12 = ema12, ema26 = ema26),
        rsi14 = rsiVal,
        boll = boll,
        vwap =
          ai.proompteng.dorvud.ta.stream
            .Vwap(session = vwapSession, w5m = vwap5m),
        imbalance = imbalance,
        vol_realized =
          realizedVol?.let {
            ai.proompteng.dorvud.ta.stream
              .RealizedVol(it)
          },
      )

    val window =
      envelope.window
        ?: Window(
          size = "PT1S",
          step = "PT1S",
          start =
            envelope.payload.t
              .minusSeconds(1)
              .toString(),
          end = envelope.payload.t.toString(),
        )
    return envelope.withPayload(payload, window = window, seqOverride = envelope.seq)
  }

  private fun rollingVwap(
    bars: List<MicroBarPayload>,
    window: Duration,
  ): Double? {
    val cutoff = bars.lastOrNull()?.t?.minus(window) ?: return null
    var pv = 0.0
    var vol = 0.0
    bars.filter { it.t.isAfter(cutoff) || it.t == cutoff }.forEach { bar ->
      pv += bar.c * bar.v
      vol += bar.v
    }
    if (vol == 0.0) return null
    return pv / vol
  }

  private fun realizedVol(
    series: BaseBarSeries,
    window: Int,
  ): Double? {
    if (series.barCount < 2) return null
    val end = series.endIndex
    val start = (series.barCount - window).coerceAtLeast(1)
    val returns = mutableListOf<Double>()
    var prevClose = series.getBar(start - 1).closePrice.doubleValue()
    for (i in start..end) {
      val close = series.getBar(i).closePrice.doubleValue()
      returns += kotlin.math.ln(close / prevClose)
      prevClose = close
    }
    if (returns.isEmpty()) return null
    val mean = returns.average()
    val variance = returns.map { (it - mean) * (it - mean) }.average()
    return kotlin.math.sqrt(variance)
  }
}

data class SessionAccumulatorState(
  var pv: Double = 0.0,
  var vol: Double = 0.0,
) : Serializable {
  fun value(): Double = if (vol == 0.0) 0.0 else pv / vol
}
