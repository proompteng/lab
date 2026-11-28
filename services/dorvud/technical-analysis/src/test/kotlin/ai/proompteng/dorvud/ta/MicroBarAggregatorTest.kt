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
  fun `latest REST samples do not create or advance volume buckets`() {
    val agg = MicroBarAggregator()
    val now = Instant.parse("2026-09-11T14:00:00Z")
    val sample =
      Envelope(
        ingestTs = now,
        eventTs = now,
        feed = "iex",
        channel = "trades",
        symbol = "AMD",
        seq = 1,
        payload = TradePayload(p = 100.0, s = 100.0, t = now),
        source = "rest_latest",
      )
    assertEquals(emptyList(), agg.onTrade(sample))
    assertEquals(emptyList(), agg.flushAll(forceCurrent = true))
    agg.onTrade(sample.copy(source = "ws", payload = sample.payload.copy(s = 2.0)))
    assertEquals(emptyList(), agg.onTrade(sample.copy(eventTs = now.plusSeconds(1), payload = sample.payload.copy(t = now.plusSeconds(1)))))
    val bar = agg.flushAll(forceCurrent = true).single().payload
    assertEquals(2.0, bar.v)
    assertEquals(1, bar.count)
  }

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
