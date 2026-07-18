package ai.proompteng.dorvud.ws

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class ForwarderBarDedupTest {
  @Test
  fun `updated bar correction does not collide with regular bar`() {
    val regular =
      AlpacaBar(
        symbol = "AAPL",
        open = 100.0,
        high = 101.0,
        low = 99.0,
        close = 100.5,
        volume = 10.0,
        timestamp = "2026-07-18T20:00:00Z",
      )
    val updated =
      AlpacaUpdatedBar(
        symbol = "AAPL",
        open = 100.0,
        high = 101.5,
        low = 99.0,
        close = 101.0,
        volume = 12.0,
        timestamp = "2026-07-18T20:00:00Z",
      )

    assertEquals("bars:2026-07-18T20:00:00Z-AAPL", barDedupKey(regular))
    assertEquals("updatedBars:2026-07-18T20:00:00Z-AAPL", barDedupKey(updated))
    assertNotEquals(barDedupKey(regular), barDedupKey(updated))
  }

  @Test
  fun `duplicate updates retain the same dedup key`() {
    val first =
      AlpacaUpdatedBar(
        symbol = "AAPL",
        open = 100.0,
        high = 101.5,
        low = 99.0,
        close = 101.0,
        volume = 12.0,
        timestamp = "2026-07-18T20:00:00Z",
      )
    val duplicate = first.copy(close = 101.25)

    assertEquals(barDedupKey(first), barDedupKey(duplicate))
  }
}
