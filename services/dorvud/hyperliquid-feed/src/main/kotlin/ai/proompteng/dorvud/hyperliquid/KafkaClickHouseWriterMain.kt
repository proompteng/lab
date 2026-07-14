package ai.proompteng.dorvud.hyperliquid

import ai.proompteng.dorvud.platform.Metrics
import ai.proompteng.dorvud.platform.buildConsumer
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import kotlinx.serialization.json.Json
import mu.KotlinLogging
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.system.exitProcess

private val kafkaWriterMainLogger = KotlinLogging.logger {}

internal fun runKafkaClickHouseWriter() {
  val config =
    runCatching { KafkaClickHouseWriterConfig.fromEnv() }
      .getOrElse { error ->
        kafkaWriterMainLogger.error(error) { "invalid Kafka ClickHouse writer configuration" }
        exitProcess(2)
      }
  val json =
    Json {
      encodeDefaults = true
      ignoreUnknownKeys = true
      explicitNulls = false
    }
  val state =
    KafkaClickHouseWriterState(
      readinessMaxAgeMs = config.readinessMaxAgeMs,
      readinessMaxPartitionLagRecords = config.readinessMaxPartitionLagRecords,
    )
  val metrics = KafkaClickHouseWriterMetrics(Metrics.registry)
  val store = HttpKafkaClickHouseStore(config.clickHouse, HttpClient(CIO), json)
  val writer =
    KafkaClickHouseWriter(
      config = config,
      consumer = buildConsumer(config.kafka),
      store = store,
      state = state,
      metrics = metrics,
      json = json,
    )
  val health = KafkaClickHouseWriterHealthServer(state, config)
  val stopped = CountDownLatch(1)
  health.start()
  Runtime.getRuntime().addShutdownHook(
    Thread {
      writer.stop()
      val timeoutMs = config.shutdownFlushTimeoutMs + config.consumerCloseTimeoutMs + 5_000
      if (!stopped.await(timeoutMs, TimeUnit.MILLISECONDS)) {
        kafkaWriterMainLogger.error { "Kafka ClickHouse writer did not stop within ${timeoutMs}ms" }
        health.stop()
      }
    },
  )
  try {
    writer.run()
  } finally {
    stopped.countDown()
    health.stop()
  }
}
