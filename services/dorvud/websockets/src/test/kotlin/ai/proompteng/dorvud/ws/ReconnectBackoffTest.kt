package ai.proompteng.dorvud.ws

import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ReconnectBackoffTest {
  @Test
  fun `backoff doubles and caps when jitter disabled`() {
    val backoff = ReconnectBackoff(baseMs = 500, maxMs = 2_000, jitterRatio = 0.0, random = Random(0))

    assertEquals(500, backoff.nextDelay(1))
    assertEquals(1_000, backoff.nextDelay(2))
    assertEquals(2_000, backoff.nextDelay(3))
    assertEquals(2_000, backoff.nextDelay(4))
  }

  @Test
  fun `backoff applies jitter within bounds`() {
    val backoff = ReconnectBackoff(baseMs = 1_000, maxMs = 5_000, jitterRatio = 0.2, random = Random(42))
    val delay = backoff.nextDelay(1)

    assertTrue(delay in 800..1_200)
  }

  @Test
  fun `attempt zero returns base delay`() {
    val backoff = ReconnectBackoff(baseMs = 750, maxMs = 5_000, jitterRatio = 0.0, random = Random(7))

    assertEquals(750, backoff.nextDelay(0))
  }
}
