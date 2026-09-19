package ai.proompteng.dorvud.ws

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Duration
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.concurrent.ConcurrentHashMap

internal data class BarIdentity(
  val symbol: String,
  val eventAt: Instant,
)

internal data class BarRecoveryResult(
  val window: AlpacaBarsBackfillWindow,
  val observed: Int,
  val published: Int,
)

internal class BarRecovery(
  private val lookback: Duration,
) {
  private data class CompletedScan(
    val at: Instant,
    val fullScanAt: Instant,
    val symbols: Set<String>,
  )

  private val delivered = ConcurrentHashMap.newKeySet<BarIdentity>()
  private val lock = Mutex()
  private var completed: CompletedScan? = null

  fun recordDelivered(
    symbol: String,
    eventAt: Instant,
  ) {
    delivered.add(BarIdentity(symbol, eventAt))
  }

  suspend fun reconcile(
    now: Instant,
    symbols: Set<String>,
    fetch: suspend (AlpacaBarsBackfillWindow) -> List<AlpacaBar>,
    publish: suspend (AlpacaBar) -> Unit,
  ): BarRecoveryResult =
    lock.withLock {
      require(symbols.isNotEmpty())
      val end = now.truncatedTo(ChronoUnit.MINUTES)
      val earliest = end.minus(lookback)
      delivered.removeIf { it.eventAt < earliest }
      val previous = completed
      val full = previous == null || previous.symbols != symbols || !now.isBefore(previous.fullScanAt.plus(Duration.ofHours(1)))
      val start = if (full) earliest else maxOf(earliest, previous.at.minus(Duration.ofMinutes(5)))
      val window = AlpacaBarsBackfillWindow(start, end)
      val bars =
        fetch(window).filter { bar ->
          require(bar.symbol in symbols) { "bar recovery returned an unrequested symbol" }
          val eventAt = Instant.parse(bar.timestamp)
          require(eventAt == eventAt.truncatedTo(ChronoUnit.MINUTES)) { "bar recovery returned an unaligned minute" }
          eventAt >= start && eventAt < end
        }
      require(bars.map { BarIdentity(it.symbol, Instant.parse(it.timestamp)) }.toSet().size == bars.size) {
        "bar recovery returned duplicate minutes"
      }
      var published = 0
      for (batch in bars.chunked(100)) {
        published +=
          coroutineScope {
            batch
              .map { bar ->
                async(start = CoroutineStart.UNDISPATCHED) {
                  val identity = BarIdentity(bar.symbol, Instant.parse(bar.timestamp))
                  if (identity in delivered) {
                    0
                  } else {
                    publish(bar)
                    delivered.add(identity)
                    1
                  }
                }
              }.awaitAll()
              .sum()
          }
      }
      completed = CompletedScan(end, if (full) now else previous.fullScanAt, symbols.toSet())
      BarRecoveryResult(window, bars.size, published)
    }
}
