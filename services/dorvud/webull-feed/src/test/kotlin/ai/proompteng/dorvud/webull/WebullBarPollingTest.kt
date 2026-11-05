package ai.proompteng.dorvud.webull

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
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
            sweepStarted = { _, _ -> },
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
            sweepStarted = { _, _ -> },
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
  fun `priority bars repeat after one second while the catalog is blocked and cancel with their owner`() =
    runBlocking {
      val priority = listOf("AAPL", "SPY")
      val catalog = (priority + (1..2_000).map { "S$it" }).sorted()
      val requests = Channel<Pair<List<String>, Instant>>(Channel.UNLIMITED)
      val priorityTick = Channel<Unit>()
      val backgroundBlocked = CompletableDeferred<Unit>()
      val releaseBackground = CompletableDeferred<Unit>()
      val backgroundSymbols = CompletableDeferred<List<String>>()
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
            sweepStarted = { _, symbols -> backgroundSymbols.complete(symbols) },
            sweepCompleted = { error("The blocked catalog cannot complete") },
            pause = { millis ->
              assertEquals(1_000L, millis)
              priorityTick.receive()
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
        assertEquals(catalog.filter { it !in priority }, withTimeout(1_000) { backgroundSymbols.await() })
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

  @Test
  fun `catalog recovery gaps name background symbols without affecting independently polled priorities`() {
    val previous = Instant.parse("2026-11-05T13:00:00Z")
    val started = previous.plus(6, ChronoUnit.MINUTES)
    val background = listOf("AMD", "NVDA")
    val gap = requireNotNull(webullCatalogSweepGap(previous, started, "catalog", background))
    assertEquals(background, gap["symbols"]?.jsonArray?.map { it.jsonPrimitive.content })
    assertEquals("2026-11-05T13:00:00Z", gap["from"]?.jsonPrimitive?.content)
    assertEquals("2026-11-05T13:01:00Z", gap["to"]?.jsonPrimitive?.content)
    assertEquals("catalog_sweep", gap["scope"]?.jsonPrimitive?.content)
    assertNull(webullCatalogSweepGap(null, started, "catalog", background))
    assertNull(webullCatalogSweepGap(previous, previous.plus(5, ChronoUnit.MINUTES), "catalog", background))
    assertNull(webullCatalogSweepGap(previous, started, "catalog", emptyList()))
  }
}
