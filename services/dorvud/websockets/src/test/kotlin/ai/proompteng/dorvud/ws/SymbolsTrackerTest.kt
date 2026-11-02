package ai.proompteng.dorvud.ws

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class SymbolsTrackerTest {
  @Test
  fun `cancellation propagates without changing the last known symbols`() =
    runBlocking {
      val tracker = SymbolsTracker(listOf("SPY")) { throw CancellationException("stopped") }
      assertFailsWith<CancellationException> { tracker.refresh() }
      assertEquals(listOf("SPY"), tracker.current())
    }

  @Test
  fun `serializes refreshes so an older response cannot replace a newer universe`() =
    runBlocking {
      val releaseFirst = CompletableDeferred<Unit>()
      var calls = 0
      val tracker =
        SymbolsTracker(listOf("SPY")) {
          calls += 1
          if (calls == 1) {
            releaseFirst.await()
            listOf("AMZN")
          } else {
            listOf("SMH")
          }
        }
      val first = async(start = CoroutineStart.UNDISPATCHED) { tracker.refresh() }
      val second = async(start = CoroutineStart.UNDISPATCHED) { tracker.refresh() }
      try {
        assertEquals(1, calls)
      } finally {
        releaseFirst.complete(Unit)
      }
      assertEquals(listOf("AMZN"), first.await().symbols)
      assertEquals(listOf("SMH"), second.await().symbols)
      assertEquals(listOf("SMH"), tracker.current())
    }

  @Test
  fun `returns initial symbols when no fetcher`() =
    runBlocking {
      val tracker = SymbolsTracker(listOf("AAPL", "MSFT"), fetcher = null)
      val result = tracker.refresh()
      assertEquals(listOf("AAPL", "MSFT"), result.symbols)
      assertTrue(result.hadError.not())
      assertEquals(null, result.failureReason)
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
      assertEquals("fetch_error", result.failureReason)
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
      assertEquals(null, result.failureReason)
    }

  @Test
  fun `keeps last known after success when polling later fails`() =
    runBlocking {
      var shouldFail = false
      val tracker =
        SymbolsTracker(
          listOf("AAPL"),
          fetcher = {
            if (shouldFail) throw IllegalStateException("boom")
            listOf("TSLA", "MSFT")
          },
        )

      val first = tracker.refresh()
      assertEquals(listOf("TSLA", "MSFT"), first.symbols)
      assertTrue(first.hadError.not())

      shouldFail = true
      val second = tracker.refresh()
      assertEquals(listOf("TSLA", "MSFT"), second.symbols)
      assertTrue(second.hadError)
      assertEquals("fetch_error", second.failureReason)
    }

  @Test
  fun `keeps last known when fetch returns empty list`() =
    runBlocking {
      val tracker =
        SymbolsTracker(
          listOf("BTC/USD", "ETH/USD", "SOL/USD"),
          fetcher = { emptyList() },
        )

      val result = tracker.refresh()
      assertEquals(listOf("BTC/USD", "ETH/USD", "SOL/USD"), result.symbols)
      assertTrue(result.hadError)
      assertEquals("empty_result", result.failureReason)
    }
}
