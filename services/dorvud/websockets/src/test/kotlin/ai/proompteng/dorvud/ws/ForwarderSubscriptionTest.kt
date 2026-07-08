package ai.proompteng.dorvud.ws

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ForwarderSubscriptionTest {
  @Test
  fun `subscribed symbols are derived from Alpaca acknowledgement channels`() {
    val ack =
      AlpacaSubscription(
        trades = listOf("nvda", "AAPL"),
        quotes = listOf("NVDA", "AMZN"),
        bars1m = listOf("AVGO"),
        updatedBars = listOf("AMD", " "),
      )

    assertEquals(
      setOf("NVDA", "AAPL", "AMZN", "AVGO", "AMD"),
      ack.subscribedSymbolsForChannels(listOf("trades", "quotes", "bars", "updatedBars")),
    )
    assertEquals(
      setOf("NVDA", "AMZN"),
      ack.subscribedSymbolsForChannels(listOf("quotes")),
    )
    assertEquals(
      mapOf(
        "trades" to setOf("NVDA", "AAPL"),
        "quotes" to setOf("NVDA", "AMZN"),
        "bars" to setOf("AVGO"),
        "updatedBars" to setOf("AMD"),
      ),
      ack.subscribedSymbolsByChannel(listOf("trades", "quotes", "bars", "updatedBars")),
    )
  }

  @Test
  fun `missing desired symbols stay retryable after partial Alpaca acknowledgement`() {
    val desired = listOf("NVDA", "AAPL", "AMZN", "GOOGL", "AVGO", "AMD", "ORCL", "INTC")
    val actual =
      AlpacaSubscription(
        trades = listOf("NVDA", "AMD", "AVGO", "INTC"),
        quotes = listOf("NVDA", "AMD", "AVGO", "INTC"),
        bars1m = listOf("NVDA", "AMD", "AVGO", "INTC"),
        updatedBars = listOf("NVDA", "AMD", "AVGO", "INTC"),
      ).subscribedSymbolsForChannels(listOf("trades", "quotes", "bars", "updatedBars"))

    assertEquals(listOf("AAPL", "AMZN", "GOOGL", "ORCL"), missingDesiredSymbols(desired, actual))
  }

  @Test
  fun `missing desired symbols are evaluated for every requested channel`() {
    val desired = listOf("NVDA", "AMD")
    val actual =
      AlpacaSubscription(
        bars1m = listOf("NVDA", "AMD"),
      ).subscribedSymbolsByChannel(listOf("trades", "quotes", "bars", "updatedBars"))

    assertEquals(
      mapOf(
        "trades" to listOf("NVDA", "AMD"),
        "quotes" to listOf("NVDA", "AMD"),
        "updatedBars" to listOf("NVDA", "AMD"),
      ),
      missingDesiredSymbolsByChannel(desired, actual, listOf("trades", "quotes", "bars", "updatedBars")),
    )
  }

  @Test
  fun `market data websocket status exposes per-channel subscription acknowledgement gaps`() {
    val nowMs = Instant.parse("2026-07-07T14:00:00Z").toEpochMilli()
    val status =
      AlpacaSubscription(
        trades = listOf("NVDA"),
        quotes = listOf("NVDA", "AMD"),
        bars1m = listOf("NVDA"),
      ).toMarketDataWebsocketStatus(
        previous = AlpacaMarketDataWebsocketStatus(errorClass = "previous_error"),
        channels = listOf("trades", "quotes", "bars", "updatedBars"),
        desiredSymbols = listOf("NVDA", "AMD"),
        authOk = true,
        nowMs = nowMs,
      )

    assertTrue(status.authOk)
    assertFalse(status.subscriptionOk)
    assertEquals(nowMs, status.latestSubscriptionAckAtMs)
    assertEquals(2, status.subscribedSymbolCount)
    assertEquals(listOf("AMD", "NVDA"), status.subscribedSymbols)
    assertEquals(
      mapOf(
        "trades" to listOf("AMD"),
        "bars" to listOf("AMD"),
        "updatedBars" to listOf("NVDA", "AMD"),
      ),
      status.missingSubscriptionSymbolsByChannel,
    )
  }

  @Test
  fun `market data websocket status clears prior error after full acknowledgement`() {
    val nowMs = Instant.parse("2026-07-07T14:00:00Z").toEpochMilli()
    val status =
      AlpacaSubscription(
        trades = listOf("NVDA", "AMD"),
        quotes = listOf("NVDA", "AMD"),
        bars1m = listOf("NVDA", "AMD"),
        updatedBars = listOf("NVDA", "AMD"),
      ).toMarketDataWebsocketStatus(
        previous = AlpacaMarketDataWebsocketStatus(errorClass = "alpaca_auth"),
        channels = listOf("trades", "quotes", "bars", "updatedBars"),
        desiredSymbols = listOf("NVDA", "AMD"),
        authOk = true,
        nowMs = nowMs,
      )

    assertTrue(status.subscriptionOk)
    assertEquals(null, status.errorClass)
    assertEquals(
      mapOf(
        "trades" to listOf("AMD", "NVDA"),
        "quotes" to listOf("AMD", "NVDA"),
        "bars" to listOf("AMD", "NVDA"),
        "updatedBars" to listOf("AMD", "NVDA"),
      ),
      status.subscribedSymbolsByChannel,
    )
  }

  @Test
  fun `subscription updates unsubscribe before subscribing to avoid transient provider cap breaches`() {
    val updates =
      subscriptionUpdates(
        desired = listOf("AAPL", "MSFT", "GOOGL"),
        subscribed = listOf("NVDA", "AMD", "AAPL"),
      )

    assertEquals(
      listOf(
        SubscriptionUpdate(SubscriptionAction.Unsubscribe, listOf("NVDA", "AMD")),
        SubscriptionUpdate(SubscriptionAction.Subscribe, listOf("MSFT", "GOOGL")),
      ),
      updates,
    )
  }

  @Test
  fun `subscription updates normalize symbols and preserve desired add order`() {
    val updates =
      subscriptionUpdates(
        desired = listOf(" aapl ", "msft", "MSFT", "googl"),
        subscribed = listOf("AAPL", " nvda "),
      )

    assertEquals(
      listOf(
        SubscriptionUpdate(SubscriptionAction.Unsubscribe, listOf("NVDA")),
        SubscriptionUpdate(SubscriptionAction.Subscribe, listOf("MSFT", "GOOGL")),
      ),
      updates,
    )
  }

  @Test
  fun `observed market data messages expose raw provider quote and trade frames`() {
    assertEquals(
      ObservedMarketDataMessage("trade", "NVDA260717C00160000"),
      observedMarketDataMessage(
        AlpacaTrade(
          symbol = "NVDA260717C00160000",
          price = 1.15,
          size = 1.0,
          timestamp = "2026-07-08T14:52:03Z",
        ),
      ),
    )
    assertEquals(
      ObservedMarketDataMessage("quote", "NVDA260717C00160000"),
      observedMarketDataMessage(
        AlpacaQuote(
          symbol = "NVDA260717C00160000",
          bidPrice = 1.1,
          bidSize = 12.0,
          askPrice = 1.2,
          askSize = 10.0,
          timestamp = "2026-07-08T14:52:03Z",
        ),
      ),
    )
    assertEquals(null, observedMarketDataMessage(AlpacaSuccess(msg = "authenticated")))
  }

  @Test
  fun `market data drop reason identifies invalid event timestamps`() {
    assertEquals(
      "invalid_event_ts",
      marketDataEnvelopeDropReason(
        AlpacaQuote(
          symbol = "NVDA260717C00160000",
          bidPrice = 1.1,
          bidSize = 12.0,
          askPrice = 1.2,
          askSize = 10.0,
          timestamp = "[ERROR: provider timestamp unavailable]",
        ),
      ),
    )
    assertEquals(
      "envelope_mapping_failed",
      marketDataEnvelopeDropReason(
        AlpacaQuote(
          symbol = "NVDA260717C00160000",
          bidPrice = 1.1,
          bidSize = 12.0,
          askPrice = 1.2,
          askSize = 10.0,
          timestamp = "2026-07-08T14:52:03.192533568Z",
        ),
      ),
    )
  }

  @Test
  fun `options event starvation requires options subscriptions during regular market hours`() {
    val now = Instant.parse("2026-06-18T15:00:00Z")
    val stale = now.minusSeconds(120)

    assertTrue(
      optionsEventStarved(
        now = now,
        lastEventAt = null,
        subscribedSince = stale,
        subscribedCount = 12,
        marketType = AlpacaMarketType.OPTIONS,
        grace = Duration.ofSeconds(90),
      ),
    )
    assertFalse(
      optionsEventStarved(
        now = now,
        lastEventAt = now.minusSeconds(10),
        subscribedSince = stale,
        subscribedCount = 12,
        marketType = AlpacaMarketType.OPTIONS,
        grace = Duration.ofSeconds(90),
      ),
    )
    assertFalse(
      optionsEventStarved(
        now = now,
        lastEventAt = null,
        subscribedSince = stale,
        subscribedCount = 12,
        marketType = AlpacaMarketType.EQUITY,
        grace = Duration.ofSeconds(90),
      ),
    )
    assertFalse(
      optionsEventStarved(
        now = Instant.parse("2026-06-18T22:00:00Z"),
        lastEventAt = null,
        subscribedSince = stale,
        subscribedCount = 12,
        marketType = AlpacaMarketType.OPTIONS,
        grace = Duration.ofSeconds(90),
      ),
    )
    assertFalse(
      optionsEventStarved(
        now = now,
        lastEventAt = null,
        subscribedSince = stale,
        subscribedCount = 0,
        marketType = AlpacaMarketType.OPTIONS,
        grace = Duration.ofSeconds(90),
      ),
    )
    assertFalse(
      optionsEventStarved(
        now = now,
        lastEventAt = null,
        subscribedSince = stale,
        subscribedCount = 12,
        marketType = AlpacaMarketType.OPTIONS,
        marketHolidays = setOf(LocalDate.parse("2026-06-18")),
        grace = Duration.ofSeconds(90),
      ),
    )
  }
}
