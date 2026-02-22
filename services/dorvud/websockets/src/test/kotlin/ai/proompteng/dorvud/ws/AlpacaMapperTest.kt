package ai.proompteng.dorvud.ws

import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.fail

class AlpacaMapperTest {
  @Test
  fun `maps trade to envelope`() {
    val msg =
      """{"T":"t","S":"AAPL","i":123,"p":190.5,"s":10,"t":"2025-12-05T00:00:00Z"}"""
    val decoded = AlpacaMapper.decode(msg)
    val env = AlpacaMapper.toEnvelope(decoded) { 1 }
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

    val env = AlpacaMapper.toEnvelope(decoded) { 1 }
    assertNotNull(env)
    assertEquals("quotes", env.channel)
    assertEquals("BTC/USD", env.symbol)
  }
}
