package ai.proompteng.dorvud.ws

import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

private const val SIP_UNIVERSE_ID = "torghut-core-equity-sip-v1"
internal const val SIP_73_SYMBOL_HASH = "89de937a84155ab0cffdfbc5687edf0ace82f68dcd07ffcdc724c58efb28960b"

// The disjoint stock and ETF cohorts from the Wave 4H audit (#16372).
internal val sip73Symbols =
  (
    "AAPL,ALAB,AMAT,AMD,AMZN,ANET,APP,ARM,ASML,AVGO,CEG,COHR,COIN,CRDO,CRWD,GEV,GOOGL,HOOD,INTC,KLAC,LITE,LRCX," +
      "META,MRVL,MSFT,MSTR,MU,NET,NFLX,NOW,NVDA,ORCL,PANW,PLTR,SHOP,SMCI,SNDK,SNOW,SOFI,SPOT,TSLA,TSM,UBER,VRT,VST,WDC," +
      "DBC,EEM,EFA,GLD,HYG,IEF,IWM,LQD,QQQ,SHY,SLV,SMH,SPY,TLT,USO,VNQ,XLB,XLC,XLE,XLF,XLI,XLK,XLP,XLRE,XLU,XLV,XLY"
  ).split(",").sorted()

internal fun sipTestEnv(
  symbols: List<String> = sip73Symbols,
  hash: String = canonicalSymbolHash(symbols),
): Map<String, String> =
  mapOf(
    "ALPACA_KEY_ID" to "key",
    "ALPACA_SECRET_KEY" to "secret",
    "ALPACA_FEED" to "sip",
    "ALPACA_MARKET_DATA_CHANNELS" to "bars,quotes,trades",
    "SYMBOLS" to symbols.joinToString(","),
    "SYMBOLS_ALLOWLIST" to symbols.joinToString(","),
    "MARKET_DATA_UNIVERSE_ID" to SIP_UNIVERSE_ID,
    "MARKET_DATA_UNIVERSE_SYMBOL_HASH" to hash,
    "TOPIC_BARS_1M" to "bayn.market-data.sip.bars.1m.v1",
    "TOPIC_QUOTES" to "bayn.market-data.sip.quotes.v1",
    "TOPIC_TRADES" to "bayn.market-data.sip.trades.v1",
    "TOPIC_STATUS" to "bayn.market-data.sip.status.v1",
  )

class ConsolidatedSipConfigTest {
  private val base = sipTestEnv(hash = SIP_73_SYMBOL_HASH)

  @Test
  fun `admits the canonical 73 symbol lane by entitlement or explicit ceiling`() {
    assertEquals(73, sip73Symbols.size)
    assertEquals(SIP_73_SYMBOL_HASH, canonicalSymbolHash(sip73Symbols))
    for (setting in listOf("ALPACA_MARKET_DATA_ENTITLEMENT" to "algo_trader_plus", "ALPACA_MAX_SYMBOL_CHANNELS" to "219")) {
      val config = ForwarderConfig.fromEnv(base + setting)
      val feed = config.marketDataFeedConfigs().single()
      assertEquals(EquityFeed.Sip, feed.equityFeed)
      assertEquals(MarketDataUniverseContract(SIP_UNIVERSE_ID, SIP_73_SYMBOL_HASH, sip73Symbols), feed.sipUniverse)
      val desired = feed.desiredSymbolsByChannel(feed.symbols)
      assertEquals(setOf("bars", "quotes", "trades"), desired.keys)
      assertEquals(219, desired.values.sumOf { it.size })
      for (channel in desired.keys) {
        assertEquals(sip73Symbols, desired.getValue(channel))
        assertEquals("real_time_consolidated", marketDataDelayClass(EquityFeed.Sip, channel).id)
      }
      assertNull(config.latestMarketData)
    }
  }

  @Test
  fun `caps symbol channels including overrides and updated bars`() {
    for (setting in listOf(emptyMap(), mapOf("ALPACA_MARKET_DATA_ENTITLEMENT" to "basic"))) {
      val failure = assertFailsWith<IllegalStateException> { ForwarderConfig.fromEnv(base + setting) }
      assertContains(failure.message.orEmpty(), "requires 219 symbol-channel subscriptions")
      assertContains(failure.message.orEmpty(), "maximum is 30")
    }
    val paid = base + ("ALPACA_MARKET_DATA_ENTITLEMENT" to "algo_trader_plus")
    for (limit in listOf("0", "401", "-1", "invalid")) {
      assertFailsWith<IllegalArgumentException> { ForwarderConfig.fromEnv(paid + ("ALPACA_MAX_SYMBOL_CHANNELS" to limit)) }
    }
    assertFailsWith<IllegalArgumentException> {
      ForwarderConfig.fromEnv(base + mapOf("ALPACA_MARKET_DATA_ENTITLEMENT" to "basic", "ALPACA_MAX_SYMBOL_CHANNELS" to "219"))
    }
    assertFailsWith<IllegalArgumentException> { ForwarderConfig.fromEnv(base + ("ALPACA_MARKET_DATA_ENTITLEMENT" to "plus")) }
    val tight = paid + ("ALPACA_MAX_SYMBOL_CHANNELS" to "218")
    assertContains(assertFailsWith<IllegalStateException> { ForwarderConfig.fromEnv(tight) }.message.orEmpty(), "maximum is 218")
    ForwarderConfig.fromEnv(tight + ("ALPACA_MARKET_DATA_TRADES_SYMBOLS" to sip73Symbols.dropLast(1).joinToString(",")))
    val withUpdates =
      paid +
        mapOf(
          "ALPACA_MARKET_DATA_CHANNELS" to "bars,quotes,trades,updatedBars",
          "ALPACA_MAX_SYMBOL_CHANNELS" to "219",
        )
    assertContains(
      assertFailsWith<IllegalStateException> { ForwarderConfig.fromEnv(withUpdates) }.message.orEmpty(),
      "requires 292 symbol-channel subscriptions",
    )
    ForwarderConfig.fromEnv(withUpdates + ("ALPACA_MAX_SYMBOL_CHANNELS" to "400"))
  }

