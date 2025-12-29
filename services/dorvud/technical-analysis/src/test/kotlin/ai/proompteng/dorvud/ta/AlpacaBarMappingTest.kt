package ai.proompteng.dorvud.ta

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.ta.stream.AlpacaBarPayload
import ai.proompteng.dorvud.ta.stream.toMicroBarPayload
import kotlinx.serialization.json.Json
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals

class AlpacaBarMappingTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun `alpaca bar payload maps into microbar`() {
    val raw =
      """
      {
        "ingestTs": "2025-01-01T00:00:01Z",
        "eventTs": "2025-01-01T00:00:00Z",
        "feed": "alpaca",
        "channel": "bars",
        "symbol": "AAPL",
        "seq": 42,
        "payload": {
          "T": "b",
          "S": "AAPL",
          "o": 10.0,
          "h": 12.0,
          "l": 9.0,
          "c": 11.5,
          "v": 500,
          "vw": 10.8,
          "n": 12,
          "t": "2025-01-01T00:00:00Z"
        },
        "isFinal": true,
        "source": "ws",
        "version": 1
      }
      """.trimIndent()

    val env = json.decodeFromString(Envelope.serializer(AlpacaBarPayload.serializer()), raw)
    val micro = env.payload.toMicroBarPayload()

    assertEquals(10.0, micro.o)
    assertEquals(12.0, micro.h)
    assertEquals(9.0, micro.l)
    assertEquals(11.5, micro.c)
    assertEquals(500.0, micro.v)
    assertEquals(10.8, micro.vwap)
    assertEquals(12L, micro.count)
    assertEquals(Instant.parse("2025-01-01T00:00:00Z"), micro.t)
  }
}
