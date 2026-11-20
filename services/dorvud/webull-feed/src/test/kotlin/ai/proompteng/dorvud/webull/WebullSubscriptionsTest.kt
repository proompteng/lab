package ai.proompteng.dorvud.webull

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class WebullSubscriptionsTest {
  @Test
  fun `subscription admission finds the exact supported count without treating request batches as a global cap`() =
    runBlocking {
      val candidates = (1..1_000).map { "S$it" }
      for (limit in listOf(1, 37, 100, 503, 1_000)) {
        val remote = mutableSetOf<String>()
        val coverage =
          admitWebullSubscriptions(candidates) { batch ->
            assertTrue(batch.size <= 100)
            if (remote.size + batch.size > limit) throw WebullApiFailure(417, "TOO_MANY_SYMBOLS_SUBSCRIPTION", null)
            remote += batch
          }
        assertEquals(limit, remote.size)
        assertEquals(remote, coverage.accepted)
        assertEquals(if (limit < candidates.size) candidates[limit] else null, coverage.quotaWitness)
      }
    }

  @Test
  fun `one invalid instrument cannot exclude the rest of its batch`() =
    runBlocking {
      val coverage =
        admitWebullSubscriptions(listOf("AAPL", "INVALID", "SPY")) { symbols ->
          if ("INVALID" in symbols) throw WebullApiFailure(417, "INVALID_SYMBOL", null)
        }
      assertEquals(setOf("AAPL", "SPY"), coverage.accepted)
      assertEquals(setOf("INVALID"), coverage.invalid)
      assertEquals(null, coverage.quotaWitness)
      assertFailsWith<WebullApiFailure> {
        admitWebullSubscriptions(listOf("AAPL")) { throw WebullApiFailure(403, "UNAUTHORIZED", null) }
      }
    }
}
