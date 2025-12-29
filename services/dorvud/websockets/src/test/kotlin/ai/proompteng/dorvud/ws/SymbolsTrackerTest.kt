package ai.proompteng.dorvud.ws

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SymbolsTrackerTest {
  @Test
  fun `returns initial symbols when no fetcher`() =
    runBlocking {
      val tracker = SymbolsTracker(listOf("AAPL", "MSFT"), fetcher = null)
      val result = tracker.refresh()
      assertEquals(listOf("AAPL", "MSFT"), result.symbols)
      assertTrue(result.hadError.not())
    }

  @Test
  fun `keeps last known symbols on fetch failure`() =
    runBlocking {
      val tracker =
        SymbolsTracker(
          listOf("AAPL"),
          fetcher = { throw IllegalStateException("boom") },
        )

      val result = tracker.refresh()
      assertEquals(listOf("AAPL"), result.symbols)
      assertTrue(result.hadError)
    }

  @Test
  fun `updates symbols on successful fetch`() =
    runBlocking {
      val tracker =
        SymbolsTracker(
          listOf("AAPL"),
          fetcher = { listOf("TSLA") },
        )

      val result = tracker.refresh()
      assertEquals(listOf("TSLA"), result.symbols)
      assertTrue(result.hadError.not())
    }
}
