package ai.proompteng.dorvud.ta

import ai.proompteng.dorvud.platform.Envelope
import ai.proompteng.dorvud.platform.Window
import ai.proompteng.dorvud.ta.stream.MicroBarAggregator
import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import ai.proompteng.dorvud.ta.stream.TradePayload
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals

class MicroBarAggregatorTest {
  @Test
  fun `flushAll with forceCurrent emits open bucket`() {
    val agg = MicroBarAggregator()
    val now = Instant.parse("2025-01-01T00:00:00Z")

    val tradeEnv =
      Envelope(
        ingestTs = now,
        eventTs = now,
        feed = "alpaca",
        channel = "trades",
        symbol = "TEST",
        seq = 1,
        payload = TradePayload(p = 100.0, s = 10.0, t = now),
        isFinal = true,
        source = "unit",
        window = Window(size = "PT1S", step = "PT1S", start = now.toString(), end = now.plusSeconds(1).toString()),
        version = 1,
      )

    // Build an in-flight bucket without crossing a second boundary
    agg.onTrade(tradeEnv)

    val flushed = agg.flushAll(forceCurrent = true, now = now)
    assertEquals(1, flushed.size)
    val bar = flushed.first().payload
    assertEquals(MicroBarPayload::class, bar::class)
    assertEquals(100.0, bar.o)
    assertEquals(10.0, bar.v)
  }
}
