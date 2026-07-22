package ai.proompteng.dorvud.ws

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MarketDataChannelFreshnessTrackerTest {
  @Test
  fun `read idle reconnects only while the feed session is active`() {
    val regularSession = Instant.parse("2026-07-07T14:00:00Z")
    val overnightSession = Instant.parse("2026-07-08T01:00:00Z")

    assertTrue(
      marketDataIdleRequiresReconnect(true, regularSession, AlpacaMarketType.EQUITY, emptySet(), EquityFeed.Iex),
    )
    assertFalse(
      marketDataIdleRequiresReconnect(true, overnightSession, AlpacaMarketType.EQUITY, emptySet(), EquityFeed.Iex),
    )
    assertTrue(
      marketDataIdleRequiresReconnect(true, regularSession, AlpacaMarketType.EQUITY, emptySet(), EquityFeed.DelayedSip),
    )
    assertFalse(
      marketDataIdleRequiresReconnect(true, overnightSession, AlpacaMarketType.EQUITY, emptySet(), EquityFeed.DelayedSip),
    )
    assertFalse(
      marketDataIdleRequiresReconnect(true, regularSession, AlpacaMarketType.EQUITY, emptySet(), EquityFeed.Overnight),
    )
    assertTrue(
      marketDataIdleRequiresReconnect(true, overnightSession, AlpacaMarketType.EQUITY, emptySet(), EquityFeed.Overnight),
    )
    assertTrue(
      marketDataIdleRequiresReconnect(false, overnightSession, AlpacaMarketType.EQUITY, emptySet(), EquityFeed.Iex),
    )
  }

  @Test
  fun `observation freshness gates follow the feed active session`() {
    val delayedSipPre =
      MarketDataChannelFreshnessTracker(
        requiredChannels = listOf("quotes"),
        maxLagMs = 60_000,
        warmupMs = 0,
        nowMs = { Instant.parse("2026-07-07T12:00:00Z").toEpochMilli() },
        marketType = AlpacaMarketType.EQUITY,
        equityFeed = EquityFeed.DelayedSip,
      )
    delayedSipPre.recordSubscription(listOf("NVDA"))
    assertTrue(delayedSipPre.snapshot().single().gateActive)

    val overnightRegular =
      MarketDataChannelFreshnessTracker(
        requiredChannels = listOf("quotes"),
        maxLagMs = 60_000,
        warmupMs = 0,
        nowMs = { Instant.parse("2026-07-07T14:00:00Z").toEpochMilli() },
        marketType = AlpacaMarketType.EQUITY,
        equityFeed = EquityFeed.Overnight,
      )
    overnightRegular.recordSubscription(listOf("NVDA"))
    assertFalse(overnightRegular.snapshot().single().gateActive)

    val overnightActive =
      MarketDataChannelFreshnessTracker(
        requiredChannels = listOf("quotes"),
        maxLagMs = 60_000,
        warmupMs = 0,
        nowMs = { Instant.parse("2026-07-08T01:00:00Z").toEpochMilli() },
        marketType = AlpacaMarketType.EQUITY,
        equityFeed = EquityFeed.Overnight,
      )
    overnightActive.recordSubscription(listOf("NVDA"))
    assertTrue(overnightActive.snapshot().single().gateActive)
    assertEquals("overnight", overnightActive.snapshot().single().marketSessionState)
  }

  @Test
  fun `overnight session follows the Sunday evening through Friday evening market week`() {
    val cases =
      mapOf(
        "2026-07-19T23:59:59Z" to "weekend",
        "2026-07-20T00:00:00Z" to "overnight",
        "2026-07-25T00:00:00Z" to "closed",
        "2026-07-25T03:59:59Z" to "closed",
        "2026-07-25T04:00:00Z" to "weekend",
      )

    cases.forEach { (timestamp, expected) ->
      assertEquals(expected, marketSessionState(Instant.parse(timestamp), AlpacaMarketType.EQUITY), timestamp)
    }
  }

  @Test
  fun `conditional updated bars do not block readiness when no late-trade corrections arrive`() {
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
        "trades" to listOf("NVDA", "AMD"),
        "quotes" to listOf("NVDA", "AMD"),
        "bars" to listOf("NVDA", "AMD"),
        "updatedBars" to listOf("NVDA", "AMD"),
      ),
    )
    listOf("trades", "quotes", "bars").forEach { channel ->
      listOf("NVDA", "AMD").forEach { symbol ->
        tracker.recordProviderEvent(channel, symbol)
        tracker.recordSerializedEvent(channel, symbol)
        tracker.recordKafkaSuccess(channel, symbol)
      }
    }

    val byChannel = tracker.snapshot().associateBy { it.channel }
    val updatedBars = byChannel.getValue("updatedBars")

    assertTrue(tracker.ready())
    assertTrue(updatedBars.ready)
    assertFalse(updatedBars.freshnessRequired)
    assertFalse(updatedBars.symbolCoverageRequired)
    assertEquals("conditional", updatedBars.readinessMode)
    assertEquals("market_data_channel_conditional_no_events", updatedBars.reason)
    assertEquals(emptyList(), updatedBars.missingSymbols)
  }

  @Test
  fun `conditional updated bars fail only when observed corrections do not reach kafka`() {
    var nowMs = Instant.parse("2026-07-07T14:00:00Z").toEpochMilli()
    val tracker =
      MarketDataChannelFreshnessTracker(
        requiredChannels = listOf("updatedBars"),
        maxLagMs = 60_000,
        warmupMs = 0,
        nowMs = { nowMs },
        marketType = AlpacaMarketType.EQUITY,
      )

    tracker.recordSubscriptionByChannel(mapOf("updatedBars" to listOf("NVDA", "AMD")))
    tracker.recordProviderEvent("updatedBars", "NVDA")
    tracker.recordSerializedEvent("updatedBars", "NVDA")

    assertTrue(tracker.ready())
    assertEquals(
      "market_data_channel_conditional_pending_kafka_success",
      tracker.snapshot().single().reason,
    )

    nowMs += 61_000

    val missingKafka = tracker.snapshot().single()
    assertFalse(tracker.ready())
    assertEquals("market_data_channel_conditional_missing_kafka_success", missingKafka.reason)
    assertEquals(emptyList(), missingKafka.missingSymbols)

    tracker.recordKafkaSuccess("updatedBars", "NVDA")

    assertTrue(tracker.ready())

    nowMs += 61_000

    val staleButValid = tracker.snapshot().single()
    assertTrue(tracker.ready())
    assertEquals("market_data_channel_conditional_observed", staleButValid.reason)
    assertEquals(listOf("NVDA"), staleButValid.observedSymbols)
    assertEquals(emptyList(), staleButValid.staleSymbols)
  }

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
    assertFalse(byChannel.getValue("bars").symbolCoverageRequired)
    assertEquals(2, byChannel.getValue("bars").subscribedSymbolCount)
    assertEquals(listOf("AMD", "NVDA"), byChannel.getValue("bars").subscribedSymbols)
    assertEquals(nowMs, byChannel.getValue("bars").latestSubscriptionAckAtMs)
    assertEquals(0, byChannel.getValue("bars").subscriptionAckLagMs)
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
    assertTrue(byChannel.getValue("bars").ready)
    assertFalse(byChannel.getValue("bars").symbolCoverageRequired)
    assertEquals(2, byChannel.getValue("bars").subscribedSymbolCount)
    assertEquals(listOf("AMD", "NVDA"), byChannel.getValue("bars").subscribedSymbols)
    assertEquals(nowMs, byChannel.getValue("bars").latestSubscriptionAckAtMs)
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
    assertTrue(missingCoverage.gateActive)
    assertEquals("regular", missingCoverage.marketSessionState)
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

  @Test
  fun `quiet equity bar symbols remain diagnostic without restarting a fresh channel`() {
    var nowMs = Instant.parse("2026-07-07T14:00:00Z").toEpochMilli()
    val tracker =
      MarketDataChannelFreshnessTracker(
        requiredChannels = listOf("bars"),
        maxLagMs = 60_000,
        warmupMs = 0,
        nowMs = { nowMs },
        marketType = AlpacaMarketType.EQUITY,
      )

    tracker.recordSubscriptionByChannel(mapOf("bars" to listOf("NVDA", "CRDO")))
    listOf("NVDA", "CRDO").forEach { symbol ->
      tracker.recordProviderEvent("bars", symbol)
      tracker.recordSerializedEvent("bars", symbol)
      tracker.recordKafkaSuccess("bars", symbol)
    }

    nowMs += 61_000
    tracker.recordProviderEvent("bars", "NVDA")
    tracker.recordSerializedEvent("bars", "NVDA")
    tracker.recordKafkaSuccess("bars", "NVDA")

    val readiness = tracker.snapshot().single()

    assertTrue(tracker.ready())
    assertTrue(readiness.ready)
    assertFalse(readiness.symbolCoverageRequired)
    assertEquals("market_data_channel_fresh", readiness.reason)
    assertEquals(listOf("CRDO"), readiness.staleSymbols)
    assertEquals(listOf("NVDA"), readiness.freshSymbols)
  }

  @Test
  fun `observed equity bars still require per-symbol kafka delivery`() {
    var nowMs = Instant.parse("2026-07-07T14:00:00Z").toEpochMilli()
    val tracker =
      MarketDataChannelFreshnessTracker(
        requiredChannels = listOf("bars"),
        maxLagMs = 60_000,
        warmupMs = 0,
        nowMs = { nowMs },
        marketType = AlpacaMarketType.EQUITY,
      )

    tracker.recordSubscriptionByChannel(mapOf("bars" to listOf("NVDA", "CRDO")))
    tracker.recordProviderEvent("bars", "CRDO")
    val firstCrdoSequence = requireNotNull(tracker.recordSerializedEvent("bars", "CRDO"))

    nowMs += 30_000
    tracker.recordProviderEvent("bars", "CRDO")
    tracker.recordSerializedEvent("bars", "CRDO")
    tracker.recordKafkaSuccess("bars", "CRDO", firstCrdoSequence)

    nowMs += 31_000
    tracker.recordProviderEvent("bars", "NVDA")
    tracker.recordSerializedEvent("bars", "NVDA")
    tracker.recordKafkaSuccess("bars", "NVDA")

    val readiness = tracker.snapshot().single()

    assertFalse(tracker.ready())
    assertFalse(readiness.ready)
    assertFalse(readiness.symbolCoverageRequired)
    assertEquals("market_data_channel_observed_symbol_missing_kafka_success", readiness.reason)
    assertEquals(emptyList(), readiness.missingSymbols)
    assertEquals(listOf("CRDO", "NVDA"), readiness.freshSymbols)
  }

  @Test
  fun `post-session readiness exposes inactive gate and stale channel diagnostics`() {
    val nowMs = Instant.parse("2026-07-07T22:00:00Z").toEpochMilli()
    val tracker =
      MarketDataChannelFreshnessTracker(
        requiredChannels = listOf("trades"),
        maxLagMs = 60_000,
        warmupMs = 0,
        nowMs = { nowMs },
        marketType = AlpacaMarketType.EQUITY,
      )

    tracker.recordSubscriptionByChannel(mapOf("trades" to listOf("NVDA", "AMD")))

    val readiness = tracker.snapshot().single()

    assertTrue(tracker.ready())
    assertTrue(readiness.ready)
    assertFalse(readiness.gateActive)
    assertEquals("post", readiness.marketSessionState)
    assertEquals("market_data_channel_gate_inactive", readiness.reason)
    assertEquals(listOf("AMD", "NVDA"), readiness.subscribedSymbols)
  }

  @Test
  fun `options readiness does not require full symbol coverage for quote liveness`() {
    val nowMs = Instant.parse("2026-07-07T14:00:00Z").toEpochMilli()
    val tracker =
      MarketDataChannelFreshnessTracker(
        requiredChannels = listOf("quotes"),
        maxLagMs = 60_000,
        warmupMs = 0,
        nowMs = { nowMs },
        marketType = AlpacaMarketType.OPTIONS,
      )

    tracker.recordSubscriptionByChannel(mapOf("quotes" to listOf("NVDA260717C00160000", "NVDA260717P00160000")))
    tracker.recordProviderEvent("quotes", "NVDA260717C00160000")
    tracker.recordSerializedEvent("quotes", "NVDA260717C00160000")
    tracker.recordKafkaSuccess("quotes", "NVDA260717C00160000")

    val readiness = tracker.snapshot().single()

    assertTrue(tracker.ready())
    assertTrue(readiness.ready)
    assertTrue(readiness.freshnessRequired)
    assertFalse(readiness.symbolCoverageRequired)
    assertEquals("continuous", readiness.readinessMode)
    assertEquals("market_data_channel_fresh", readiness.reason)
    assertEquals(2, readiness.subscribedSymbolCount)
    assertEquals(1, readiness.observedSymbolCount)
    assertEquals(listOf("NVDA260717C00160000"), readiness.freshSymbols)
    assertEquals(listOf("NVDA260717P00160000"), readiness.missingSymbols)
    assertEquals(emptyList(), readiness.staleSymbols)
  }

  @Test
  fun `options trades are conditional but fail when observed provider events do not reach kafka`() {
    var nowMs = Instant.parse("2026-07-07T14:00:00Z").toEpochMilli()
    val tracker =
      MarketDataChannelFreshnessTracker(
        requiredChannels = listOf("trades"),
        maxLagMs = 60_000,
        warmupMs = 0,
        nowMs = { nowMs },
        marketType = AlpacaMarketType.OPTIONS,
      )

    tracker.recordSubscriptionByChannel(mapOf("trades" to listOf("NVDA260717C00160000", "NVDA260717P00160000")))

    val quietTrades = tracker.snapshot().single()
    assertTrue(tracker.ready())
    assertEquals("conditional", quietTrades.readinessMode)
    assertFalse(quietTrades.freshnessRequired)
    assertFalse(quietTrades.symbolCoverageRequired)
    assertEquals("market_data_channel_conditional_no_events", quietTrades.reason)

    tracker.recordProviderEvent("trades", "NVDA260717C00160000")
    tracker.recordSerializedEvent("trades", "NVDA260717C00160000")

    nowMs += 61_000

    val missingKafka = tracker.snapshot().single()
    assertFalse(tracker.ready())
    assertEquals("market_data_channel_conditional_missing_kafka_success", missingKafka.reason)

    tracker.recordKafkaSuccess("trades", "NVDA260717C00160000")

    val deliveredTrade = tracker.snapshot().single()
    assertTrue(tracker.ready())
    assertEquals("market_data_channel_conditional_observed", deliveredTrade.reason)
    assertEquals(listOf("NVDA260717C00160000"), deliveredTrade.observedSymbols)
    assertEquals(listOf("NVDA260717P00160000"), deliveredTrade.missingSymbols)
  }
}
