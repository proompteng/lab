package ai.proompteng.dorvud.ta

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.SeqTracker
import ai.proompteng.dorvud.platform.Window
import ai.proompteng.dorvud.ta.config.TaServiceConfig
import ai.proompteng.dorvud.ta.engine.TaEngine
import ai.proompteng.dorvud.ta.producer.AvroSerde
import ai.proompteng.dorvud.ta.stream.MicroBarAggregator
import ai.proompteng.dorvud.ta.stream.TechnicalAnalysisService
import ai.proompteng.dorvud.ta.stream.TradePayload
import io.github.oshai.kotlinlogging.KotlinLogging
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
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
import org.apache.kafka.common.serialization.ByteArrayDeserializer
import org.apache.kafka.common.serialization.ByteArraySerializer
import org.apache.kafka.common.serialization.StringDeserializer
import org.apache.kafka.common.serialization.StringSerializer
import org.testcontainers.containers.KafkaContainer
import org.testcontainers.utility.DockerImageName
import java.time.Instant
import java.util.Properties
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertTrue

class TechnicalAnalysisIntegrationTest {
  private lateinit var kafka: KafkaContainer
  private val json = Json { ignoreUnknownKeys = true }
  private lateinit var serviceJob: Job
  private lateinit var service: TechnicalAnalysisService
  private lateinit var inputProducer: KafkaProducer<String, String>
  private lateinit var taProducer: KafkaProducer<String, ByteArray>
  private lateinit var outputConsumer: KafkaConsumer<String, ByteArray>
  private var started = false

  @BeforeTest
  fun setUp() {
    // Docker Desktop 29+ rejects very old API versions; pin a modern API so Testcontainers negotiates correctly.
    // Hint docker-java to use a modern API version; older defaults (1.32) return 400 on Docker Desktop 29+.
    System.setProperty("DOCKER_API_VERSION", "1.52")
    System.setProperty("docker.api.version", "1.52")
    val dockerSocketDefault = "unix://${System.getProperty("user.home")}/.docker/run/docker.sock"
    val dockerHost = System.getenv("DOCKER_HOST") ?: dockerSocketDefault
    val socketOverride =
      System.getenv("TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE")
        ?: "${System.getProperty("user.home")}/.docker/run/docker.sock"
    System.setProperty("DOCKER_HOST", dockerHost)
    System.setProperty("docker.host", dockerHost)
    System.setProperty("TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE", socketOverride)
    kafka = KafkaContainer(DockerImageName.parse("confluentinc/cp-kafka:7.5.4"))
    kafka.start()
    val cfg =
      TaServiceConfig(
        bootstrapServers = kafka.bootstrapServers,
        tradesTopic = "torghut.TEST.trades.v1",
        microBarsTopic = "torghut.TEST.ta.bars.1s.v1",
        signalsTopic = "torghut.TEST.ta.signals.v1",
        quotesTopic = null,
        groupId = "ta-it",
        clientId = "ta-it",
      )

    val consumer =
      KafkaConsumer<String, String>(consumerProps(cfg, earliest = true)).apply {
        subscribe(listOf(cfg.tradesTopic))
      }
    inputProducer = KafkaProducer(producerProps(cfg))
    taProducer = KafkaProducer(producerBytesProps(cfg))

    outputConsumer =
      KafkaConsumer<String, ByteArray>(outputProps(cfg)).apply {
        subscribe(listOf(cfg.microBarsTopic, cfg.signalsTopic))
      }

    service =
      TechnicalAnalysisService(
        config = cfg,
        consumer = consumer,
        producer = taProducer,
        aggregator = MicroBarAggregator(),
        engine = TaEngine(cfg),
        seqTracker = SeqTracker(),
        avro = AvroSerde(),
        registry = SimpleMeterRegistry(),
        logger = KotlinLogging.logger("ta-it"),
      )

    serviceJob = service.start()
    started = true
  }

  @AfterTest
  fun tearDown() =
    runBlocking {
      if (started) {
        service.stop()
        serviceJob.cancelAndJoin()
        inputProducer.close()
        taProducer.close()
        outputConsumer.close()
        kafka.stop()
      }
    }

  @Test
  fun `consumes trades and produces bars and signals`() =
    runBlocking {
      val now = Instant.parse("2025-01-01T00:00:00Z")
      repeat(3) { idx ->
        val envelope =
          Envelope(
            ingestTs = now.plusSeconds(idx.toLong()),
            eventTs = now.plusSeconds(idx.toLong()),
            feed = "alpaca",
            channel = "trades",
            symbol = "TEST",
            seq = idx.toLong(),
            payload = TradePayload(p = 100.0 + idx, s = 10.0, t = now.plusSeconds(idx.toLong())),
            isFinal = true,
            source = "it",
            window =
              Window(
                size = "PT1S",
                step = "PT1S",
                start = now.toString(),
                end = now.plusSeconds(idx.toLong() + 1).toString(),
              ),
            version = 1,
          )
        val payload = json.encodeToString(envelope)
        inputProducer.send(ProducerRecord("torghut.TEST.trades.v1", envelope.symbol, payload))
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

private fun consumerProps(
  cfg: TaServiceConfig,
  earliest: Boolean = false,
): Properties =
  Properties().apply {
    put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, cfg.bootstrapServers)
    put(ConsumerConfig.GROUP_ID_CONFIG, cfg.groupId)
    put(ConsumerConfig.CLIENT_ID_CONFIG, cfg.clientId)
    put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer::class.java)
    put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer::class.java)
    put(
      ConsumerConfig.AUTO_OFFSET_RESET_CONFIG,
      if (earliest) "earliest" else cfg.autoOffsetReset,
    )
    put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_committed")
  }

private fun producerProps(cfg: TaServiceConfig): Properties =
  Properties().apply {
    put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, cfg.bootstrapServers)
    put(ProducerConfig.CLIENT_ID_CONFIG, cfg.clientId)
    put(ProducerConfig.ACKS_CONFIG, "all")
    put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true)
    put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5)
    put(ProducerConfig.LINGER_MS_CONFIG, 5)
    put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer::class.java)
    put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer::class.java)
  }

private fun producerBytesProps(cfg: TaServiceConfig): Properties =
  Properties().apply {
    put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, cfg.bootstrapServers)
    put(ProducerConfig.CLIENT_ID_CONFIG, cfg.clientId)
    put(ProducerConfig.ACKS_CONFIG, "all")
    put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true)
    put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5)
    put(ProducerConfig.LINGER_MS_CONFIG, 5)
    put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer::class.java)
    put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, ByteArraySerializer::class.java)
  }

private fun outputProps(cfg: TaServiceConfig): Properties =
  Properties().apply {
    put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, cfg.bootstrapServers)
    put(ConsumerConfig.GROUP_ID_CONFIG, "ta-it-out")
    put(ConsumerConfig.CLIENT_ID_CONFIG, "ta-it-out")
    put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer::class.java)
    put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, ByteArrayDeserializer::class.java)
    put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
  }
