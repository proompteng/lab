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
    assertFalse(byChannel.getValue("bars").ready)
    assertEquals(2, byChannel.getValue("bars").subscribedSymbolCount)
    assertEquals(1, byChannel.getValue("bars").observedSymbolCount)
    assertEquals(listOf("NVDA"), byChannel.getValue("bars").observedSymbols)
    assertEquals(listOf("AMD"), byChannel.getValue("bars").missingSymbols)
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

    assertFalse(tracker.ready())
    assertEquals(
      "market_data_channel_missing_symbol_coverage",
      tracker.snapshot().first { it.channel == "trades" }.reason,
    )

    listOf("trades", "quotes", "bars", "updatedBars").forEach { channel ->
      tracker.recordProviderEvent(channel, "AMD")
      tracker.recordSerializedEvent(channel, "AMD")
      tracker.recordKafkaSuccess(channel, "AMD")
    }

    assertTrue(tracker.ready())

    nowMs += 61_000

    assertFalse(tracker.ready())
    assertEquals(
      "market_data_channel_stale_symbol_coverage",
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
    assertFalse(byChannel.getValue("bars").ready)
    assertEquals(2, byChannel.getValue("bars").subscribedSymbolCount)
    assertEquals(listOf("AMD"), byChannel.getValue("bars").missingSymbols)
    assertFalse(byChannel.getValue("trades").ready)
    assertEquals(0, byChannel.getValue("trades").subscribedSymbolCount)
    assertEquals(
      "market_data_channel_not_subscribed",
      byChannel.getValue("trades").reason,
    )
  }

  @Test
  fun `regular-session readiness requires fresh coverage for every subscribed symbol`() {
    var nowMs = Instant.parse("2026-07-07T14:00:00Z").toEpochMilli()
    val tracker =
      MarketDataChannelFreshnessTracker(
        requiredChannels = listOf("trades"),
        maxLagMs = 60_000,
        warmupMs = 0,
        nowMs = { nowMs },
        marketType = AlpacaMarketType.EQUITY,
      )

    tracker.recordSubscriptionByChannel(mapOf("trades" to listOf("NVDA", "AMD")))
    tracker.recordProviderEvent("trades", "NVDA")
    tracker.recordSerializedEvent("trades", "NVDA")
    tracker.recordKafkaSuccess("trades", "NVDA")

    val missingCoverage = tracker.snapshot().single()
    assertFalse(tracker.ready())
    assertEquals("market_data_channel_missing_symbol_coverage", missingCoverage.reason)
    assertEquals(listOf("AMD"), missingCoverage.missingSymbols)
    assertEquals(listOf("NVDA"), missingCoverage.freshSymbols)

    nowMs += 10_000
    tracker.recordProviderEvent("trades", "AMD")
    tracker.recordSerializedEvent("trades", "AMD")
    tracker.recordKafkaSuccess("trades", "AMD")

    assertTrue(tracker.ready())

    nowMs += 55_000
    val staleCoverage = tracker.snapshot().single()
    assertFalse(tracker.ready())
    assertEquals("market_data_channel_stale_symbol_coverage", staleCoverage.reason)
    assertEquals(listOf("NVDA"), staleCoverage.staleSymbols)
    assertEquals(listOf("AMD"), staleCoverage.freshSymbols)
  }
}
