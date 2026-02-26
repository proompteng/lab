package ai.proompteng.dorvud.ws

import java.util.concurrent.atomic.AtomicLong

internal class NotReadyLivenessGate(
  private val killAfterMs: Long,
  private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
  private val notReadySinceMs = AtomicLong(0)

  fun recordReadiness(ready: Boolean) {
    if (ready) {
      notReadySinceMs.set(0)
      return
    }
    notReadySinceMs.compareAndSet(0, nowMs())
  }

  fun shouldFailLiveness(): Boolean {
    val since = notReadySinceMs.get()
    if (since <= 0) return false
    return nowMs() - since >= killAfterMs
  }
}
