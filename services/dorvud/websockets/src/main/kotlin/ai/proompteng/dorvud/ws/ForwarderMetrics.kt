package ai.proompteng.dorvud.ws

import io.micrometer.core.instrument.Counter
import io.micrometer.core.instrument.DistributionSummary
import io.micrometer.core.instrument.Gauge
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

internal class ForwarderMetrics(
  private val registry: MeterRegistry,
) {
  private val dedupCounters = ConcurrentHashMap<String, Counter>()
  private val readinessErrorCounters = ConcurrentHashMap<String, Counter>()
  private val wsConnectErrorCounters = ConcurrentHashMap<String, Counter>()
  private val kafkaProduceErrorCounters = ConcurrentHashMap<String, Counter>()
  private val kafkaProduceSuccessCounters = ConcurrentHashMap<String, Counter>()
  private val kafkaMetadataErrorCounters = ConcurrentHashMap<String, Counter>()

  private val readinessStatus = AtomicInteger(0)

  private val lagSummary: DistributionSummary =
    DistributionSummary
      .builder("torghut_ws_lag_ms")
      .publishPercentileHistogram()
      .register(registry)

  private val kafkaLatency: Timer =
    Timer
      .builder("torghut_ws_kafka_send_latency")
      .publishPercentileHistogram()
      .register(registry)

  val reconnects: Counter = registry.counter("torghut_ws_reconnects_total")
  val kafkaSendErrors: Counter = registry.counter("torghut_ws_kafka_send_errors_total")
  val wsConnectSuccess: Counter = registry.counter("torghut_ws_ws_connect_success_total")

  init {
    Gauge
      .builder("torghut_ws_readyz_status", readinessStatus) { it.get().toDouble() }
      .register(registry)
  }

  fun setReady(ready: Boolean) {
    readinessStatus.set(if (ready) 1 else 0)
  }

  fun recordReadinessError(errorClass: ReadinessErrorClass) {
    readinessErrorCounters
      .computeIfAbsent(errorClass.id) { cls ->
        Counter
          .builder("torghut_ws_readiness_errors_total")
          .tag("error_class", cls)
          .register(registry)
      }.increment()
  }

  fun recordWsConnectError(errorClass: ReadinessErrorClass) {
    wsConnectErrorCounters
      .computeIfAbsent(errorClass.id) { cls ->
        Counter
          .builder("torghut_ws_ws_connect_errors_total")
          .tag("error_class", cls)
          .register(registry)
      }.increment()
  }

  fun recordKafkaProduceSuccess(topic: String) {
    kafkaProduceSuccessCounters
      .computeIfAbsent(topic) { t ->
        Counter
          .builder("torghut_ws_kafka_produce_success_total")
          .tag("topic", t)
          .register(registry)
      }.increment()
  }

  fun recordKafkaProduceError(
    topic: String,
    errorClass: ReadinessErrorClass,
  ) {
    kafkaProduceErrorCounters
      .computeIfAbsent("$topic|${errorClass.id}") { key ->
        val parts = key.split("|", limit = 2)
        Counter
          .builder("torghut_ws_kafka_produce_errors_total")
          .tag("topic", parts[0])
          .tag("error_class", parts[1])
          .register(registry)
      }.increment()
  }

  fun recordKafkaMetadataError(errorClass: ReadinessErrorClass) {
    kafkaMetadataErrorCounters
      .computeIfAbsent(errorClass.id) { cls ->
        Counter
          .builder("torghut_ws_kafka_metadata_errors_total")
          .tag("error_class", cls)
          .register(registry)
      }.increment()
  }

  fun recordLagMs(lagMs: Long) {
    if (lagMs < 0) return
    lagSummary.record(lagMs.toDouble())
  }

  fun recordKafkaLatency(duration: Duration) {
    kafkaLatency.record(duration)
  }

  fun recordDedup(channel: String) {
    dedupCounters
      .computeIfAbsent(channel) { dedupChannel ->
        Counter
          .builder("torghut_ws_dedup_drops_total")
          .tag("channel", dedupChannel)
          .register(registry)
      }.increment()
  }
}
