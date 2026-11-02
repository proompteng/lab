package ai.proompteng.dorvud.ta

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.AlpacaBarPayload
import ai.proompteng.dorvud.ta.stream.QuotePayload
import ai.proompteng.dorvud.ta.stream.TradePayload
import ai.proompteng.dorvud.ta.stream.toMicroBarPayload
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class CryptoPayloadDecodingTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun `quote envelope supports fractional bid ask sizes`() {
    val raw =
      """
      {
        "ingestTs": "2026-02-22T02:49:58.670661508Z",
        "eventTs": "2026-02-22T02:49:58.632327448Z",
        "feed": "alpaca",
        "channel": "quotes",
        "symbol": "BTC/USD",
        "seq": 3020,
        "payload": {
          "bp": 67913.82,
          "bs": 2.5755,
          "ap": 68016.84,
          "as": 1.27105,
          "t": "2026-02-22T02:49:58.632327448Z"
        },
        "isFinal": true,
        "source": "ws",
        "version": 1
      }
      """.trimIndent()

    val env = json.decodeFromString(Envelope.serializer(QuotePayload.serializer()), raw)

    assertEquals(2.5755, env.payload.bs)
    assertEquals(1.27105, env.payload.`as`)
  }

  @Test
  fun `trade envelope supports fractional size`() {
    val raw =
      """
      {
        "ingestTs": "2026-02-22T02:49:58.670661508Z",
        "eventTs": "2026-02-22T02:49:58.632327448Z",
        "feed": "alpaca",
        "channel": "trades",
        "symbol": "ETH/USD",
        "seq": 1001,
        "payload": {
          "p": 1973.43,
          "s": 0.125,
          "t": "2026-02-22T02:49:58.632327448Z"
        },
        "isFinal": true,
        "source": "ws",
        "version": 1
      }
      """.trimIndent()

    val env = json.decodeFromString(Envelope.serializer(TradePayload.serializer()), raw)

    assertEquals(0.125, env.payload.s)
  }

  @Test
  fun `alpaca bar mapping keeps fractional volume and defaults missing optional fields`() {
    val raw =
      """
      {
        "ingestTs": "2026-02-22T02:51:00.038668553Z",
        "eventTs": "2026-02-22T02:50:00Z",
        "feed": "alpaca",
        "channel": "bars",
        "symbol": "ETH/USD",
        "seq": 288,
        "payload": {
          "S": "ETH/USD",
          "o": 1974.2,
          "h": 1974.2,
          "l": 1973.18,
          "c": 1973.43,
          "v": 0.002482,
          "t": "2026-02-22T02:50:00Z"
        },
        "isFinal": true,
        "source": "ws",
        "version": 1
      }
      """.trimIndent()

    val env = json.decodeFromString(Envelope.serializer(AlpacaBarPayload.serializer()), raw)
    val micro = env.payload.toMicroBarPayload()

    assertEquals(0.002482, micro.v)
    assertNull(micro.vwap)
    assertEquals(0L, micro.count)
  }
}
