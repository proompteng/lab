package ai.proompteng.dorvud.ws

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MarketDataChannelFreshnessTrackerTest {
  @Test
  fun `required equity channels are not ready when only bars are producing`() {
    var nowMs = Instant.parse("2026-07-07T14:00:00Z").toEpochMilli()
    val tracker =
      MarketDataChannelFreshnessTracker(
        requiredChannels = listOf("trades", "quotes", "bars", "updatedBars"),
        maxLagMs = 60_000,
        warmupMs = 0,
        nowMs = { nowMs },
        marketType = AlpacaMarketType.EQUITY,
      )

    tracker.recordSubscription(listOf("NVDA", "AMD"))
    tracker.recordProviderEvent("bars", "NVDA")
    tracker.recordSerializedEvent("bars", "NVDA")
    tracker.recordKafkaSuccess("bars", "NVDA")

    val byChannel = tracker.snapshot().associateBy { it.channel }

    assertFalse(tracker.ready())
    assertTrue(byChannel.getValue("bars").ready)
    assertEquals(2, byChannel.getValue("bars").subscribedSymbolCount)
    assertEquals(1, byChannel.getValue("bars").observedSymbolCount)
    assertEquals(listOf("NVDA"), byChannel.getValue("bars").observedSymbols)
    assertFalse(byChannel.getValue("trades").ready)
    assertEquals(
      "market_data_channel_missing_kafka_success",
      byChannel.getValue("trades").reason,
    )

    listOf("trades", "quotes", "updatedBars").forEach { channel ->
      tracker.recordProviderEvent(channel, "NVDA")
      tracker.recordSerializedEvent(channel, "NVDA")
      tracker.recordKafkaSuccess(channel, "NVDA")
    }

    assertTrue(tracker.ready())

    nowMs += 61_000

    assertFalse(tracker.ready())
    assertEquals(
      "market_data_channel_stale",
      tracker.snapshot().first { it.channel == "trades" }.reason,
    )
  }

  @Test
  fun `subscription coverage is tracked per market data channel`() {
    val nowMs = Instant.parse("2026-07-07T14:00:00Z").toEpochMilli()
    val tracker =
      MarketDataChannelFreshnessTracker(
        requiredChannels = listOf("trades", "quotes", "bars", "updatedBars"),
        maxLagMs = 60_000,
        warmupMs = 0,
        nowMs = { nowMs },
        marketType = AlpacaMarketType.EQUITY,
      )

    tracker.recordSubscriptionByChannel(
      mapOf(
        "trades" to emptyList(),
        "quotes" to emptyList(),
        "bars" to listOf("NVDA", "AMD"),
        "updatedBars" to emptyList(),
      ),
    )
    tracker.recordProviderEvent("bars", "NVDA")
    tracker.recordSerializedEvent("bars", "NVDA")
    tracker.recordKafkaSuccess("bars", "NVDA")

    val byChannel = tracker.snapshot().associateBy { it.channel }

    assertFalse(tracker.ready())
    assertTrue(byChannel.getValue("bars").ready)
    assertEquals(2, byChannel.getValue("bars").subscribedSymbolCount)
    assertFalse(byChannel.getValue("trades").ready)
    assertEquals(0, byChannel.getValue("trades").subscribedSymbolCount)
    assertEquals(
      "market_data_channel_not_subscribed",
      byChannel.getValue("trades").reason,
    )
  }
}
