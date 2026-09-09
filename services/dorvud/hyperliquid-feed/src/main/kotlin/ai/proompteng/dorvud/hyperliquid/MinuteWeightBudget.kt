package ai.proompteng.dorvud.hyperliquid

import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.math.min

class MinuteWeightBudget(
  private val maxWeightPerMinute: Int,
  private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
  private val mutex = Mutex()
  private var windowStartMs: Long = nowMs()
  private var usedWeight: Int = 0

  suspend fun acquire(weight: Int) {
    require(weight > 0) { "weight must be > 0" }
    while (true) {
      val waitMs =
        mutex.withLock {
          rotateWindowIfNeeded()
          if (usedWeight + weight <= maxWeightPerMinute) {
            usedWeight += weight
            return
          }
          60_000 - (nowMs() - windowStartMs)
        }
      delay(min(waitMs.coerceAtLeast(1), 1_000))
    }
  }

  fun usedWeightInCurrentWindow(): Int {
    rotateWindowIfNeeded()
    return usedWeight
  }

  private fun rotateWindowIfNeeded() {
    val now = nowMs()
    if (now - windowStartMs >= 60_000) {
      windowStartMs = now
      usedWeight = 0
    }
  }
}
