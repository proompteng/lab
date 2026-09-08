package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.ta.stream.MicroBarPayload
import java.time.Duration
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals

class FlinkTechnicalAnalysisRollingVwapTest {
  @Test
  fun `minute rolling vwap excludes the bar ending at the cutoff`() {
    val firstStart = Instant.parse("2026-05-07T10:00:00Z")
    val closes = listOf(1000.0, 1.0, 1.0, 1.0, 1.0, 1.0)
    val bars =
      closes.mapIndexed { index, close ->
        microBar(
          start = firstStart.plusSeconds(index * 60L),
          close = close,
        )
      }

    assertEquals(
      1.0,
      rollingSignalVwap(
        bars = bars,
        window = Duration.ofMinutes(5),
        barDuration = Duration.ofMinutes(1),
        timestampAnchor = SignalBarTimestampAnchor.START,
      ),
    )
  }

  private fun microBar(
    start: Instant,
    close: Double,
  ): MicroBarPayload =
    MicroBarPayload(
      o = close,
      h = close,
      l = close,
      c = close,
      v = 1.0,
      vwap = close,
      count = 1,
      t = start,
    )
}
