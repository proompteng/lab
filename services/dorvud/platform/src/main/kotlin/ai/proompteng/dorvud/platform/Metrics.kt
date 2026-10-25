package ai.proompteng.dorvud.platform

import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.prometheusmetrics.PrometheusConfig
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry

object Metrics {
  val registry: MeterRegistry = PrometheusMeterRegistry(PrometheusConfig.DEFAULT)
}
