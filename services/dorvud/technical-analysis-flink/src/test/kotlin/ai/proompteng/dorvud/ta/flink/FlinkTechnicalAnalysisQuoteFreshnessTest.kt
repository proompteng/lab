package ai.proompteng.dorvud.ta.flink

import ai.proompteng.dorvud.ta.stream.QuotePayload
import java.time.Duration
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FlinkTechnicalAnalysisQuoteFreshnessTest {
  @Test
  fun `minute bar freshness uses the interval end`() {
    val barStart = Instant.parse("2026-05-07T16:13:00Z")
    val quoteTs = barStart.plusSeconds(59)
    val quote = quotePayload(quoteTs)
    val state = TimedQuoteState(eventTs = quoteTs, payload = quote)
    val barEnd = signalBarEndTime(barStart, Duration.ofMinutes(1), SignalBarTimestampAnchor.START)

    assertEquals(
      quote,
      freshQuotePayloadForBar(
        state,
        barTs = barEnd,
        quoteStaleAfterMs = 2_000,
      ),
    )
  }

  @Test
  fun `fresh quote can be attached to a later microbar`() {
    val quoteTs = Instant.parse("2026-05-07T16:13:10Z")
    val quote = quotePayload(quoteTs)
    val state = TimedQuoteState(eventTs = quoteTs, payload = quote)

    assertEquals(
      quote,
      freshQuotePayloadForBar(
        state,
        barTs = quoteTs.plusMillis(1_500),
        quoteStaleAfterMs = 2_000,
      ),
    )
  }

  @Test
  fun `stale quote is not attached to a later microbar`() {
    val quoteTs = Instant.parse("2026-05-07T16:13:10Z")
    val state = TimedQuoteState(eventTs = quoteTs, payload = quotePayload(quoteTs))

    assertNull(
      freshQuotePayloadForBar(
        state,
        barTs = quoteTs.plusMillis(2_001),
        quoteStaleAfterMs = 2_000,
      ),
    )
  }

  @Test
  fun `future quote is not attached to an earlier microbar`() {
    val barTs = Instant.parse("2026-05-07T16:13:10Z")
    val quoteTs = barTs.plusMillis(1)
    val state = TimedQuoteState(eventTs = quoteTs, payload = quotePayload(quoteTs))

    assertNull(freshQuotePayloadForBar(state, barTs = barTs, quoteStaleAfterMs = 2_000))
    assertFalse(isQuoteFreshForBar(quoteTs = quoteTs, barTs = barTs, quoteStaleAfterMs = 0))
  }

  @Test
  fun `nonpositive stale window disables age limit but still blocks lookahead`() {
    val quoteTs = Instant.parse("2026-05-07T16:13:10Z")

    assertTrue(
      isQuoteFreshForBar(
        quoteTs = quoteTs,
        barTs = quoteTs.plusSeconds(60),
        quoteStaleAfterMs = 0,
      ),
    )
    assertFalse(
      isQuoteFreshForBar(
        quoteTs = quoteTs.plusMillis(1),
        barTs = quoteTs,
        quoteStaleAfterMs = 0,
      ),
    )
  }

  private fun quotePayload(ts: Instant): QuotePayload =
    QuotePayload(
      bp = 100.00,
      bs = 10.0,
      ap = 100.02,
      `as` = 12.0,
      t = ts,
    )
}