  @Test
  fun `rejects unsafe symbols and requires the static universe to match`() {
    val paid = base + ("ALPACA_MARKET_DATA_ENTITLEMENT" to "algo_trader_plus")
    for (symbols in listOf("", "*", "AAPL,SP*", "AAPL,aapl", "AAPL,AAPL")) {
      val failure = assertFailsWith<IllegalArgumentException> { ForwarderConfig.fromEnv(paid + ("SYMBOLS" to symbols)) }
      assertContains(failure.message.orEmpty(), "unique, explicit symbols without wildcards")
    }
    // Even a wildcard whose configured hash matches cannot be admitted.
    assertFailsWith<IllegalArgumentException> { ForwarderConfig.fromEnv(sipTestEnv(listOf("*"))) }
    assertFailsWith<IllegalStateException> {
      ForwarderConfig.fromEnv(paid + ("ALPACA_MARKET_DATA_QUOTES_SYMBOLS" to "*"))
    }
    assertFailsWith<IllegalStateException> {
      ForwarderConfig.fromEnv(paid + ("MARKET_DATA_UNIVERSE_SYMBOL_HASH" to "0".repeat(64)))
    }
    assertFailsWith<IllegalStateException> { ForwarderConfig.fromEnv(paid + ("JANGAR_SYMBOLS_URL" to "https://example.test")) }
    assertFailsWith<IllegalStateException> { ForwarderConfig.fromEnv(paid + ("SYMBOLS_ALLOWLIST" to "AAPL")) }
    for (setting in listOf("ALPACA_OBSERVATION_SYMBOLS" to "AAPL", "SHARD_COUNT" to "2")) {
      assertFailsWith<IllegalArgumentException> { ForwarderConfig.fromEnv(paid + setting) }
    }
    assertFailsWith<IllegalArgumentException> {
      ForwarderConfig.fromEnv(paid - "MARKET_DATA_UNIVERSE_ID" - "MARKET_DATA_UNIVERSE_SYMBOL_HASH")
    }
  }

  @Test
  fun `does not allow latest sampling or another lane to share SIP routes`() {
    val paid = base + ("ALPACA_MAX_SYMBOL_CHANNELS" to "219")
    for ((key, value) in listOf(
      "TOPIC_TRADES" to "torghut.trades.v1",
      "TOPIC_QUOTES" to "torghut.quotes.v1",
      "TOPIC_BARS_1M" to "torghut.bars.1m.v1",
      "TOPIC_STATUS" to "torghut.status.v1",
      "TOPIC_TRADES" to "bayn.market-data.delayed-sip.trades.v1",
      "TOPIC_QUOTES" to paid.getValue("TOPIC_TRADES"),
      "TOPIC_TRADE_UPDATES_V2" to paid.getValue("TOPIC_TRADES"),
    )) {
      assertFailsWith<IllegalArgumentException> { ForwarderConfig.fromEnv(paid + (key to value)) }
    }
    assertFailsWith<IllegalArgumentException> { ForwarderConfig.fromEnv(paid - "TOPIC_TRADES") }
    for (latest in listOf("", "AAPL")) {
      val failure =
        assertFailsWith<IllegalArgumentException> { ForwarderConfig.fromEnv(paid + ("ALPACA_LATEST_SYMBOLS" to latest)) }
      assertContains(failure.message.orEmpty(), "ALPACA_LATEST_SYMBOLS is IEX-only")
    }
    val config = ForwarderConfig.fromEnv(paid)
    assertFailsWith<IllegalArgumentException> {
      config.copy(latestMarketData = LatestMarketDataConfig(listOf("AAPL"), 2000, 10_000)).marketDataFeedConfigs()
    }
  }

  @Test
  fun `cannot raise the budget for non SIP lanes or sneak SIP into observations`() {
    for (feed in listOf("iex", "delayed_sip", "overnight")) {
      assertFailsWith<IllegalArgumentException> {
        ForwarderConfig.fromEnv(base + mapOf("ALPACA_FEED" to feed, "ALPACA_MAX_SYMBOL_CHANNELS" to "219"))
      }
    }
    val failure =
      assertFailsWith<IllegalArgumentException> {
        ForwarderConfig.fromEnv(sipTestEnv(listOf("AAPL")) + mapOf("ALPACA_FEED" to "iex", "ALPACA_OBSERVATION_FEEDS" to "sip"))
      }
    assertContains(failure.message.orEmpty(), "separate forwarder")
  }
}
