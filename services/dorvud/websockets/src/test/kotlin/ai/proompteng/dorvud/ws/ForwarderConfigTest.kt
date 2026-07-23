package ai.proompteng.dorvud.ws

import java.io.File
import java.nio.file.Files
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull

class ForwarderConfigTest {
  private val authoritativeUniverse =
    mapOf(
      "SYMBOLS" to "AMD,AVGO,COHR,CRDO,LITE,MRVL,MU,NVDA,WDC",
      "SYMBOLS_ALLOWLIST" to "AMD,AVGO,COHR,CRDO,LITE,MRVL,MU,NVDA,WDC",
      "MARKET_DATA_UNIVERSE_ID" to "equity-infrastructure-v1",
      "MARKET_DATA_UNIVERSE_SYMBOL_HASH" to
        "ddcc8adc04dc29822969cddf02b821ea8110856162cca20a7ff28c1c43263e18",
    )

  private val observationTopics =
    mapOf(
      "TOPIC_DELAYED_SIP_TRADES" to "bayn.market-data.delayed-sip.trades.v1",
      "TOPIC_DELAYED_SIP_QUOTES" to "bayn.market-data.delayed-sip.quotes.v1",
      "TOPIC_DELAYED_SIP_BARS_1M" to "bayn.market-data.delayed-sip.bars.1m.v1",
      "TOPIC_OVERNIGHT_TRADES" to "bayn.market-data.overnight.trades.v1",
      "TOPIC_OVERNIGHT_QUOTES" to "bayn.market-data.overnight.quotes.v1",
      "TOPIC_OVERNIGHT_BARS_1M" to "bayn.market-data.overnight.bars.1m.v1",
      "TOPIC_OBSERVATION_STATUS" to "bayn.market-data.observation.status.v1",
    )

