package ai.proompteng.dorvud.hyperliquid

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class MarketDataStallGuardTest {
  @Test
  fun `ignores stale market data during startup grace then requests reconnect`() {
    val guard = MarketDataStallGuard(connectedAtMs = 1_000, startupGraceMs = 180_000, checkIntervalMs = 30_000)
    var freshnessChecks = 0
    val staleSnapshot = EventFreshnessSnapshot(fresh = false, lastSeenLagMs = mapOf("bbo" to null, "candle" to null))

    assertNull(
      guard.staleSnapshotIfDue(observedAtMs = 180_999) {
        freshnessChecks += 1
        staleSnapshot
      },
    )
    assertEquals(0, freshnessChecks)
    assertEquals(
      staleSnapshot,
      guard.staleSnapshotIfDue(observedAtMs = 181_000) {
        freshnessChecks += 1
        staleSnapshot
      },
    )
    assertEquals(1, freshnessChecks)
  }

  @Test
  fun `rechecks healthy market data at the configured cadence`() {
    val guard = MarketDataStallGuard(connectedAtMs = 0, startupGraceMs = 100, checkIntervalMs = 25)
    val freshSnapshot = EventFreshnessSnapshot(fresh = true, lastSeenLagMs = mapOf("bbo" to 0))
    val staleSnapshot = EventFreshnessSnapshot(fresh = false, lastSeenLagMs = mapOf("bbo" to 126))

    assertNull(guard.staleSnapshotIfDue(observedAtMs = 100) { freshSnapshot })
    assertNull(guard.staleSnapshotIfDue(observedAtMs = 124) { staleSnapshot })
    assertEquals(staleSnapshot, guard.staleSnapshotIfDue(observedAtMs = 125) { staleSnapshot })
  }
}
