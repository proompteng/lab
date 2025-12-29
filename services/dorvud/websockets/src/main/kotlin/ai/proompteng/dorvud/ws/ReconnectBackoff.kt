package ai.proompteng.dorvud.ws

import kotlin.math.min
import kotlin.random.Random

internal class ReconnectBackoff(
  private val baseMs: Long,
  private val maxMs: Long,
  private val jitterRatio: Double = 0.2,
  private val random: Random = Random.Default,
) {
  init {
    require(baseMs > 0) { "baseMs must be > 0" }
    require(maxMs >= baseMs) { "maxMs must be >= baseMs" }
    require(jitterRatio >= 0.0) { "jitterRatio must be >= 0" }
  }

  fun nextDelay(attempt: Int): Long {
    if (attempt <= 0) return baseMs
    var delay = baseMs
    repeat(attempt - 1) {
      delay = min(maxMs, delay * 2)
    }
    if (jitterRatio <= 0.0) return delay

    val jitterSpan = delay * jitterRatio
    val jittered =
      delay - jitterSpan + (random.nextDouble() * jitterSpan * 2)
    return jittered.toLong().coerceAtLeast(baseMs).coerceAtMost(maxMs)
  }
}