  @Test
  fun `preserves the supported sip core feed when observations are disabled`() {
    val cfg =
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "ALPACA_FEED" to "sip",
          "SYMBOLS" to "AAPL",
        ),
      )

    val runtime = cfg.marketDataFeedConfigs().single()
    assertEquals(EquityFeed.Sip, runtime.equityFeed)
    assertEquals("wss://stream.data.alpaca.markets/v2/sip", alpacaMarketDataStreamUrl(cfg, runtime))
  }

  @Test
  fun `builds typed isolated runtimes for the authoritative observation feeds`() {
    val cfg =
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "ALPACA_FEED" to "iex",
          "ALPACA_OBSERVATION_FEEDS" to "delayed_sip,overnight",
        ) + authoritativeUniverse + observationTopics,
      )

    assertEquals(listOf(EquityFeed.DelayedSip, EquityFeed.Overnight), cfg.observationFeeds.map { it.feed })
    val runtimes = cfg.marketDataFeedConfigs()
    assertEquals(listOf("iex", "delayed_sip", "overnight"), runtimes.map { it.feed })
    assertEquals(listOf(true, false, false), runtimes.map { it.core })
    assertEquals(
      listOf(
        "wss://stream.data.alpaca.markets/v2/iex",
        "wss://stream.data.alpaca.markets/v2/delayed_sip",
        "wss://stream.data.alpaca.markets/v1beta1/overnight",
      ),
      runtimes.map { alpacaMarketDataStreamUrl(cfg, it) },
    )
    assertEquals("torghut.trades.v1", runtimes[0].topics.trades)
    assertEquals("bayn.market-data.delayed-sip.trades.v1", runtimes[1].topics.trades)
    assertEquals("bayn.market-data.overnight.trades.v1", runtimes[2].topics.trades)
  }

  @Test
  fun `keeps core trading symbols separate from the observation universe`() {
    val coreSymbols = listOf("AMD", "AVGO", "COHR", "CRDO", "LITE", "MRVL", "MU", "NVDA", "WDC")
    val observationSymbols = listOf("DBC", "EFA", "IEF", "SPY", "VNQ")
    val cfg =
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "ALPACA_FEED" to "iex",
          "ALPACA_OBSERVATION_FEEDS" to "delayed_sip",
          "SYMBOLS" to coreSymbols.joinToString(","),
          "SYMBOLS_ALLOWLIST" to coreSymbols.joinToString(","),
          "ALPACA_OBSERVATION_SYMBOLS" to observationSymbols.joinToString(","),
          "MARKET_DATA_UNIVERSE_ID" to "cross-asset-taa-v1",
          "MARKET_DATA_UNIVERSE_SYMBOL_HASH" to canonicalSymbolHash(observationSymbols),
        ) + observationTopics,
      )

    assertEquals(coreSymbols, cfg.staticSymbols)
    assertEquals(observationSymbols, cfg.observationSymbols)
    assertEquals(observationSymbols, cfg.universeContract?.symbols)
    assertEquals(listOf(coreSymbols, observationSymbols), cfg.marketDataFeedConfigs().map { it.symbols })
  }

  @Test
  fun `rejects unsafe or incomplete observation-feed configuration`() {
    val base =
      mapOf(
        "ALPACA_KEY_ID" to "key",
        "ALPACA_SECRET_KEY" to "secret",
        "ALPACA_OBSERVATION_FEEDS" to "delayed_sip,overnight",
      ) + authoritativeUniverse + observationTopics

    assertEquals(
      "ALPACA_OBSERVATION_FEEDS must not contain duplicates",
      assertFailsWith<IllegalStateException> {
        ForwarderConfig.fromEnv(base + ("ALPACA_OBSERVATION_FEEDS" to "overnight,overnight"))
      }.message,
    )
    assertEquals(
      "ALPACA_FEED must be iex when ALPACA_OBSERVATION_FEEDS is enabled",
      assertFailsWith<IllegalStateException> {
        ForwarderConfig.fromEnv(base + ("ALPACA_FEED" to "delayed_sip"))
      }.message,
    )
    assertEquals(
      "TOPIC_OVERNIGHT_QUOTES must be set when overnight is enabled",
      assertFailsWith<IllegalStateException> {
        ForwarderConfig.fromEnv(base - "TOPIC_OVERNIGHT_QUOTES")
      }.message,
    )
    assertEquals(
      "market-data feed topics must be unique: torghut.trades.v1",
      assertFailsWith<IllegalStateException> {
        ForwarderConfig.fromEnv(base + ("TOPIC_DELAYED_SIP_TRADES" to "torghut.trades.v1"))
      }.message,
    )
    assertEquals(
      "market-data feed topics must be unique: torghut.status.v1",
      assertFailsWith<IllegalStateException> {
        ForwarderConfig.fromEnv(base + ("TOPIC_OBSERVATION_STATUS" to "torghut.status.v1"))
      }.message,
    )
    assertEquals(
      "ALPACA_OBSERVATION_FEEDS requires a versioned static market-data universe",
      assertFailsWith<IllegalStateException> {
        ForwarderConfig.fromEnv(
          mapOf(
            "ALPACA_KEY_ID" to "key",
            "ALPACA_SECRET_KEY" to "secret",
            "ALPACA_OBSERVATION_FEEDS" to "overnight",
            "JANGAR_SYMBOLS_URL" to "http://jangar.test/symbols",
          ) + observationTopics,
        )
      }.message,
    )
    val oversizedUniverse = ('A'..'K').map { it.toString() }
    assertEquals(
      "configured market-data feeds require 33 symbol subscriptions; Alpaca Basic allows 30",
      assertFailsWith<IllegalStateException> {
        ForwarderConfig.fromEnv(
          base +
            mapOf(
              "SYMBOLS" to oversizedUniverse.joinToString(","),
              "SYMBOLS_ALLOWLIST" to oversizedUniverse.joinToString(","),
              "MARKET_DATA_UNIVERSE_SYMBOL_HASH" to canonicalSymbolHash(oversizedUniverse),
            ),
        )
      }.message,
    )
  }

  @Test
  fun `loads defaults when optional envs missing`() {
    val cfg =
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://jangar.test/api/torghut/symbols",
        ),
      )

    assertEquals("http://jangar.test/api/torghut/symbols", cfg.jangarSymbolsUrl)
    assertEquals(emptyList(), cfg.staticSymbols)
    assertEquals(emptySet(), cfg.symbolAllowlist)
    assertEquals(emptyList(), cfg.observationSymbols)
    assertEquals(30_000, cfg.symbolsPollIntervalMs)
    assertEquals(200, cfg.subscribeBatchSize)
    assertEquals(1, cfg.shardCount)
    assertEquals(0, cfg.shardIndex)
    assertEquals("wss://stream.data.alpaca.markets", cfg.alpacaStreamUrl)
    assertEquals("localhost:9093", cfg.kafka.bootstrapServers)
    assertEquals(16L * 1024 * 1024, cfg.kafka.bufferMemoryBytes)
    assertEquals(512 * 1024, cfg.kafka.maxRequestSizeBytes)
    assertEquals(60_000, cfg.kafka.deliveryTimeoutMs)
    assertEquals(15_000, cfg.kafka.requestTimeoutMs)
    assertEquals(10_000, cfg.kafka.maxBlockMs)
    assertEquals(180_000, cfg.healthNotReadyKillAfterMs)
    assertEquals(180_000, cfg.marketDataReadIdleTimeoutMs)
    assertFalse(cfg.enableTradesBackfill)
    assertEquals(24L, cfg.tradesBackfillLookbackHours)
    assertEquals(50_000, cfg.tradesBackfillMaxRecords)
    assertEquals(12L, cfg.barsBackfillLookbackHours)
    assertFalse(cfg.enableTradeUpdates)
    assertEquals(AlpacaMarketType.EQUITY, cfg.alpacaMarketType)
    assertEquals("us", cfg.alpacaCryptoLocation)
    assertEquals(listOf("trades", "quotes", "bars", "updatedBars"), cfg.alpacaMarketDataChannels)
    assertEquals(emptySet(), cfg.optionsMarketHolidays)
    assertEquals("torghut.trades.v1", cfg.topics.trades)
    assertNull(cfg.universeContract)
  }

  @Test
  fun `binds a versioned static universe to its canonical symbol hash`() {
    val symbols = "AMD,AVGO,COHR,CRDO,LITE,MRVL,MU,NVDA,WDC"
    val cfg =
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "SYMBOLS" to symbols,
          "SYMBOLS_ALLOWLIST" to symbols,
          "MARKET_DATA_UNIVERSE_ID" to "equity-infrastructure-v1",
          "MARKET_DATA_UNIVERSE_SYMBOL_HASH" to
            "ddcc8adc04dc29822969cddf02b821ea8110856162cca20a7ff28c1c43263e18",
        ),
      )

    assertEquals(
      MarketDataUniverseContract(
        id = "equity-infrastructure-v1",
        symbolHash = "ddcc8adc04dc29822969cddf02b821ea8110856162cca20a7ff28c1c43263e18",
        symbols = listOf("AMD", "AVGO", "COHR", "CRDO", "LITE", "MRVL", "MU", "NVDA", "WDC"),
      ),
      cfg.universeContract,
    )
  }

  @Test
  fun `rejects drift in a versioned static universe`() {
    val base =
      mapOf(
        "ALPACA_KEY_ID" to "key",
        "ALPACA_SECRET_KEY" to "secret",
        "SYMBOLS" to "AMD,NVDA",
        "SYMBOLS_ALLOWLIST" to "AMD,NVDA",
        "MARKET_DATA_UNIVERSE_ID" to "equity-infrastructure-v1",
        "MARKET_DATA_UNIVERSE_SYMBOL_HASH" to canonicalSymbolHash(listOf("AMD", "NVDA")),
      )

    assertEquals(
      "MARKET_DATA_UNIVERSE_SYMBOL_HASH does not match canonical SYMBOLS",
      assertFailsWith<IllegalStateException> {
        ForwarderConfig.fromEnv(base + ("MARKET_DATA_UNIVERSE_SYMBOL_HASH" to "0".repeat(64)))
      }.message,
    )
    assertEquals(
      "MARKET_DATA_UNIVERSE_ID must be a versioned lowercase identifier",
      assertFailsWith<IllegalStateException> {
        ForwarderConfig.fromEnv(base + ("MARKET_DATA_UNIVERSE_ID" to "Equity Infrastructure V1"))
      }.message,
    )
    assertEquals(
      "SYMBOLS_ALLOWLIST must exactly match SYMBOLS for a versioned market-data universe",
      assertFailsWith<IllegalStateException> {
        ForwarderConfig.fromEnv(base + ("SYMBOLS_ALLOWLIST" to "AMD"))
      }.message,
    )
    assertEquals(
      "SYMBOLS_ALLOWLIST must exactly match SYMBOLS for a versioned market-data universe",
      assertFailsWith<IllegalStateException> {
        ForwarderConfig.fromEnv(base + ("SYMBOLS_ALLOWLIST" to "NVDA,AMD"))
      }.message,
    )
    assertEquals(
      "SYMBOLS_ALLOWLIST must exactly match SYMBOLS for a versioned market-data universe",
      assertFailsWith<IllegalStateException> {
        ForwarderConfig.fromEnv(base + ("SYMBOLS_ALLOWLIST" to "AMD,NVDA,NVDA"))
      }.message,
    )
    assertEquals(
      "a versioned market-data universe cannot use JANGAR_SYMBOLS_URL",
      assertFailsWith<IllegalStateException> {
        ForwarderConfig.fromEnv(base + ("JANGAR_SYMBOLS_URL" to "http://jangar.test/symbols"))
      }.message,
    )
  }

  @Test
  fun `rejects drift in an explicit observation universe`() {
    val base =
      mapOf(
        "ALPACA_KEY_ID" to "key",
        "ALPACA_SECRET_KEY" to "secret",
        "SYMBOLS" to "AMD,NVDA",
        "SYMBOLS_ALLOWLIST" to "AMD,NVDA",
        "ALPACA_OBSERVATION_SYMBOLS" to "DBC,SPY",
        "MARKET_DATA_UNIVERSE_ID" to "cross-asset-taa-v1",
        "MARKET_DATA_UNIVERSE_SYMBOL_HASH" to canonicalSymbolHash(listOf("DBC", "SPY")),
      )

    assertEquals(
      "ALPACA_OBSERVATION_SYMBOLS must be unique and canonically sorted for a versioned market-data universe",
      assertFailsWith<IllegalStateException> {
        ForwarderConfig.fromEnv(base + ("ALPACA_OBSERVATION_SYMBOLS" to "SPY,DBC"))
      }.message,
    )
    assertEquals(
      "MARKET_DATA_UNIVERSE_SYMBOL_HASH does not match canonical ALPACA_OBSERVATION_SYMBOLS",
      assertFailsWith<IllegalStateException> {
        ForwarderConfig.fromEnv(base + ("MARKET_DATA_UNIVERSE_SYMBOL_HASH" to "0".repeat(64)))
      }.message,
    )
    assertEquals(
      "ALPACA_OBSERVATION_SYMBOLS requires a versioned market-data universe",
      assertFailsWith<IllegalStateException> {
        ForwarderConfig.fromEnv(base - "MARKET_DATA_UNIVERSE_ID" - "MARKET_DATA_UNIVERSE_SYMBOL_HASH")
      }.message,
    )
  }

  @Test
  fun `filters static symbols with configured allowlist`() {
    val cfg =
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "SYMBOLS" to "AAPL,NVDA,MSFT,AVGO",
          "SYMBOLS_ALLOWLIST" to "NVDA,AVGO",
        ),
      )

    assertEquals(listOf("NVDA", "AVGO"), cfg.staticSymbols)
    assertEquals(setOf("NVDA", "AVGO"), cfg.symbolAllowlist)
  }

  @Test
  fun `rejects symbol allowlists over twelve names`() {
    val err =
      assertFailsWith<IllegalStateException> {
        ForwarderConfig.fromEnv(
          mapOf(
            "ALPACA_KEY_ID" to "key",
            "ALPACA_SECRET_KEY" to "secret",
            "SYMBOLS" to "NVDA",
            "SYMBOLS_ALLOWLIST" to "A,B,C,D,E,F,G,H,I,J,K,L,M",
          ),
        )
      }

    assertEquals("SYMBOLS_ALLOWLIST must include no more than 12 symbols", err.message)
  }

  @Test
  fun `supports kafka and liveness override knobs`() {
    val cfg =
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://jangar.test/api/torghut/symbols",
          "KAFKA_BUFFER_MEMORY_BYTES" to "8388608",
          "KAFKA_MAX_REQUEST_SIZE_BYTES" to "262144",
          "KAFKA_DELIVERY_TIMEOUT_MS" to "45000",
          "KAFKA_REQUEST_TIMEOUT_MS" to "12000",
          "KAFKA_MAX_BLOCK_MS" to "5000",
          "BARS_BACKFILL_LOOKBACK_HOURS" to "120",
          "HEALTH_NOT_READY_KILL_AFTER_MS" to "120000",
          "ALPACA_MARKET_DATA_READ_IDLE_TIMEOUT_MS" to "240000",
          "ENABLE_TRADES_BACKFILL" to "true",
          "TRADES_BACKFILL_LOOKBACK_HOURS" to "120",
          "TRADES_BACKFILL_MAX_RECORDS" to "75000",
        ),
      )

    assertEquals(8L * 1024 * 1024, cfg.kafka.bufferMemoryBytes)
    assertEquals(256 * 1024, cfg.kafka.maxRequestSizeBytes)
    assertEquals(45_000, cfg.kafka.deliveryTimeoutMs)
    assertEquals(12_000, cfg.kafka.requestTimeoutMs)
    assertEquals(5_000, cfg.kafka.maxBlockMs)
    assertEquals(120L, cfg.barsBackfillLookbackHours)
    assertEquals(120_000, cfg.healthNotReadyKillAfterMs)
    assertEquals(240_000, cfg.marketDataReadIdleTimeoutMs)
    assertEquals(true, cfg.enableTradesBackfill)
    assertEquals(120L, cfg.tradesBackfillLookbackHours)
    assertEquals(75_000, cfg.tradesBackfillMaxRecords)
  }

  @Test
  fun `coerces market data idle read timeout to safe lower bound`() {
    val cfg =
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://jangar.test/api/torghut/symbols",
          "ALPACA_MARKET_DATA_READ_IDLE_TIMEOUT_MS" to "1000",
        ),
      )

    assertEquals(30_000, cfg.marketDataReadIdleTimeoutMs)
  }

  @Test
  fun `supports crypto market type`() {
    val cfg =
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://jangar.test/api/torghut/symbols?assetClass=crypto",
          "ALPACA_MARKET_TYPE" to "crypto",
        ),
      )

    assertEquals(AlpacaMarketType.CRYPTO, cfg.alpacaMarketType)
    assertEquals("us", cfg.alpacaCryptoLocation)
    assertEquals(listOf("trades", "quotes", "bars"), cfg.alpacaMarketDataChannels)
  }

  @Test
  fun `supports crypto location override`() {
    val cfg =
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://jangar.test/api/torghut/symbols?assetClass=crypto",
          "ALPACA_MARKET_TYPE" to "crypto",
          "ALPACA_CRYPTO_LOCATION" to "eu-1",
        ),
      )

    assertEquals(AlpacaMarketType.CRYPTO, cfg.alpacaMarketType)
    assertEquals("eu-1", cfg.alpacaCryptoLocation)
  }

  @Test
  fun `supports options market type with opra defaults`() {
    val cfg =
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://torghut-options-catalog.torghut.svc.cluster.local:8080/v1/options/hot-set",
          "ALPACA_MARKET_TYPE" to "options",
          "TOPIC_TRADES" to "torghut.options.trades.v1",
          "TOPIC_QUOTES" to "torghut.options.quotes.v1",
          "TOPIC_STATUS" to "torghut.options.status.v1",
          "OPTIONS_MARKET_HOLIDAYS" to "2026-07-03, 2026-12-25",
        ),
      )

    assertEquals(AlpacaMarketType.OPTIONS, cfg.alpacaMarketType)
    assertEquals("opra", cfg.alpacaFeed)
    assertEquals(listOf("trades", "quotes"), cfg.alpacaMarketDataChannels)
    assertEquals(setOf(LocalDate.parse("2026-07-03"), LocalDate.parse("2026-12-25")), cfg.optionsMarketHolidays)
    assertEquals(null, cfg.topics.bars1m)
  }

  @Test
  fun `rejects unknown crypto location`() {
    assertFailsWith<IllegalStateException> {
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://jangar.test/api/torghut/symbols",
          "ALPACA_MARKET_TYPE" to "crypto",
          "ALPACA_CRYPTO_LOCATION" to "moon-1",
        ),
      )
    }
  }

  @Test
  fun `rejects unknown market type`() {
    assertFailsWith<IllegalStateException> {
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://jangar.test/api/torghut/symbols",
          "ALPACA_MARKET_TYPE" to "futures",
        ),
      )
    }
  }

  @Test
  fun `rejects non-positive liveness and kafka guardrail values`() {
    assertFailsWith<IllegalStateException> {
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://jangar.test/api/torghut/symbols",
          "KAFKA_BUFFER_MEMORY_BYTES" to "0",
        ),
      )
    }
    assertFailsWith<IllegalStateException> {
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://jangar.test/api/torghut/symbols",
          "HEALTH_NOT_READY_KILL_AFTER_MS" to "0",
        ),
      )
    }
    assertFailsWith<IllegalStateException> {
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://jangar.test/api/torghut/symbols",
          "BARS_BACKFILL_LOOKBACK_HOURS" to "0",
        ),
      )
    }
    assertFailsWith<IllegalStateException> {
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://jangar.test/api/torghut/symbols",
          "ALPACA_MARKET_DATA_READ_IDLE_TIMEOUT_MS" to "0",
        ),
      )
    }
    assertFailsWith<IllegalStateException> {
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://jangar.test/api/torghut/symbols",
          "TRADES_BACKFILL_LOOKBACK_HOURS" to "0",
        ),
      )
    }
    assertFailsWith<IllegalStateException> {
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://jangar.test/api/torghut/symbols",
          "TRADES_BACKFILL_MAX_RECORDS" to "0",
        ),
      )
    }
  }

  @Test
  fun `rejects trades backfill outside equity mode`() {
    assertFailsWith<IllegalStateException> {
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://jangar.test/api/torghut/symbols",
          "ALPACA_MARKET_TYPE" to "options",
          "ENABLE_TRADES_BACKFILL" to "true",
        ),
      )
    }
  }

  @Test
  fun `supports explicit market data channels override`() {
    val cfg =
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://jangar.test/api/torghut/symbols",
          "ALPACA_MARKET_DATA_CHANNELS" to "trades,bars,updatedBars",
        ),
      )

    assertEquals(listOf("trades", "bars", "updatedBars"), cfg.alpacaMarketDataChannels)
  }

  @Test
  fun `rejects unsupported market data channels`() {
    assertFailsWith<IllegalStateException> {
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://jangar.test/api/torghut/symbols",
          "ALPACA_MARKET_DATA_CHANNELS" to "trades,dailyBars",
        ),
      )
    }
  }

  @Test
  fun `rejects bars backfill in options mode`() {
    assertFailsWith<IllegalStateException> {
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://torghut-options-catalog.torghut.svc.cluster.local:8080/v1/options/hot-set",
          "ALPACA_MARKET_TYPE" to "options",
          "ENABLE_BARS_BACKFILL" to "true",
        ),
      )
    }
  }

  @Test
  fun `requires symbols source when jangar missing`() {
    assertFailsWith<IllegalStateException> {
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
        ),
      )
    }
  }

  @Test
  fun `rejects empty jangar symbols url without fallback`() {
    assertFailsWith<IllegalStateException> {
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "   ",
        ),
      )
    }
  }

  @Test
  fun `accepts static symbols when jangar missing`() {
    val cfg =
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "SYMBOLS" to "AAPL, msft,  ,TSLA",
        ),
      )

    assertEquals(null, cfg.jangarSymbolsUrl)
    assertEquals(listOf("AAPL", "msft", "TSLA"), cfg.staticSymbols)
  }

  @Test
  fun `allows overriding stream url`() {
    val cfg =
      ForwarderConfig.fromEnv(
        mapOf(
          "ALPACA_KEY_ID" to "key",
          "ALPACA_SECRET_KEY" to "secret",
          "JANGAR_SYMBOLS_URL" to "http://jangar.test/api/torghut/symbols",
          "ALPACA_STREAM_URL" to "wss://stream.data.sandbox.alpaca.markets",
        ),
      )

    assertEquals("wss://stream.data.sandbox.alpaca.markets", cfg.alpacaStreamUrl)
  }

  @Test
  fun `loads values from dotenv when present`() {
    val tmpDir = Files.createTempDirectory("ws-dotenv-test").toFile()
    val envFile = File(tmpDir, ".env")
    envFile.writeText(
      """
      ALPACA_KEY_ID=from-dotenv
      ALPACA_SECRET_KEY=secret
      ALPACA_STREAM_URL=wss://example.test
      JANGAR_SYMBOLS_URL=http://jangar.test/api/torghut/symbols
      """.trimIndent(),
    )

    val originalUserDir = System.getProperty("user.dir")
    val originalDotenvPath = System.getProperty("dotenv.path")
    System.setProperty("dotenv.path", envFile.absolutePath)
    System.setProperty("user.dir", tmpDir.absolutePath)

    try {
      val cfg = ForwarderConfig.fromEnv()
      assertEquals("from-dotenv", cfg.alpacaKeyId)
      assertEquals("wss://example.test", cfg.alpacaStreamUrl)
      assertEquals("http://jangar.test/api/torghut/symbols", cfg.jangarSymbolsUrl)
    } finally {
      System.setProperty("user.dir", originalUserDir)
      if (originalDotenvPath != null) {
        System.setProperty("dotenv.path", originalDotenvPath)
      } else {
        System.clearProperty("dotenv.path")
      }
      envFile.delete()
      tmpDir.delete()
    }
  }

  @Test
  fun `prefers env local over env`() {
    val tmpDir = Files.createTempDirectory("ws-dotenv-test").toFile()
    val envFile = File(tmpDir, ".env")
    envFile.writeText(
      """
      ALPACA_KEY_ID=from-env
      ALPACA_SECRET_KEY=secret-env
      JANGAR_SYMBOLS_URL=http://jangar.env/api/torghut/symbols
      """.trimIndent(),
    )
    val envLocalFile = File(tmpDir, ".env.local")
    envLocalFile.writeText(
      """
      ALPACA_KEY_ID=from-local
      ALPACA_SECRET_KEY=secret-local
      JANGAR_SYMBOLS_URL=http://jangar.local/api/torghut/symbols
      """.trimIndent(),
    )

    val originalDotenvPath = System.getProperty("dotenv.path")
    val originalUserDir = System.getProperty("user.dir")
    System.setProperty("user.dir", tmpDir.absolutePath)

    try {
      val cfg = ForwarderConfig.fromEnv()
      assertEquals("from-local", cfg.alpacaKeyId)
      assertEquals("http://jangar.local/api/torghut/symbols", cfg.jangarSymbolsUrl)
    } finally {
      System.setProperty("user.dir", originalUserDir)
      if (originalDotenvPath != null) {
        System.setProperty("dotenv.path", originalDotenvPath)
      } else {
        System.clearProperty("dotenv.path")
      }
      envLocalFile.delete()
      envFile.delete()
      tmpDir.delete()
    }
  }

  @Test
  fun `loads dotenv from module subdir when run at repo root`() {
    val rootDir = Files.createTempDirectory("ws-root-test").toFile()
    val moduleDir = File(rootDir, "services/dorvud/websockets")
    moduleDir.mkdirs()
    val envLocal = File(moduleDir, ".env.local")
    envLocal.writeText(
      """
      ALPACA_KEY_ID=from-subdir
      ALPACA_SECRET_KEY=subdir-secret
      JANGAR_SYMBOLS_URL=http://jangar.subdir/api/torghut/symbols
      KAFKA_BOOTSTRAP=localhost:19092
      """.trimIndent(),
    )

    val originalUserDir = System.getProperty("user.dir")
    System.setProperty("user.dir", rootDir.absolutePath)

    try {
      val cfg = ForwarderConfig.fromEnv()
      assertEquals("from-subdir", cfg.alpacaKeyId)
      assertEquals("localhost:19092", cfg.kafka.bootstrapServers)
      assertEquals("http://jangar.subdir/api/torghut/symbols", cfg.jangarSymbolsUrl)
    } finally {
      System.setProperty("user.dir", originalUserDir)
      envLocal.delete()
      moduleDir.delete()
      File(rootDir, "services/dorvud").delete()
      File(rootDir, "services").delete()
      rootDir.delete()
    }
  }

  @Test
  fun `loads plain env file when dotenv parse returns empty`() {
    val tmpDir = Files.createTempDirectory("ws-plain-env").toFile()
    val envFile = File(tmpDir, "custom.env")
    envFile.writeText(
      """
      ALPACA_KEY_ID=plain-id
      ALPACA_SECRET_KEY=plain-secret
      JANGAR_SYMBOLS_URL=http://jangar.plain/api/torghut/symbols
      """.trimIndent(),
    )

    val originalDotenvPath = System.getProperty("dotenv.path")
    val originalUserDir = System.getProperty("user.dir")
    System.setProperty("dotenv.path", envFile.absolutePath)
    System.setProperty("user.dir", tmpDir.absolutePath)

    try {
      val cfg = ForwarderConfig.fromEnv()
      assertEquals("plain-id", cfg.alpacaKeyId)
      assertEquals("http://jangar.plain/api/torghut/symbols", cfg.jangarSymbolsUrl)
    } finally {
      if (originalDotenvPath != null) {
        System.setProperty("dotenv.path", originalDotenvPath)
      } else {
        System.clearProperty("dotenv.path")
      }
      envFile.delete()
      tmpDir.delete()
      if (originalUserDir != null) {
        System.setProperty("user.dir", originalUserDir)
      } else {
        System.clearProperty("user.dir")
      }
    }
  }

  @Test
  fun `dotenv path overrides files under user dir`() {
    val rootDir = Files.createTempDirectory("ws-root-test").toFile()
    val userEnvLocal = File(rootDir, ".env.local")
    userEnvLocal.writeText(
      """
      ALPACA_KEY_ID=from-userdir
      ALPACA_SECRET_KEY=userdir-secret
      JANGAR_SYMBOLS_URL=http://jangar.userdir/api/torghut/symbols
      """.trimIndent(),
    )

    val explicitFile = File(rootDir, "custom.env")
    explicitFile.writeText(
      """
      ALPACA_KEY_ID=from-explicit
      ALPACA_SECRET_KEY=explicit-secret
      JANGAR_SYMBOLS_URL=http://jangar.explicit/api/torghut/symbols
      """.trimIndent(),
    )

    val originalUserDir = System.getProperty("user.dir")
    val originalDotenvPath = System.getProperty("dotenv.path")
    System.setProperty("user.dir", rootDir.absolutePath)
    System.setProperty("dotenv.path", explicitFile.absolutePath)

    try {
      val cfg = ForwarderConfig.fromEnv()
      assertEquals("from-explicit", cfg.alpacaKeyId)
      assertEquals("http://jangar.explicit/api/torghut/symbols", cfg.jangarSymbolsUrl)
    } finally {
      if (originalUserDir != null) System.setProperty("user.dir", originalUserDir) else System.clearProperty("user.dir")
      if (originalDotenvPath != null) System.setProperty("dotenv.path", originalDotenvPath) else System.clearProperty("dotenv.path")
      userEnvLocal.delete()
      explicitFile.delete()
      rootDir.delete()
    }
  }
}
