package ai.proompteng.dorvud.ws

import io.micrometer.core.instrument.Counter
import io.micrometer.core.instrument.DistributionSummary
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap

internal class ForwarderMetrics(
  private val registry: MeterRegistry,
) {
  private val dedupCounters = ConcurrentHashMap<String, Counter>()

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
