package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.Envelope
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class MarketDataFeedTest {
  @Test
  fun `preserves legacy IEX and delayed SIP envelope bytes even when defaults are encoded`() {
    val json = Json { encodeDefaults = true }
    val timestamp = "2026-11-12T14:30:00Z"
    for ((feed, delay) in listOf("iex" to "real_time_exchange_only", "delayed_sip" to "delayed_15m_consolidated")) {
      val envelope =
        Envelope(
          ingestTs = Instant.parse(timestamp),
          eventTs = Instant.parse(timestamp),
          feed = feed,
          channel = "bars",
          symbol = "SPY",
          seq = 1,
          payload = JsonObject(emptyMap()),
          provider = "alpaca",
          marketSession = "regular",
          delayClass = delay,
          version = 2,
        )
      assertEquals(
        """{"ingestTs":"$timestamp","eventTs":"$timestamp","feed":"$feed","channel":"bars","symbol":"SPY","seq":1,""" +
          """"payload":{},"accountLabel":null,"isFinal":true,"source":"ws","window":null,"version":2,""" +
          """"provider":"alpaca","marketSession":"regular","delayClass":"$delay"}""",
        json.encodeToString(envelope),
      )
    }
  }

  @Test
  fun `classifies market-session boundaries in New York across standard and daylight time`() {
    val standard =
      listOf(
        "2026-01-15T08:59:59Z" to MarketSession.Overnight,
        "2026-01-15T09:00:00Z" to MarketSession.Premarket,
        "2026-01-15T14:30:00Z" to MarketSession.Regular,
        "2026-01-15T21:00:00Z" to MarketSession.AfterHours,
        "2026-01-16T01:00:00Z" to MarketSession.Overnight,
      )
    val daylight =
      listOf(
        "2026-07-15T07:59:59Z" to MarketSession.Overnight,
        "2026-07-15T08:00:00Z" to MarketSession.Premarket,
        "2026-07-15T13:30:00Z" to MarketSession.Regular,
        "2026-07-15T20:00:00Z" to MarketSession.AfterHours,
        "2026-07-16T00:00:00Z" to MarketSession.Overnight,
      )

    (standard + daylight).forEach { (timestamp, expected) ->
      assertEquals(expected, classifyMarketSession(Instant.parse(timestamp)), timestamp)
    }
  }

  @Test
  fun `assigns channel-aware delay semantics without relabeling feeds`() {
    assertEquals(MarketDataDelayClass.RealTimeExchangeOnly, marketDataDelayClass(EquityFeed.Iex, "quotes"))
    assertEquals(MarketDataDelayClass.RealTimeConsolidated, marketDataDelayClass(EquityFeed.Sip, "trades"))
    assertEquals(
      MarketDataDelayClass.Delayed15MinuteConsolidated,
      marketDataDelayClass(EquityFeed.DelayedSip, "bars"),
    )
    assertEquals(MarketDataDelayClass.IndicativeRealTime, marketDataDelayClass(EquityFeed.Overnight, "quotes"))
    assertEquals(MarketDataDelayClass.Delayed15MinuteAdjusted, marketDataDelayClass(EquityFeed.Overnight, "trades"))
    assertEquals(MarketDataDelayClass.Derived, marketDataDelayClass(EquityFeed.Overnight, "updatedBars"))
    assertFailsWith<IllegalStateException> { marketDataDelayClass(EquityFeed.Overnight, "statuses") }
  }

  @Test
  fun `parses supported equity feeds and rejects unknown feeds`() {
    assertEquals(EquityFeed.Sip, EquityFeed.parse("SIP"))
    assertEquals(EquityFeed.DelayedSip, EquityFeed.parse("DELAYED_SIP"))
    assertFailsWith<IllegalStateException> { EquityFeed.parse("unknown") }
  }

  @Test
  fun `routes each feed only to its configured topics`() {
    fun runtime(feed: EquityFeed): FeedRuntimeConfig =
      FeedRuntimeConfig(
        marketType = AlpacaMarketType.EQUITY,
        feed = feed.id,
        equityFeed = feed,
        channels = listOf("trades", "quotes", "bars", "updatedBars"),
        topics =
          TopicConfig(
            trades = "${feed.id}.trades",
            quotes = "${feed.id}.quotes",
            bars1m = "${feed.id}.bars",
            status = "observation.status",
            tradeUpdates = null,
            tradeUpdatesV2 = null,
          ),
        symbols = listOf("SPY"),
        symbolAllowlist = emptySet(),
        core = feed == EquityFeed.Iex,
      )

    val topics = EquityFeed.entries.map { feed -> runtime(feed).topicFor("bars") }
    assertEquals(listOf("iex.bars", "sip.bars", "delayed_sip.bars", "overnight.bars"), topics)
    assertEquals("observation.status", runtime(EquityFeed.Overnight).topicFor("status"))
    assertEquals(null, runtime(EquityFeed.Overnight).copy(marketType = AlpacaMarketType.OPTIONS).topicFor("status"))
  }
}
