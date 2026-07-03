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
