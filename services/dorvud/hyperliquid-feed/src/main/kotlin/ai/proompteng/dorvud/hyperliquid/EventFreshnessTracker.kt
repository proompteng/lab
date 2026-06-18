package ai.proompteng.dorvud.hyperliquid

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

data class EventFreshnessSnapshot(
  val fresh: Boolean,
  val lastSeenLagMs: Map<String, Long?>,
)

class EventFreshnessTracker(
  private val requiredChannels: Set<String>,
  private val maxAgeMs: Long,
  private val nowMs: () -> Long,
) {
  private val lastSeenMs = ConcurrentHashMap<String, AtomicLong>()

  fun record(channel: String): Long {
    val observedAt = nowMs()
    lastSeenMs.computeIfAbsent(channel) { AtomicLong(0) }.set(observedAt)
    return observedAt
  }

  fun isFresh(): Boolean = snapshot().fresh

  fun snapshot(): EventFreshnessSnapshot {
    val observedAt = nowMs()
    val lags =
      requiredChannels
        .sorted()
        .associateWith { channel ->
          val lastSeen = lastSeenMs[channel]?.get() ?: 0
          if (lastSeen <= 0) null else observedAt - lastSeen
        }
    return EventFreshnessSnapshot(
      fresh = lags.values.all { it != null && it <= maxAgeMs },
      lastSeenLagMs = lags,
    )
  }
}
