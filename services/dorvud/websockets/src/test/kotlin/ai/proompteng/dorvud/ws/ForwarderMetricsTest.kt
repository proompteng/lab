package ai.proompteng.dorvud.ws

import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ForwarderMetricsTest {
  @Test
  fun `records desired symbols fetch success and failure metrics`() {
    val registry = SimpleMeterRegistry()
    val metrics = ForwarderMetrics(registry)

    metrics.recordDesiredSymbolsFetchSuccess()
    metrics.recordDesiredSymbolsFetchFailure("fetch_error")
    metrics.recordDesiredSymbolsFetchFailure("empty_result")

    assertEquals(
      1.0,
      registry
        .find("torghut_ws_desired_symbols_fetch_success_total")
        .counter()
        ?.count(),
    )
    assertEquals(
      1.0,
      registry
        .find("torghut_ws_desired_symbols_fetch_failures_total")
        .tag("reason", "fetch_error")
        .counter()
        ?.count(),
    )
    assertEquals(
      1.0,
      registry
        .find("torghut_ws_desired_symbols_fetch_failures_total")
        .tag("reason", "empty_result")
        .counter()
        ?.count(),
    )
  }

  @Test
  fun `tracks degraded and last timestamp gauges for desired symbols fetch`() {
    val registry = SimpleMeterRegistry()
    val metrics = ForwarderMetrics(registry)

    metrics.recordDesiredSymbolsFetchFailure("fetch_error")
    val degradedAfterFailure =
      registry
        .find("torghut_ws_desired_symbols_fetch_degraded")
        .gauge()
        ?.value()
    assertEquals(1.0, degradedAfterFailure)

    val lastFailureTs =
      registry
        .find("torghut_ws_desired_symbols_fetch_last_failure_ts_seconds")
        .gauge()
        ?.value()
    assertTrue((lastFailureTs ?: 0.0) > 0.0)

    metrics.recordDesiredSymbolsFetchSuccess()
    val degradedAfterSuccess =
      registry
        .find("torghut_ws_desired_symbols_fetch_degraded")
        .gauge()
        ?.value()
    assertEquals(0.0, degradedAfterSuccess)

    val lastSuccessTs =
      registry
        .find("torghut_ws_desired_symbols_fetch_last_success_ts_seconds")
        .gauge()
        ?.value()
    assertTrue((lastSuccessTs ?: 0.0) > 0.0)
  }
}
