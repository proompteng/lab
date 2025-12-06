package ai.proompteng.dorvud.ta.stream

import ai.proompteng.dorvud.platform.SeqTracker
import ai.proompteng.dorvud.platform.Window
import ai.proompteng.dorvud.ta.config.TaServiceConfig
import ai.proompteng.dorvud.ta.engine.TaEngine
import ai.proompteng.dorvud.ta.producer.AvroSerde
import io.github.oshai.kotlinlogging.KLogger
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import org.apache.kafka.clients.consumer.ConsumerRecord
import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.KafkaProducer
import org.apache.kafka.clients.producer.ProducerRecord

/**
 * Main event loop: consume trades/quotes, emit 1s bars and derived signals.
 */
class TechnicalAnalysisService(
  private val config: TaServiceConfig,
  private val consumer: KafkaConsumer<String, String>,
  private val producer: KafkaProducer<String, String>,
  private val aggregator: MicroBarAggregator,
  private val engine: TaEngine,
  private val seqTracker: SeqTracker,
  private val avro: AvroSerde,
  private val registry: MeterRegistry,
  private val logger: KLogger,
) {
  private val scope = CoroutineScope(Dispatchers.IO)
  private val json = Json { ignoreUnknownKeys = true }
  private val lagTimer: Timer = registry.timer("ta_lag_seconds")

  fun start(): Job = scope.launch {
    logger.info { "technical-analysis service started" }
    while (isActive) {
      val records = consumer.poll(Duration.ofMillis(250))
      for (record in records) {
        handleRecord(record)
      }
    }
  }

  suspend fun stop() {
    logger.info { "stopping technical-analysis service" }
    scope.coroutineContext[Job]?.cancelAndJoin()
    consumer.close()
    producer.flush()
    producer.close()
  }

  private fun handleRecord(record: ConsumerRecord<String, String>) {
    when {
      record.topic() == config.tradesTopic -> handleTrade(record)
      record.topic() == config.quotesTopic -> handleQuote(record)
      else -> logger.debug { "skipping topic ${record.topic()}" }
    }
  }

  private fun handleTrade(record: ConsumerRecord<String, String>) {
    val envelope = runCatching { json.decodeFromString<EnvelopeWrapper<TradePayload>>(record.value()) }
      .getOrElse {
        logger.warn(it) { "failed to decode trade payload" }
        return
      }

    val flushed = aggregator.onTrade(envelope.toEnvelope())
    flushed.forEach { barEnv ->
      val seq = seqTracker.next(barEnv.symbol)
      val envWithSeq = barEnv.copy(seq = seq)
      produceMicroBar(envWithSeq)
      engine.onMicroBar(envWithSeq)?.let { signal ->
        produceSignal(signal.copy(seq = seq))
      }
      val lag = Duration.between(barEnv.eventTs, Instant.now()).toMillis().toDouble() / 1000.0
      lagTimer.record(Duration.ofMillis(lag.toLong()))
    }
  }

  private fun handleQuote(record: ConsumerRecord<String, String>) {
    if (config.quotesTopic == null) return
    val envelope = runCatching { json.decodeFromString<EnvelopeWrapper<QuotePayload>>(record.value()) }
      .getOrElse {
        logger.warn(it) { "failed to decode quote payload" }
        return
      }
    engine.onQuote(envelope.toEnvelope())
  }

  private fun produceMicroBar(env: ai.proompteng.dorvud.platform.Envelope<MicroBarPayload>) {
    val payloadJson = avro.toJson(env)
    val record = ProducerRecord(config.microBarsTopic, env.symbol, payloadJson)
    producer.send(record)
    registry.counter("ta_microbars_emitted_total").increment()
  }

  private fun produceSignal(env: ai.proompteng.dorvud.platform.Envelope<TaSignalsPayload>) {
    val payloadJson = avro.signalJson(env)
    val record = ProducerRecord(config.signalsTopic, env.symbol, payloadJson)
    producer.send(record)
    registry.counter("ta_signals_emitted_total").increment()
  }
}

// Local wrapper to match Envelope serialization without reusing platform serializer generics
@kotlinx.serialization.Serializable
private data class EnvelopeWrapper<T>(
  @kotlinx.serialization.Serializable(with = ai.proompteng.dorvud.platform.InstantIsoSerializer::class)
  val ingestTs: Instant,
  @kotlinx.serialization.Serializable(with = ai.proompteng.dorvud.platform.InstantIsoSerializer::class)
  val eventTs: Instant,
  val feed: String,
  val channel: String,
  val symbol: String,
  val seq: Long,
  val payload: T,
  val isFinal: Boolean = true,
  val source: String = "ws",
  val window: Window? = null,
  val version: Int = 1,
) {
  fun toEnvelope(): ai.proompteng.dorvud.platform.Envelope<T> =
    ai.proompteng.dorvud.platform.Envelope(
      ingestTs = ingestTs,
      eventTs = eventTs,
      feed = feed,
      channel = channel,
      symbol = symbol,
      seq = seq,
      payload = payload,
      isFinal = isFinal,
      source = source,
      window = window,
      version = version,
    )
}
