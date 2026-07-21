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

  @Test
  fun `records provider messages and options event starvation gauge`() {
    val registry = SimpleMeterRegistry()
    val metrics = ForwarderMetrics(registry)

    metrics.recordProviderMessage(AlpacaMarketType.OPTIONS, "opra", "quote")
    metrics.recordMarketDataDrop(AlpacaMarketType.OPTIONS, "opra", "quote", "invalid_event_ts")
    metrics.setOptionsEventStarvation(true)

    assertEquals(
      1.0,
      registry
        .find("torghut_ws_provider_messages_total")
        .tag("market_type", "options")
        .tag("feed", "opra")
        .tag("channel", "quote")
        .counter()
        ?.count(),
    )
    assertEquals(
      1.0,
      registry
        .find("torghut_ws_market_data_drops_total")
        .tag("market_type", "options")
        .tag("feed", "opra")
        .tag("channel", "quote")
        .tag("reason", "invalid_event_ts")
        .counter()
        ?.count(),
    )
    assertEquals(
      1.0,
      registry
        .find("torghut_ws_options_event_starvation")
        .gauge()
        ?.value(),
    )

    metrics.setOptionsEventStarvation(false)
    assertEquals(
      0.0,
      registry
        .find("torghut_ws_options_event_starvation")
        .gauge()
        ?.value(),
    )
  }

  @Test
  fun `keeps market data operational metrics isolated by feed`() {
    val registry = SimpleMeterRegistry()
    val metrics = ForwarderMetrics(registry)

    metrics.recordMarketDataReconnect("overnight")
    metrics.recordMarketDataWsConnectSuccess("overnight")
    metrics.recordMarketDataWsConnectError("overnight", ReadinessErrorClass.AlpacaAuth)
    metrics.recordMarketDataDedup("overnight", "bars")
    metrics.recordMarketDataLagMs("overnight", "bars", 42)

    assertEquals(
      1.0,
      registry
        .find("torghut_ws_market_data_reconnects_total")
        .tag("feed", "overnight")
        .counter()
        ?.count(),
    )
    assertEquals(
      1.0,
      registry
        .find("torghut_ws_market_data_connect_success_total")
        .tag("feed", "overnight")
        .counter()
        ?.count(),
    )
    assertEquals(
      1.0,
      registry
        .find("torghut_ws_market_data_connect_errors_total")
        .tag("feed", "overnight")
        .tag("error_class", ReadinessErrorClass.AlpacaAuth.id)
        .counter()
        ?.count(),
    )
    assertEquals(
      1.0,
      registry
        .find("torghut_ws_market_data_dedup_drops_total")
        .tag("feed", "overnight")
        .tag("channel", "bars")
        .counter()
        ?.count(),
    )
    assertEquals(
      1.0,
      registry
        .find("torghut_ws_market_data_lag_ms")
        .tag("feed", "overnight")
        .tag("channel", "bars")
        .summary()
        ?.count()
        ?.toDouble(),
    )
  }

  @Test
  fun `records market data channel readiness gauges`() {
    val registry = SimpleMeterRegistry()
    val metrics = ForwarderMetrics(registry)

    metrics.setMarketDataChannelReadiness(
      "delayed_sip",
      listOf(
        MarketDataChannelReadiness(
          channel = "trades",
          ready = false,
          required = true,
          gateActive = true,
          marketSessionState = "regular",
          latestProviderEventAtMs = 100,
          latestSerializedAtMs = 110,
          latestKafkaSuccessAtMs = null,
          latestSubscriptionAckAtMs = 90,
          subscribedSymbolCount = 2,
          subscribedSymbols = listOf("AMD", "NVDA"),
          observedSymbolCount = 1,
          observedSymbols = listOf("NVDA"),
          subscriptionAckLagMs = 20,
          lagMs = null,
          maxLagMs = 60_000,
          reason = "market_data_channel_missing_kafka_success",
        ),
      ),
    )

    assertEquals(
      0.0,
      registry
        .find("torghut_ws_market_data_channel")
        .tag("feed", "delayed_sip")
        .tag("channel", "trades")
        .tag("field", "ready")
        .gauge()
        ?.value(),
    )
    assertEquals(
      -1.0,
      registry
        .find("torghut_ws_market_data_channel")
        .tag("feed", "delayed_sip")
        .tag("channel", "trades")
        .tag("field", "lag_ms")
        .gauge()
        ?.value(),
    )
    assertEquals(
      1.0,
      registry
        .find("torghut_ws_market_data_channel")
        .tag("feed", "delayed_sip")
        .tag("channel", "trades")
        .tag("field", "observed_symbol_count")
        .gauge()
        ?.value(),
    )
    assertEquals(
      90.0,
      registry
        .find("torghut_ws_market_data_channel")
        .tag("feed", "delayed_sip")
        .tag("channel", "trades")
        .tag("field", "latest_subscription_ack_at_ms")
        .gauge()
        ?.value(),
    )
    assertEquals(
      20.0,
      registry
        .find("torghut_ws_market_data_channel")
        .tag("feed", "delayed_sip")
        .tag("channel", "trades")
        .tag("field", "subscription_ack_lag_ms")
        .gauge()
        ?.value(),
    )
  }
}
