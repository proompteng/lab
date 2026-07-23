package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.AlpacaBarPayload
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
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
      "torghut.bars.1m.v1" to ArchiveRoute("iex", coreUniverse),
      "bayn.market-data.delayed-sip.bars.1m.v1" to ArchiveRoute("delayed_sip", observationUniverse),
      "bayn.market-data.overnight.bars.1m.v1" to ArchiveRoute("overnight", observationUniverse),
    )

  @Test
  fun `decodes enriched bars with source-offset lineage and cross-feed separation`() {
    val iex =
      decodeArchiveBar(
        record("torghut.bars.1m.v1", envelope("iex", "real_time_exchange_only", symbol = "NVDA")),
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

    assertEquals("iex", iex.feed)
    assertEquals("torghut-core-equity-v1", iex.universeId)
    assertEquals(coreUniverse.symbolHash, iex.universeSymbolHash)
    assertEquals("bars", iex.channel)
    assertEquals("delayed_sip", delayed.feed)
    assertEquals("cross-asset-taa-v1", delayed.universeId)
    assertEquals(observationUniverse.symbolHash, delayed.universeSymbolHash)
    assertEquals(2, delayed.sourcePartition)
    assertEquals(42, delayed.sourceOffset)
    assertEquals("overnight", overnight.feed)
    assertEquals("overnight", overnight.marketSession)
    assertEquals(3, setOf(iex.feed, delayed.feed, overnight.feed).size)
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
        record("torghut.bars.1m.v1", envelope("iex", "real_time_exchange_only", high = 99.0, symbol = "NVDA")),
        routes,
      )
    }
  }

  @Test
  fun `rejects bars outside the configured universe and invalid Kafka lineage`() {
    assertFailsWith<IllegalArgumentException> {
      decodeArchiveBar(
        record("torghut.bars.1m.v1", envelope("iex", "real_time_exchange_only", symbol = "SPY")),
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
          envelope("iex", "real_time_exchange_only", symbol = "NVDA"),
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
  fun `archive configuration rejects duplicate topics and unbounded values`() {
    val valid =
      mapOf(
        "ARCHIVE_IEX_BARS_TOPIC" to "torghut.bars.1m.v1",
        "ARCHIVE_DELAYED_SIP_BARS_TOPIC" to "bayn.market-data.delayed-sip.bars.1m.v1",
        "ARCHIVE_OVERNIGHT_BARS_TOPIC" to "bayn.market-data.overnight.bars.1m.v1",
        "ARCHIVE_CLICKHOUSE_URL" to "jdbc:clickhouse://clickhouse:8123/signal",
        "ARCHIVE_CLICKHOUSE_PASSWORD" to "clickhouse-password",
        "ARCHIVE_KAFKA_PASSWORD" to "password",
        "ARCHIVE_CORE_UNIVERSE_ID" to coreUniverse.id,
        "ARCHIVE_CORE_UNIVERSE_SYMBOLS" to coreUniverse.symbols.sorted().joinToString(","),
        "ARCHIVE_CORE_UNIVERSE_SYMBOL_HASH" to coreUniverse.symbolHash,
        "UNIVERSE_ID" to observationUniverse.id,
        "UNIVERSE_SYMBOLS" to observationUniverse.symbols.sorted().joinToString(","),
        "UNIVERSE_SYMBOL_HASH" to observationUniverse.symbolHash,
      )
    val config = MarketDataArchiveConfig.fromEnv(valid)
    assertEquals(3, config.routes.size)
    assertEquals(coreUniverse, config.routes.getValue("torghut.bars.1m.v1").universe)
    assertEquals(
      observationUniverse,
      config.routes.getValue("bayn.market-data.delayed-sip.bars.1m.v1").universe,
    )
    assertEquals(100, config.clickhouseBatchSize)
    assertEquals("signal_publisher", config.clickhouseUsername)

    assertFailsWith<IllegalStateException> {
      MarketDataArchiveConfig.fromEnv(
        valid + ("ARCHIVE_OVERNIGHT_BARS_TOPIC" to "torghut.bars.1m.v1"),
      )
    }
    assertFailsWith<IllegalArgumentException> {
      MarketDataArchiveConfig.fromEnv(valid + ("ARCHIVE_CLICKHOUSE_BATCH_SIZE" to "1001"))
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

  private fun symbolHash(symbols: Collection<String>): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest(symbols.sorted().joinToString(",").toByteArray(StandardCharsets.UTF_8))
      .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
}
