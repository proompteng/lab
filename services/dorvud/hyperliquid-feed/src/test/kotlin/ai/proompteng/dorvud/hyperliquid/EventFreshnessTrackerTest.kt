package ai.proompteng.dorvud.hyperliquid

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class EventFreshnessTrackerTest {
  @Test
  fun `requires every configured channel to be observed recently`() {
    var now = 1_000L
    val tracker =
      EventFreshnessTracker(
        requiredChannels = setOf("raw", "candle"),
        maxAgeMs = 500,
        nowMs = { now },
      )

    assertFalse(tracker.isFresh())
    assertNull(tracker.snapshot().lastSeenLagMs["raw"])

    tracker.record("raw")
    assertFalse(tracker.isFresh())
    assertEquals(0, tracker.snapshot().lastSeenLagMs["raw"])

    tracker.record("candle")
    assertTrue(tracker.isFresh())

    now = 1_400L
    assertTrue(tracker.isFresh())
    assertEquals(400, tracker.snapshot().lastSeenLagMs["candle"])

    now = 1_501L
    assertFalse(tracker.isFresh())
  }

  @Test
  fun `ignores channels that are not required for readiness`() {
    val tracker =
      EventFreshnessTracker(
        requiredChannels = setOf("raw"),
        maxAgeMs = 500,
        nowMs = { 2_000L },
      )

    tracker.record("trades")
    assertFalse(tracker.isFresh())

    tracker.record("raw")
    assertTrue(tracker.isFresh())
  }
}
