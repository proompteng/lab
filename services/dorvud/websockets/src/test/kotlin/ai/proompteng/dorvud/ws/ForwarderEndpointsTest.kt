package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.KafkaAuth
import ai.proompteng.dorvud.platform.KafkaProducerSettings
import ai.proompteng.dorvud.platform.KafkaTls
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class ForwarderEndpointsTest {
  private fun baseConfig(marketType: AlpacaMarketType): ForwarderConfig =
    ForwarderConfig(
      alpacaKeyId = "key",
      alpacaSecretKey = "secret",
      alpacaMarketType = marketType,
      alpacaCryptoLocation = "us",
      alpacaFeed = if (marketType == AlpacaMarketType.OPTIONS) "opra" else "iex",
      alpacaStreamUrl = "wss://stream.data.alpaca.markets/",
      alpacaBaseUrl = "https://data.alpaca.markets/",
      alpacaTradeStreamUrl = null,
      alpacaMarketDataChannels = defaultAlpacaMarketDataChannels(marketType),
      jangarSymbolsUrl = "http://jangar/api/torghut/symbols",
      staticSymbols = emptyList(),
      symbolsPollIntervalMs = 30_000,
      subscribeBatchSize = 200,
      shardCount = 1,
      shardIndex = 0,
      enableTradeUpdates = false,
      torghutAccountLabel = null,
      enableBarsBackfill = false,
      reconnectBaseMs = 500,
      reconnectMaxMs = 30_000,
      dedupTtlSeconds = 5,
      dedupMaxEntries = 10_000,
      kafka =
        KafkaProducerSettings(
          bootstrapServers = "localhost:9092",
          clientId = "dorvud-ws",
          lingerMs = 30,
          batchSize = 32768,
          acks = "all",
          compressionType = "lz4",
          securityProtocol = "SASL_PLAINTEXT",
          auth = KafkaAuth("user", "pass", "SCRAM-SHA-512"),
          tls = KafkaTls(),
        ),
      topics =
        TopicConfig(
          trades = if (marketType == AlpacaMarketType.OPTIONS) "torghut.options.trades.v1" else "torghut.trades.v1",
          quotes = if (marketType == AlpacaMarketType.OPTIONS) "torghut.options.quotes.v1" else "torghut.quotes.v1",
          bars1m = if (marketType == AlpacaMarketType.OPTIONS) null else "torghut.bars.1m.v1",
          status = if (marketType == AlpacaMarketType.OPTIONS) "torghut.options.status.v1" else "torghut.status.v1",
          tradeUpdates = null,
          tradeUpdatesV2 = null,
        ),
    )

  @Test
  fun `equity endpoints use feed path and stocks backfill`() {
    val cfg = baseConfig(AlpacaMarketType.EQUITY)
    assertEquals("wss://stream.data.alpaca.markets/v2/iex", alpacaMarketDataStreamUrl(cfg))
    assertEquals("https://data.alpaca.markets/v2/stocks/bars", alpacaBarsBackfillUrl(cfg))
    assertTrue(alpacaBarsBackfillNeedsFeed(cfg))
    assertEquals(listOf("trades", "quotes", "bars", "updatedBars"), alpacaMarketDataChannels(cfg))
  }

  @Test
  fun `crypto endpoints use crypto paths and skip feed parameter`() {
    val cfg = baseConfig(AlpacaMarketType.CRYPTO)
    assertEquals("wss://stream.data.alpaca.markets/v1beta3/crypto/us", alpacaMarketDataStreamUrl(cfg))
    assertEquals("https://data.alpaca.markets/v1beta3/crypto/us/bars", alpacaBarsBackfillUrl(cfg))
    assertFalse(alpacaBarsBackfillNeedsFeed(cfg))
    assertEquals(listOf("trades", "quotes", "bars"), alpacaMarketDataChannels(cfg))
  }

  @Test
  fun `crypto endpoints respect configured location`() {
    val cfg = baseConfig(AlpacaMarketType.CRYPTO).copy(alpacaCryptoLocation = "eu-1")
    assertEquals("wss://stream.data.alpaca.markets/v1beta3/crypto/eu-1", alpacaMarketDataStreamUrl(cfg))
    assertEquals("https://data.alpaca.markets/v1beta3/crypto/eu-1/bars", alpacaBarsBackfillUrl(cfg))
  }

  @Test
  fun `options endpoints use opra websocket path and disable bars backfill`() {
    val cfg = baseConfig(AlpacaMarketType.OPTIONS)
    assertEquals("wss://stream.data.alpaca.markets/v1beta1/opra", alpacaMarketDataStreamUrl(cfg))
    assertEquals(listOf("trades", "quotes"), alpacaMarketDataChannels(cfg))
    assertFailsWith<IllegalStateException> {
      alpacaBarsBackfillUrl(cfg)
    }
  }

  @Test
  fun `bars backfill parser tolerates next page token`() {
    val payload = """{"bars":{},"next_page_token":null}"""
    val parsed =
      decodeAlpacaBarsResponse(
        payload,
        Json {
          ignoreUnknownKeys = true
        },
      )
    val bars = assertNotNull(parsed.bars)
    assertTrue(bars.jsonObject.isEmpty())
  }
}
