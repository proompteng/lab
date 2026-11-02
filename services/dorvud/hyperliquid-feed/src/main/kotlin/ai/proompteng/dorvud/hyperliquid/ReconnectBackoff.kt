package ai.proompteng.dorvud.hyperliquid

import kotlin.math.min
import kotlin.random.Random

class ReconnectBackoff(
  private val baseMs: Long,
  private val maxMs: Long,
  private val random: Random = Random.Default,
) {
  init {
    require(baseMs > 0) { "baseMs must be > 0" }
    require(maxMs >= baseMs) { "maxMs must be >= baseMs" }
  }

  fun nextDelay(attempt: Int): Long {
    var delay = baseMs
    repeat((attempt - 1).coerceAtLeast(0)) {
      delay = min(maxMs, delay * 2)
    }
    val jitterSpan = delay * 0.2
    return (delay - jitterSpan + random.nextDouble() * jitterSpan * 2)
      .toLong()
      .coerceIn(baseMs, maxMs)
  }
}
