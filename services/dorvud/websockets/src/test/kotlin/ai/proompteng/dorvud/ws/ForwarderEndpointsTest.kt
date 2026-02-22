package ai.proompteng.dorvud.ws

import ai.proompteng.dorvud.platform.KafkaAuth
import ai.proompteng.dorvud.platform.KafkaProducerSettings
import ai.proompteng.dorvud.platform.KafkaTls
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ForwarderEndpointsTest {
  private fun baseConfig(marketType: AlpacaMarketType): ForwarderConfig =
    ForwarderConfig(
      alpacaKeyId = "key",
      alpacaSecretKey = "secret",
      alpacaMarketType = marketType,
      alpacaCryptoLocation = "us",
      alpacaFeed = "iex",
      alpacaStreamUrl = "wss://stream.data.alpaca.markets/",
      alpacaBaseUrl = "https://data.alpaca.markets/",
      alpacaTradeStreamUrl = null,
      jangarSymbolsUrl = "http://jangar/api/torghut/symbols",
      staticSymbols = emptyList(),
      symbolsPollIntervalMs = 30_000,
      subscribeBatchSize = 200,
      shardCount = 1,
      shardIndex = 0,
      enableTradeUpdates = false,
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
          trades = "torghut.trades.v1",
          quotes = "torghut.quotes.v1",
          bars1m = "torghut.bars.1m.v1",
          status = "torghut.status.v1",
          tradeUpdates = null,
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
}
