package ai.proompteng.dorvud.ta.di

import ai.proompteng.dorvud.platform.Metrics
import ai.proompteng.dorvud.platform.SeqTracker
import ai.proompteng.dorvud.ta.config.ConfigLoader
import ai.proompteng.dorvud.ta.config.TaServiceConfig
import ai.proompteng.dorvud.ta.engine.TaEngine
import ai.proompteng.dorvud.ta.producer.AvroSerde
import ai.proompteng.dorvud.ta.server.HttpServer
import ai.proompteng.dorvud.ta.stream.MicroBarAggregator
import ai.proompteng.dorvud.ta.stream.TechnicalAnalysisService
import com.typesafe.config.ConfigFactory
import io.github.oshai.kotlinlogging.KLogger
import io.github.oshai.kotlinlogging.KotlinLogging
import java.util.Properties
import org.apache.kafka.clients.consumer.ConsumerConfig
import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.clients.producer.KafkaProducer
import org.apache.kafka.clients.producer.ProducerConfig
import org.apache.kafka.common.serialization.StringDeserializer
import org.apache.kafka.common.serialization.StringSerializer
import org.koin.core.module.dsl.singleOf
import org.koin.dsl.module

val taModule = module {
  single<TaServiceConfig> { ConfigLoader.load() }
  single { ConfigFactory.load() }

  single<KLogger> { KotlinLogging.logger("torghut-ta") }

  singleOf(::SeqTracker)
  singleOf(::MicroBarAggregator)
  singleOf(::TaEngine)
  singleOf(::AvroSerde)
  single { Metrics.registry }

  single {
    val cfg: TaServiceConfig = get()
    KafkaConsumer<String, String>(consumerProps(cfg)).also { consumer ->
      val topics = listOfNotNull(cfg.tradesTopic, cfg.quotesTopic, cfg.bars1mTopic)
      consumer.subscribe(topics)
    }
  }

  single {
    val cfg: TaServiceConfig = get()
    KafkaProducer<String, String>(producerProps(cfg))
  }

  single { HttpServer(get(), get(), get()) }

  single {
    val cfg: TaServiceConfig = get()
    TechnicalAnalysisService(
      config = cfg,
      consumer = get(),
      producer = get(),
      aggregator = get(),
      engine = get(),
      seqTracker = get(),
      avro = get(),
      registry = get(),
      logger = get(),
    )
  }
}

private fun consumerProps(cfg: TaServiceConfig): Properties = Properties().apply {
  put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, cfg.bootstrapServers)
  put(ConsumerConfig.GROUP_ID_CONFIG, cfg.groupId)
  put(ConsumerConfig.CLIENT_ID_CONFIG, cfg.clientId)
  put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer::class.java)
  put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer::class.java)
  put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, cfg.autoOffsetReset)
  put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, true)
  put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_committed")
  put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, 500)
  cfg.saslMechanism?.let {
    put("security.protocol", cfg.securityProtocol)
    put("sasl.mechanism", cfg.saslMechanism)
    put(
      "sasl.jaas.config",
      "org.apache.kafka.common.security.scram.ScramLoginModule required username=\"${cfg.saslUsername}\" password=\"${cfg.saslPassword}\";",
    )
  }
}

private fun producerProps(cfg: TaServiceConfig): Properties = Properties().apply {
  put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, cfg.bootstrapServers)
  put(ProducerConfig.CLIENT_ID_CONFIG, cfg.clientId)
  put(ProducerConfig.ACKS_CONFIG, "all")
  put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true)
  put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5)
  put(ProducerConfig.LINGER_MS_CONFIG, 20)
  put(ProducerConfig.BATCH_SIZE_CONFIG, 32768)
  put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "lz4")
  put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer::class.java)
  put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer::class.java)
  cfg.saslMechanism?.let {
    put("security.protocol", cfg.securityProtocol)
    put("sasl.mechanism", cfg.saslMechanism)
    put(
      "sasl.jaas.config",
      "org.apache.kafka.common.security.scram.ScramLoginModule required username=\"${cfg.saslUsername}\" password=\"${cfg.saslPassword}\";",
    )
  }
}
