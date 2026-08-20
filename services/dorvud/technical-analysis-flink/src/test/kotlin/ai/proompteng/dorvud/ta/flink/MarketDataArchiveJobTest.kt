package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.AlpacaBarPayload
import ai.proompteng.dorvud.ta.stream.QuotePayload
import ai.proompteng.dorvud.ta.stream.TradePayload
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.apache.kafka.clients.consumer.OffsetResetStrategy
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class MarketDataArchiveJobTest {
  private val observationSymbols = setOf("DBC", "EFA", "IEF", "SPY", "VNQ")
  private val observationUniverse =
    ArchiveUniverse("cross-asset-taa-v1", symbolHash(observationSymbols), observationSymbols)
  private val coreSymbols = setOf("AMD", "AVGO", "COHR", "CRDO", "LITE", "MRVL", "MU", "NVDA", "SNDK", "WDC")
  private val coreUniverse = ArchiveUniverse("torghut-core-equity-v1", symbolHash(coreSymbols), coreSymbols)
  private val routes =
    mapOf(
      "torghut.bars.1m.v1" to ArchiveRoute("sip", coreUniverse),
      "torghut.quotes.v1" to ArchiveRoute("sip", coreUniverse, ArchiveRecordKind.Quote),
      "torghut.trades.v1" to ArchiveRoute("sip", coreUniverse, ArchiveRecordKind.Trade),
      "bayn.market-data.delayed-sip.bars.1m.v1" to ArchiveRoute("delayed_sip", observationUniverse),
      "bayn.market-data.delayed-sip.quotes.v1" to
        ArchiveRoute("delayed_sip", observationUniverse, ArchiveRecordKind.Quote),
      "bayn.market-data.delayed-sip.trades.v1" to
        ArchiveRoute("delayed_sip", observationUniverse, ArchiveRecordKind.Trade),
      "bayn.market-data.overnight.bars.1m.v1" to ArchiveRoute("overnight", observationUniverse),
    )

  @Test
  fun `decodes enriched bars with source-offset lineage and cross-feed separation`() {
    val sip =
      decodeArchiveBar(
        record("torghut.bars.1m.v1", envelope("sip", "real_time_consolidated", symbol = "NVDA")),
        routes,
      )
    val delayed =
      decodeArchiveBar(
        record(
          "bayn.market-data.delayed-sip.bars.1m.v1",
          envelope("delayed_sip", "delayed_15m_consolidated"),
          partition = 2,
          offset = 42,
        ),
        routes,
      )
    val overnight =
      decodeArchiveBar(
        record("bayn.market-data.overnight.bars.1m.v1", envelope("overnight", "derived", session = "overnight")),
        routes,
      )

    assertEquals("sip", sip.feed)
    assertEquals("torghut-core-equity-v1", sip.universeId)
    assertEquals(coreUniverse.symbolHash, sip.universeSymbolHash)
    assertEquals("bars", sip.channel)
    assertEquals("delayed_sip", delayed.feed)
    assertEquals("cross-asset-taa-v1", delayed.universeId)
    assertEquals(observationUniverse.symbolHash, delayed.universeSymbolHash)
    assertEquals(2, delayed.sourcePartition)
    assertEquals(42, delayed.sourceOffset)
    assertEquals("overnight", overnight.feed)
    assertEquals("overnight", overnight.marketSession)
    assertEquals(3, setOf(sip.feed, delayed.feed, overnight.feed).size)
  }

  @Test
  fun `rejects topic-feed mismatch metadata drift and invalid prices`() {
    assertFailsWith<IllegalArgumentException> {
      decodeArchiveBar(
        record("torghut.bars.1m.v1", envelope("overnight", "derived", symbol = "NVDA")),
        routes,
      )
    }
    assertFailsWith<IllegalArgumentException> {
      decodeArchiveBar(
        record("bayn.market-data.overnight.bars.1m.v1", envelope("overnight", "indicative_real_time")),
        routes,
      )
    }
    assertFailsWith<IllegalArgumentException> {
      decodeArchiveBar(
        record("torghut.bars.1m.v1", envelope("sip", "real_time_consolidated", high = 99.0, symbol = "NVDA")),
        routes,
      )
    }
  }

  @Test
  fun `rejects bars outside the configured universe and invalid Kafka lineage`() {
    assertFailsWith<IllegalArgumentException> {
      decodeArchiveBar(
        record("torghut.bars.1m.v1", envelope("sip", "real_time_consolidated", symbol = "SPY")),
        routes,
      )
    }
    assertFailsWith<IllegalArgumentException> {
      decodeArchiveBar(
        record(
          "bayn.market-data.delayed-sip.bars.1m.v1",
          envelope("delayed_sip", "delayed_15m_consolidated", symbol = "NVDA"),
        ),
        routes,
      )
    }
    assertFailsWith<IllegalArgumentException> {
      decodeArchiveBar(
        record(
          "torghut.bars.1m.v1",
          envelope("sip", "real_time_consolidated", symbol = "NVDA"),
          offset = -1,
        ),
        routes,
      )
    }
  }

  @Test
  fun `same Kafka record decodes deterministically for at-least-once replay`() {
    val record =
      record(
        "bayn.market-data.delayed-sip.bars.1m.v1",
        envelope("delayed_sip", "delayed_15m_consolidated"),
        partition = 1,
        offset = 99,
      )

    assertEquals(decodeArchiveBar(record, routes), decodeArchiveBar(record, routes))
  }

  @Test
  fun `decodes quote and trade lineage without inventing an NBBO feed`() {
    val quote =
      decodeArchiveQuote(
        quoteRecord(
          "torghut.quotes.v1",
          quoteEnvelope("sip", "real_time_consolidated", symbol = "NVDA"),
          partition = 1,
          offset = 20,
        ),
        routes,
      )
    val trade =
      decodeArchiveTrade(
        tradeRecord(
          "bayn.market-data.delayed-sip.trades.v1",
          tradeEnvelope("delayed_sip", "delayed_15m_consolidated"),
          partition = 2,
          offset = 21,
        ),
        routes,
      )

    assertEquals("sip", quote.feed)
    assertEquals("real_time_consolidated", quote.delayClass)
    assertEquals(100.0, quote.bidPrice)
    assertEquals(100.1, quote.askPrice)
    assertEquals(1, quote.sourcePartition)
    assertEquals(20, quote.sourceOffset)
    assertEquals("delayed_sip", trade.feed)
    assertEquals("delayed_15m_consolidated", trade.delayClass)
    assertEquals(100.05, trade.price)
    assertEquals(2, trade.sourcePartition)
    assertEquals(21, trade.sourceOffset)
  }

  @Test
  fun `rejects crossed quotes invalid trades and channel-topic mismatches`() {
    assertFailsWith<IllegalArgumentException> {
      decodeArchiveQuote(
        quoteRecord(
          "torghut.quotes.v1",
          quoteEnvelope("sip", "real_time_consolidated", bidPrice = 101.0, askPrice = 100.0, symbol = "NVDA"),
        ),
        routes,
      )
    }
    assertFailsWith<IllegalArgumentException> {
      decodeArchiveTrade(
        tradeRecord(
          "bayn.market-data.delayed-sip.trades.v1",
          tradeEnvelope("delayed_sip", "delayed_15m_consolidated", size = 0.0),
        ),
        routes,
      )
    }
    assertFailsWith<IllegalArgumentException> {
      decodeArchiveQuote(
        quoteRecord(
          "torghut.quotes.v1",
          quoteEnvelope("sip", "real_time_consolidated", channel = "trades", symbol = "NVDA"),
        ),
        routes,
      )
    }
  }

  @Test
  fun `archive configuration rejects duplicate topics and unbounded values`() {
    val valid =
      mapOf(
        "ARCHIVE_CORE_FEED" to "sip",
        "ARCHIVE_CORE_BARS_TOPIC" to "torghut.bars.1m.v1",
        "ARCHIVE_CORE_QUOTES_TOPIC" to "torghut.quotes.v1",
        "ARCHIVE_CORE_TRADES_TOPIC" to "torghut.trades.v1",
        "ARCHIVE_DELAYED_SIP_BARS_TOPIC" to "bayn.market-data.delayed-sip.bars.1m.v1",
        "ARCHIVE_DELAYED_SIP_QUOTES_TOPIC" to "bayn.market-data.delayed-sip.quotes.v1",
        "ARCHIVE_DELAYED_SIP_TRADES_TOPIC" to "bayn.market-data.delayed-sip.trades.v1",
        "ARCHIVE_OVERNIGHT_BARS_TOPIC" to "bayn.market-data.overnight.bars.1m.v1",
        "ARCHIVE_CLICKHOUSE_URL" to "jdbc:clickhouse://clickhouse:8123/signal",
        "ARCHIVE_CLICKHOUSE_PASSWORD" to "clickhouse-password",
        "ARCHIVE_KAFKA_PASSWORD" to "password",
        "ARCHIVE_OFFSET_RESET" to "latest",
        "ARCHIVE_EVENT_GROUP_ID" to "bayn-market-data-archive-events-v1",
        "ARCHIVE_CORE_UNIVERSE_ID" to coreUniverse.id,
        "ARCHIVE_CORE_UNIVERSE_SYMBOLS" to coreUniverse.symbols.sorted().joinToString(","),
        "ARCHIVE_CORE_UNIVERSE_SYMBOL_HASH" to coreUniverse.symbolHash,
        "UNIVERSE_ID" to observationUniverse.id,
        "UNIVERSE_SYMBOLS" to observationUniverse.symbols.sorted().joinToString(","),
        "UNIVERSE_SYMBOL_HASH" to observationUniverse.symbolHash,
      )
    val config = MarketDataArchiveConfig.fromEnv(valid)
    assertEquals(7, config.routes.size)
    assertEquals(coreUniverse, config.routes.getValue("torghut.bars.1m.v1").universe)
    assertEquals(
      observationUniverse,
      config.routes.getValue("bayn.market-data.delayed-sip.bars.1m.v1").universe,
    )
    assertEquals(100, config.clickhouseBatchSize)
    assertEquals("signal_publisher", config.clickhouseUsername)
    assertEquals(OffsetResetStrategy.LATEST, config.offsetResetStrategy)
    assertEquals("bayn-market-data-archive-v1", config.groupId)
    assertEquals("bayn-market-data-archive-events-v1", config.eventGroupId)
    assertEquals(3, config.routes.values.count { it.kind == ArchiveRecordKind.Bar })
    assertEquals(4, config.routes.values.count { it.kind != ArchiveRecordKind.Bar })

    val legacy =
      MarketDataArchiveConfig.fromEnv(
        valid
          .minus(
            listOf(
              "ARCHIVE_CORE_FEED",
              "ARCHIVE_CORE_BARS_TOPIC",
              "ARCHIVE_CORE_QUOTES_TOPIC",
              "ARCHIVE_CORE_TRADES_TOPIC",
              "ARCHIVE_DELAYED_SIP_QUOTES_TOPIC",
              "ARCHIVE_DELAYED_SIP_TRADES_TOPIC",
            ),
          ).plus("ARCHIVE_IEX_BARS_TOPIC" to "torghut.bars.1m.v1"),
      )
    assertEquals(3, legacy.routes.size)
    assertEquals("iex", legacy.routes.getValue("torghut.bars.1m.v1").feed)
    assertEquals(null, legacy.eventGroupId)

    assertFailsWith<IllegalStateException> {
      MarketDataArchiveConfig.fromEnv(
        valid + ("ARCHIVE_DELAYED_SIP_QUOTES_TOPIC" to "torghut.bars.1m.v1"),
      )
    }
    assertFailsWith<IllegalArgumentException> {
      MarketDataArchiveConfig.fromEnv(valid - "ARCHIVE_DELAYED_SIP_TRADES_TOPIC")
    }
    assertFailsWith<IllegalStateException> {
      MarketDataArchiveConfig.fromEnv(valid - "ARCHIVE_EVENT_GROUP_ID")
    }
    assertFailsWith<IllegalArgumentException> {
      MarketDataArchiveConfig.fromEnv(valid + ("ARCHIVE_EVENT_GROUP_ID" to "bayn-market-data-archive-v1"))
    }
    assertFailsWith<IllegalArgumentException> {
      MarketDataArchiveConfig.fromEnv(valid + ("ARCHIVE_CLICKHOUSE_BATCH_SIZE" to "1001"))
    }
    assertFailsWith<IllegalArgumentException> {
      MarketDataArchiveConfig.fromEnv(valid + ("ARCHIVE_OFFSET_RESET" to "middle"))
    }
    assertFailsWith<IllegalArgumentException> {
      MarketDataArchiveConfig.fromEnv(valid - "ARCHIVE_KAFKA_PASSWORD")
    }
    assertFailsWith<IllegalStateException> {
      MarketDataArchiveConfig.fromEnv(valid - "ARCHIVE_CLICKHOUSE_PASSWORD")
    }
    assertFailsWith<IllegalArgumentException> {
      MarketDataArchiveConfig.fromEnv(valid + ("UNIVERSE_SYMBOL_HASH" to "0".repeat(64)))
    }
    assertFailsWith<IllegalArgumentException> {
      MarketDataArchiveConfig.fromEnv(valid + ("ARCHIVE_CORE_UNIVERSE_SYMBOL_HASH" to "0".repeat(64)))
    }
  }

  private fun record(
    topic: String,
    envelope: Envelope<AlpacaBarPayload>,
    partition: Int = 0,
    offset: Long = 1,
  ): ArchiveKafkaRecord =
    ArchiveKafkaRecord(
      topic = topic,
      partition = partition,
      offset = offset,
      value = Json.encodeToString(envelope),
    )

  private fun quoteRecord(
    topic: String,
    envelope: Envelope<QuotePayload>,
    partition: Int = 0,
    offset: Long = 1,
  ): ArchiveKafkaRecord = ArchiveKafkaRecord(topic, partition, offset, Json.encodeToString(envelope))

  private fun tradeRecord(
    topic: String,
    envelope: Envelope<TradePayload>,
    partition: Int = 0,
    offset: Long = 1,
  ): ArchiveKafkaRecord = ArchiveKafkaRecord(topic, partition, offset, Json.encodeToString(envelope))

  private fun envelope(
    feed: String,
    delayClass: String,
    session: String = "regular",
    high: Double = 101.0,
    symbol: String = "SPY",
  ): Envelope<AlpacaBarPayload> {
    val eventTime = Instant.parse("2026-07-21T14:00:00Z")
    return Envelope(
      ingestTs = eventTime.plusSeconds(1),
      eventTs = eventTime,
      feed = feed,
      channel = "bars",
      symbol = symbol,
      seq = 1,
      payload =
        AlpacaBarPayload(
          open = 100.0,
          high = high,
          low = 99.0,
          close = 100.5,
          volume = 1000.0,
          vwap = 100.2,
          tradeCount = 10,
          timestamp = eventTime.toString(),
        ),
      provider = "alpaca",
      marketSession = session,
      delayClass = delayClass,
      version = 2,
    )
  }

  private fun quoteEnvelope(
    feed: String,
    delayClass: String,
    channel: String = "quotes",
    symbol: String = "SPY",
    bidPrice: Double = 100.0,
    askPrice: Double = 100.1,
  ): Envelope<QuotePayload> {
    val eventTime = Instant.parse("2026-07-21T14:00:00Z")
    return Envelope(
      ingestTs = eventTime.plusSeconds(1),
      eventTs = eventTime,
      feed = feed,
      channel = channel,
      symbol = symbol,
      seq = 2,
      payload = QuotePayload(bp = bidPrice, bs = 20.0, ap = askPrice, `as` = 30.0, t = eventTime),
      provider = "alpaca",
      marketSession = "regular",
      delayClass = delayClass,
      version = 2,
    )
  }

  private fun tradeEnvelope(
    feed: String,
    delayClass: String,
    symbol: String = "SPY",
    size: Double = 10.0,
  ): Envelope<TradePayload> {
    val eventTime = Instant.parse("2026-07-21T14:00:00Z")
    return Envelope(
      ingestTs = eventTime.plusSeconds(1),
      eventTs = eventTime,
      feed = feed,
      channel = "trades",
      symbol = symbol,
      seq = 3,
      payload = TradePayload(p = 100.05, s = size, t = eventTime),
      provider = "alpaca",
      marketSession = "regular",
      delayClass = delayClass,
      version = 2,
    )
  }

  private fun symbolHash(symbols: Collection<String>): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest(symbols.sorted().joinToString(",").toByteArray(StandardCharsets.UTF_8))
      .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
}
