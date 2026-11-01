package ai.proompteng.dorvud.ws

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MarketDataFeedReadinessTest {
  @Test
  fun `closed crypto session cannot remain ready while websocket cleanup is pending`() {
    val config =
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "SYMBOLS" to "SPY",
          "ALPACA_CRYPTO_SYMBOLS" to "BTC/USD",
          "TOPIC_CRYPTO_EVENTS" to "crypto-events",
        ),
      )
    val state =
      MarketDataFeedRuntimeState(
        config.marketDataFeedConfigs().single { it.marketType == AlpacaMarketType.CRYPTO },
        config,
      ) { Instant.parse("2026-10-31T10:27:22Z").toEpochMilli() }
    state.kafkaReady.set(true)
    state.websocketReady.set(true)
    state.websocketStatus.set(AlpacaMarketDataWebsocketStatus(authOk = true, subscriptionOk = true))
    assertTrue(state.readiness().ready)

    state.channelFreshness.clearSubscription()
    state.websocketStatus.set(AlpacaMarketDataWebsocketStatus())

    val disconnected = state.readiness()
    assertFalse(disconnected.authOk)
    assertFalse(disconnected.subscriptionOk)
    assertFalse(disconnected.ready)

    state.websocketStatus.set(AlpacaMarketDataWebsocketStatus(authOk = true))
    assertFalse(state.readiness().ready)
    state.websocketStatus.set(AlpacaMarketDataWebsocketStatus(subscriptionOk = true))
    assertFalse(state.readiness().ready)

    state.websocketStatus.set(AlpacaMarketDataWebsocketStatus(authOk = true, subscriptionOk = true))
    assertTrue(state.readiness().ready)
    state.websocketReady.set(false)
    assertFalse(state.readiness().ready)
    state.websocketReady.set(true)
    state.kafkaReady.set(false)
    assertFalse(state.readiness().ready)
  }
}
