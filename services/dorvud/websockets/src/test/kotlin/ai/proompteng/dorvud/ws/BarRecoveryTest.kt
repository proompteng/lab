package ai.proompteng.dorvud.ws

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import java.time.Duration
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse

class BarRecoveryTest {
  private val now = Instant.parse("2026-09-18T20:01:30Z")
  private val closing = bar("2026-09-18T19:59:00Z")

  private fun bar(
    timestamp: String,
    symbol: String = "SPY",
  ) = AlpacaBar(
    symbol = symbol,
    timestamp = timestamp,
    open = 100.0,
    high = 101.0,
    low = 99.0,
    close = 100.5,
    volume = 10.0,
  )

  @Test
  fun `skips acknowledged websocket bars and never fills absent or unfinished minutes`() =
    runBlocking {
      val recovery = BarRecovery(Duration.ofHours(120))
      recovery.recordDelivered("SPY", Instant.parse(closing.timestamp))
      val result =
        recovery.reconcile(now, setOf("SPY"), { listOf(closing, bar("2026-09-18T20:01:00Z")) }) {
          error("acknowledged or incomplete bar was republished")
        }
      assertEquals(1, result.observed)
      assertEquals(0, result.published)
      val empty = recovery.reconcile(now.plusSeconds(60), setOf("SPY"), { emptyList() }) { error("invented bar") }
      assertEquals(0, empty.observed)
      assertEquals(Instant.parse("2026-09-18T19:56:00Z"), empty.window.start)
    }

  @Test
  fun `rescans the complete lookback hourly and after a symbol change`() =
    runBlocking {
      val recovery = BarRecovery(Duration.ofHours(120))
      recovery.reconcile(now, setOf("SPY"), { emptyList() }) { error("invented bar") }
      val later = now.plusSeconds(3600)
      val hourly = recovery.reconcile(later, setOf("SPY"), { listOf(closing) }) {}
      assertEquals(Instant.parse("2026-09-13T21:01:00Z"), hourly.window.start)
      assertEquals(1, hourly.published)
      val newSymbol = recovery.reconcile(later.plusSeconds(60), setOf("SPY", "AMZN"), { listOf(closing, closing.copy(symbol = "AMZN")) }) {}
      assertEquals(Instant.parse("2026-09-13T21:02:00Z"), newSymbol.window.start)
      assertEquals(1, newSymbol.published)
    }

  @Test
  fun `keeps failed publications retryable and preserves successful acknowledgements`() =
    runBlocking {
      val recovery = BarRecovery(Duration.ofHours(12))
      val first = CompletableDeferred<Unit>()
      val failedBar = closing.copy(symbol = "AMZN")
      assertFailsWith<IllegalStateException> {
        recovery.reconcile(now, setOf("SPY", "AMZN"), { listOf(closing, failedBar) }) { bar ->
          if (bar.symbol == "SPY") {
            recovery.recordDelivered(bar.symbol, Instant.parse(bar.timestamp))
            first.complete(Unit)
          } else {
            first.await()
            error("broker acknowledgement failed")
          }
        }
      }
      val sent = mutableListOf<String>()
      val retry = recovery.reconcile(now.plusSeconds(60), setOf("SPY", "AMZN"), { listOf(closing, failedBar) }) { sent += it.symbol }
      assertEquals(listOf("AMZN"), sent)
      assertEquals(1, retry.published)
      assertEquals(Instant.parse("2026-09-18T08:02:00Z"), retry.window.start)
    }

  @Test
  fun `does not advance the completed scan when fetch or cancellation fails`() =
    runBlocking {
      val recovery = BarRecovery(Duration.ofHours(12))
      recovery.reconcile(now, setOf("SPY"), { emptyList() }) {}
      assertFailsWith<IllegalStateException> {
        recovery.reconcile(now.plusSeconds(600), setOf("SPY"), { error("provider failed") }) {}
      }
      assertFailsWith<CancellationException> {
        recovery.reconcile(now.plusSeconds(660), setOf("SPY"), { listOf(closing) }) { throw CancellationException("stopped") }
      }
      val retry = recovery.reconcile(now.plusSeconds(720), setOf("SPY"), { listOf(closing) }) {}
      assertEquals(Instant.parse("2026-09-18T19:56:00Z"), retry.window.start)
      assertEquals(1, retry.published)
    }

  @Test
  fun `waits for acknowledgement before completing or allowing another scan`() =
    runBlocking {
      val recovery = BarRecovery(Duration.ofHours(12))
      val publishing = CompletableDeferred<Unit>()
      val acknowledged = CompletableDeferred<Unit>()
      val first =
        async {
          recovery.reconcile(now, setOf("SPY"), { listOf(closing) }) {
            publishing.complete(Unit)
            acknowledged.await()
          }
        }
      publishing.await()
      assertFalse(first.isCompleted)
      val second = async { recovery.reconcile(now.plusSeconds(60), setOf("SPY"), { listOf(closing) }) { error("duplicate") } }
      acknowledged.complete(Unit)
      assertEquals(1, first.await().published)
      assertEquals(0, second.await().published)
    }

  @Test
  fun `rejects duplicate unaligned and foreign input before publishing`() =
    runBlocking {
      for (bars in listOf(listOf(closing, closing), listOf(bar("2026-09-18T19:59:01Z")), listOf(closing.copy(symbol = "AMZN")))) {
        val recovery = BarRecovery(Duration.ofHours(12))
        assertFailsWith<IllegalArgumentException> {
          recovery.reconcile(now, setOf("SPY"), { bars }) { error("invalid bar reached Kafka") }
        }
        assertEquals(1, recovery.reconcile(now, setOf("SPY"), { listOf(closing) }) {}.published)
      }
    }

  @Test
  fun `a restart repeats the bounded scan with the same source bar`() =
    runBlocking {
      val sent = mutableListOf<AlpacaBar>()
      repeat(2) {
        val recovery = BarRecovery(Duration.ofHours(12))
        assertEquals(1, recovery.reconcile(now, setOf("SPY"), { listOf(closing) }) { sent += it }.published)
      }
      assertEquals(listOf(closing, closing), sent)
    }
}
