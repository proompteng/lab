package ai.proompteng.dorvud.ws

import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

class AlpacaMapperTest {
  @Test
  fun `preserves feed session delay semantics and feed-channel sequence scope`() {
    val sequenceKeys = mutableListOf<String>()
    val delayedQuote =
      AlpacaMapper.toEnvelope(
        message =
          AlpacaQuote(
            symbol = "NVDA",
            bidPrice = 170.0,
            bidSize = 10.0,
            askPrice = 170.1,
            askSize = 12.0,
            timestamp = "2026-07-21T12:00:00Z",
          ),
        marketType = AlpacaMarketType.EQUITY,
        feed = EquityFeed.DelayedSip.id,
        equityFeed = EquityFeed.DelayedSip,
        seqProvider = { key ->
          sequenceKeys += key
          7
        },
      )
    val overnightTrade =
      AlpacaMapper.toEnvelope(
        message =
          AlpacaTrade(
            symbol = "NVDA",
            price = 170.05,
            size = 3.0,
            timestamp = "2026-07-22T01:00:00Z",
          ),
        marketType = AlpacaMarketType.EQUITY,
        feed = EquityFeed.Overnight.id,
        equityFeed = EquityFeed.Overnight,
        seqProvider = { key ->
          sequenceKeys += key
          8
        },
      )

    assertNotNull(delayedQuote)
    assertEquals("alpaca", delayedQuote.provider)
    assertEquals("pre", delayedQuote.marketSession)
    assertEquals("delayed_15m_consolidated", delayedQuote.delayClass)
    assertEquals(2, delayedQuote.version)
    assertNotNull(overnightTrade)
    assertEquals("overnight", overnightTrade.marketSession)
    assertEquals("delayed_15m_adjusted", overnightTrade.delayClass)
    assertEquals(listOf("quotes:NVDA", "trades:NVDA"), sequenceKeys)
  }

  @Test
  fun `maps trade to envelope`() {
    val msg =
      """{"T":"t","S":"AAPL","i":123,"p":190.5,"s":10,"t":"2025-12-05T00:00:00Z"}"""
    val decoded = AlpacaMapper.decode(msg)
    val env = AlpacaMapper.toEnvelope(decoded, AlpacaMarketType.EQUITY, "iex") { 1 }
    assertNotNull(env)
    assertEquals("AAPL", env.symbol)
    assertEquals("trades", env.channel)
    assertEquals(true, env.isFinal)
    val payloadSymbol =
      env.payload.jsonObject["S"]
        ?.toString()
        ?.trim('"')
    assertEquals("AAPL", payloadSymbol)
  }

  @Test
  fun `maps crypto trade with fractional size`() {
    val msg =
      """{"T":"t","S":"BTC/USD","i":1,"p":67980.61,"s":0.001439,"t":"2026-02-22T01:18:58.706453323Z"}"""
    val decoded = AlpacaMapper.decode(msg)
    assertTrue(decoded is AlpacaTrade)
    assertEquals(0.001439, decoded.size)

    val env = AlpacaMapper.toEnvelope(decoded, AlpacaMarketType.CRYPTO, "us") { 1 }
    assertNotNull(env)
    assertEquals("trades", env.channel)
    assertEquals("BTC/USD", env.symbol)
  }

  @Test
  fun `decoding unknown message types does not crash`() {
    val msg = """{"T":"n","foo":"bar"}"""
    try {
      AlpacaMapper.decode(msg)
    } catch (e: Exception) {
      fail("expected decode to succeed, got ${e::class.simpleName}: ${e.message}")
    }
  }

  @Test
  fun `decoding messages without T does not crash`() {
    val msg = """{"foo":"bar"}"""
    try {
      AlpacaMapper.decode(msg)
    } catch (e: Exception) {
      fail("expected decode to succeed, got ${e::class.simpleName}: ${e.message}")
    }
  }

  @Test
  fun `maps crypto quote with fractional sizes`() {
    val msg =
      """{"T":"q","S":"BTC/USD","bp":67980.619,"bs":1.2699,"ap":68030.6,"as":1.28642,"t":"2026-02-22T01:09:00.656453323Z"}"""
    val decoded = AlpacaMapper.decode(msg)
    assertTrue(decoded is AlpacaQuote)
    assertEquals(1.2699, decoded.bidSize)
    assertEquals(1.28642, decoded.askSize)

    val env = AlpacaMapper.toEnvelope(decoded, AlpacaMarketType.CRYPTO, "us") { 1 }
    assertNotNull(env)
    assertEquals("quotes", env.channel)
    assertEquals("BTC/USD", env.symbol)
  }

  @Test
  fun `maps crypto bar with fractional volume`() {
    val msg =
      """{"T":"b","S":"BTC/USD","o":67950.0,"h":68000.0,"l":67900.0,"c":67980.0,"v":0.03584,"vw":67970.0,"n":3,"t":"2026-02-22T01:20:00Z"}"""
    val decoded = AlpacaMapper.decode(msg)
    assertTrue(decoded is AlpacaBar)
    assertEquals(0.03584, decoded.volume)

    val env = AlpacaMapper.toEnvelope(decoded, AlpacaMarketType.CRYPTO, "us") { 1 }
    assertNotNull(env)
    assertEquals("bars", env.channel)
    assertEquals("BTC/USD", env.symbol)
  }

