package ai.proompteng.dorvud.ta

import ai.proompteng.dorvud.platform.SeqTracker
import ai.proompteng.dorvud.ta.config.TaServiceConfig
import ai.proompteng.dorvud.ta.engine.TaEngine
import ai.proompteng.dorvud.ta.producer.AvroSerde
import ai.proompteng.dorvud.ta.stream.MicroBarAggregator
import ai.proompteng.dorvud.ta.stream.TechnicalAnalysisService
import ai.proompteng.dorvud.ta.stream.TradePayload
import java.time.Instant
import java.util.Properties
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertTrue
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.apache.kafka.clients.consumer.ConsumerConfig
import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.KafkaProducer
import org.apache.kafka.clients.producer.ProducerConfig
import org.apache.kafka.clients.producer.ProducerRecord
import org.apache.kafka.common.serialization.StringDeserializer
import org.apache.kafka.common.serialization.StringSerializer
import org.testcontainers.containers.KafkaContainer
import org.testcontainers.utility.DockerImageName
import io.github.oshai.kotlinlogging.KotlinLogging
import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.Window
import io.micrometer.core.instrument.simple.SimpleMeterRegistry

class TechnicalAnalysisIntegrationTest {
  private val kafka = KafkaContainer(DockerImageName.parse("confluentinc/cp-kafka:7.5.4"))
  private val json = Json { ignoreUnknownKeys = true }
  private lateinit var serviceJob: Job
  private lateinit var service: TechnicalAnalysisService
  private lateinit var producer: KafkaProducer<String, String>
  private lateinit var outputConsumer: KafkaConsumer<String, String>

  @BeforeTest
  fun setUp() {
    kafka.start()
    val cfg = TaServiceConfig(
      bootstrapServers = kafka.bootstrapServers,
      tradesTopic = "torghut.TEST.trades.v1",
      microBarsTopic = "torghut.TEST.ta.bars.1s.v1",
      signalsTopic = "torghut.TEST.ta.signals.v1",
      quotesTopic = null,
      groupId = "ta-it",
      clientId = "ta-it",
    )

    val consumer = KafkaConsumer<String, String>(consumerProps(cfg, earliest = true)).apply {
      subscribe(listOf(cfg.tradesTopic))
    }
    producer = KafkaProducer(producerProps(cfg))

    outputConsumer = KafkaConsumer<String, String>(outputProps(cfg)).apply {
      subscribe(listOf(cfg.microBarsTopic, cfg.signalsTopic))
    }

    service = TechnicalAnalysisService(
      config = cfg,
      consumer = consumer,
      producer = producer,
      aggregator = MicroBarAggregator(),
      engine = TaEngine(cfg),
      seqTracker = SeqTracker(),
      avro = AvroSerde(),
      registry = SimpleMeterRegistry(),
      logger = KotlinLogging.logger("ta-it"),
    )

    serviceJob = service.start()
  }

  @AfterTest
  fun tearDown() = runBlocking {
    service.stop()
    serviceJob.cancelAndJoin()
    producer.close()
    outputConsumer.close()
    kafka.stop()
  }

  @Test
  fun `consumes trades and produces bars and signals`() = runBlocking {
    val now = Instant.parse("2025-01-01T00:00:00Z")
    repeat(3) { idx ->
      val envelope = Envelope(
        ingestTs = now.plusSeconds(idx.toLong()),
        eventTs = now.plusSeconds(idx.toLong()),
        feed = "alpaca",
        channel = "trades",
        symbol = "TEST",
        seq = idx.toLong(),
        payload = TradePayload(p = 100.0 + idx, s = 10, t = now.plusSeconds(idx.toLong())),
        isFinal = true,
        source = "it",
        window = Window(size = "PT1S", step = "PT1S", start = now.toString(), end = now.plusSeconds(idx.toLong() + 1).toString()),
        version = 1,
      )
      val payload = json.encodeToString(envelope)
      producer.send(ProducerRecord("torghut.TEST.trades.v1", envelope.symbol, payload))
    }

    // allow consumer loop to process
    delay(3_000)

    val records = outputConsumer.poll(java.time.Duration.ofSeconds(5))
    val barRecords = records.records("torghut.TEST.ta.bars.1s.v1").count()
    val signalRecords = records.records("torghut.TEST.ta.signals.v1").count()
    assertTrue(barRecords > 0, "expected micro-bar output")
    assertTrue(signalRecords > 0, "expected signal output")
  }
}

private fun consumerProps(cfg: TaServiceConfig, earliest: Boolean = false): Properties = Properties().apply {
  put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, cfg.bootstrapServers)
  put(ConsumerConfig.GROUP_ID_CONFIG, cfg.groupId)
  put(ConsumerConfig.CLIENT_ID_CONFIG, cfg.clientId)
  put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer::class.java)
  put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer::class.java)
  put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, if (earliest) "earliest" else cfg.autoOffsetReset)
  put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_committed")
}

private fun producerProps(cfg: TaServiceConfig): Properties = Properties().apply {
  put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, cfg.bootstrapServers)
  put(ProducerConfig.CLIENT_ID_CONFIG, cfg.clientId)
  put(ProducerConfig.ACKS_CONFIG, "all")
  put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true)
  put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5)
  put(ProducerConfig.LINGER_MS_CONFIG, 5)
  put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer::class.java)
  put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer::class.java)
}

private fun outputProps(cfg: TaServiceConfig): Properties = Properties().apply {
  put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, cfg.bootstrapServers)
  put(ConsumerConfig.GROUP_ID_CONFIG, "ta-it-out")
  put(ConsumerConfig.CLIENT_ID_CONFIG, "ta-it-out")
  put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer::class.java)
  put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer::class.java)
  put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
}
