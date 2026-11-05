package ai.proompteng.dorvud.webull

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class WebullBarPollingTest {
  @Test
  fun `priority polling excludes unlisted and repeated symbols and keeps provider batch bounds`() =
    runBlocking {
      val catalog = (1..45).map { "S$it" }
      val captured = mutableListOf<List<String>>()
      val completed = CompletableDeferred<Unit>()
      val polling =
        launch {
          pollWebullBars(
            catalog,
            catalog + "UNLISTED" + catalog.first(),
            collect = { batch, _ -> captured += batch },
            sweepStarted = {},
            sweepCompleted = { completed.complete(Unit) },
            pause = { awaitCancellation() },
          )
        }
      try {
        withTimeout(1_000) { completed.await() }
        assertEquals(listOf(20, 20, 5), captured.map { it.size })
        assertEquals(catalog, captured.flatten())
      } finally {
        polling.cancelAndJoin()
      }
    }

  @Test
  fun `an empty priority set still polls the complete catalog without empty requests`() =
    runBlocking {
      val catalog = (1..41).map { "S$it" }
      val captured = mutableListOf<List<String>>()
      val completed = CompletableDeferred<Unit>()
      val polling =
        launch {
          pollWebullBars(
            catalog,
            emptyList(),
            collect = { batch, _ -> captured += batch },
            sweepStarted = {},
            sweepCompleted = { completed.complete(Unit) },
            pause = { awaitCancellation() },
          )
        }
      try {
        withTimeout(1_000) { completed.await() }
        assertEquals(listOf(20, 20, 1), captured.map { it.size })
        assertEquals(catalog, captured.flatten())
      } finally {
        polling.cancelAndJoin()
      }
    }

  @Test
  fun `priority bars repeat while the full catalog sweep is still blocked and cancel with their owner`() =
    runBlocking {
      val priority = listOf("AAPL", "SPY")
      val catalog = (priority + (1..2_000).map { "S$it" }).sorted()
      val requests = Channel<Pair<List<String>, Instant>>(Channel.UNLIMITED)
      val priorityTick = Channel<Unit>()
      val backgroundBlocked = CompletableDeferred<Unit>()
      val releaseBackground = CompletableDeferred<Unit>()
      val polling =
        launch {
          pollWebullBars(
            catalog,
            priority,
            collect = { batch, cutoff ->
              requests.send(batch to cutoff)
              if (batch != priority) {
                backgroundBlocked.complete(Unit)
                releaseBackground.await()
              }
            },
            sweepStarted = {},
            sweepCompleted = { error("The blocked catalog cannot complete") },
            pause = { millis ->
              if (millis == 5_000L) priorityTick.receive() else awaitCancellation()
            },
          )
        }
      try {
        val first = withTimeout(1_000) { requests.receive() }
        assertEquals(priority, first.first)
        assertEquals(first.second.truncatedTo(ChronoUnit.MINUTES), first.second)
        withTimeout(1_000) { backgroundBlocked.await() }
        val background = withTimeout(1_000) { requests.receive() }
        assertTrue(background.first.none { it in priority })
        priorityTick.send(Unit)
        val repeated = withTimeout(1_000) { requests.receive() }
        assertEquals(priority, repeated.first)
        assertFalse(releaseBackground.isCompleted)
      } finally {
        polling.cancelAndJoin()
        requests.close()
        priorityTick.close()
      }
      assertTrue(polling.children.none())
    }
}