  @Test
  fun `maps options quote to normalized payload`() {
    val msg =
      """{"T":"q","S":"AAPL260320C00100000","bp":2.1,"bs":10,"ap":2.2,"as":8,"bx":"A","ax":"B","c":"R","t":"2026-03-08T18:00:01Z"}"""
    val decoded = AlpacaMapper.decode(msg)
    assertTrue(decoded is AlpacaQuote)
    assertEquals(listOf("R"), decoded.conditions)
    val env = AlpacaMapper.toEnvelope(decoded, AlpacaMarketType.OPTIONS, "opra") { 1 }
    assertNotNull(env)
    assertEquals("quote", env.channel)
    assertEquals("opra", env.feed)
    assertEquals("AAPL260320C00100000", env.symbol)
    val payload = env.payload.jsonObject
    assertEquals("AAPL", payload["underlying_symbol"]?.toString()?.trim('"'))
    assertEquals("2.1", payload["bid_price"]?.toString())
    assertEquals("2.2", payload["ask_price"]?.toString())
    assertEquals("R", payload["quote_condition"]?.toString()?.trim('"'))
  }

  @Test
  fun `maps options trade with scalar condition to normalized payload`() {
    val msg =
      """{"T":"t","S":"AAPL240315C00172500","t":"2024-03-11T13:35:35.133122560Z","p":2.84,"s":1,"x":"N","c":"S"}"""
    val decoded = AlpacaMapper.decode(msg)
    assertTrue(decoded is AlpacaTrade)
    assertEquals(listOf("S"), decoded.conditions)

    val env = AlpacaMapper.toEnvelope(decoded, AlpacaMarketType.OPTIONS, "indicative") { 1 }
    assertNotNull(env)
    assertEquals("trade", env.channel)
    assertEquals("AAPL240315C00172500", env.symbol)
    val payload = env.payload.jsonObject
    assertEquals("AAPL", payload["underlying_symbol"]?.toString()?.trim('"'))
    assertEquals("2.84", payload["price"]?.toString())
    assertEquals("1.0", payload["size"]?.toString())
  }

  @Test
  fun `maps options timestamps without explicit zone as UTC`() {
    val msg =
      """{"T":"q","S":"NVDA260717C00160000","bp":1.1,"bs":12,"ap":1.2,"as":10,"t":"2026-07-08T14:52:03.192533568"}"""
    val decoded = AlpacaMapper.decode(msg)

    val env = AlpacaMapper.toEnvelope(decoded, AlpacaMarketType.OPTIONS, "indicative") { 1 }

    assertNotNull(env)
    assertEquals("2026-07-08T14:52:03.192533568Z", env.eventTs.toString())
  }

  @Test
  fun `maps numeric epoch nanosecond timestamps`() {
    val msg =
      """{"T":"t","S":"NVDA260717C00160000","p":1.15,"s":1,"x":"N","t":"1783522323192533568"}"""
    val decoded = AlpacaMapper.decode(msg)

    val env = AlpacaMapper.toEnvelope(decoded, AlpacaMarketType.OPTIONS, "indicative") { 1 }

    assertNotNull(env)
    assertEquals("2026-07-08T14:52:03.192533568Z", env.eventTs.toString())
  }

  @Test
  fun `maps decimal epoch second timestamps`() {
    val msg =
      """{"T":"q","S":"NVDA260717C00160000","bp":1.1,"bs":12,"ap":1.2,"as":10,"t":"1783522323.192533568"}"""
    val decoded = AlpacaMapper.decode(msg)

    val env = AlpacaMapper.toEnvelope(decoded, AlpacaMarketType.OPTIONS, "indicative") { 1 }

    assertNotNull(env)
    assertEquals("2026-07-08T14:52:03.192533568Z", env.eventTs.toString())
  }

  @Test
  fun `out of range decimal epoch timestamps return null instead of throwing`() {
    assertNull(parseAlpacaEventInstant("999999999999999999999999999999999999999.1"))
  }

  @Test
  fun `maps timestamps with space separator and compact offset`() {
    val msg =
      """{"T":"q","S":"NVDA260717C00160000","bp":1.1,"bs":12,"ap":1.2,"as":10,"t":"2026-07-08 10:52:03.192533568-0400"}"""
    val decoded = AlpacaMapper.decode(msg)

    val env = AlpacaMapper.toEnvelope(decoded, AlpacaMarketType.OPTIONS, "indicative") { 1 }

    assertNotNull(env)
    assertEquals("2026-07-08T14:52:03.192533568Z", env.eventTs.toString())
  }

  @Test
  fun `drops malformed options status frame instead of throwing`() {
    val msg =
      """{"T":"s","S":"AAPL260618C00100000","statusCode":"error","statusMessage":"bad symbol","t":"[ERROR: (java.lang.IllegalStateException) 'gen' is expected to be a string]"}"""
    val decoded = AlpacaMapper.decode(msg)
    assertTrue(decoded is AlpacaStatus)

    val env = AlpacaMapper.toEnvelope(decoded, AlpacaMarketType.OPTIONS, "opra") { 1 }

    assertNull(env)
  }
}
