package ai.proompteng.dorvud.platform

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** Maintains per-symbol monotonic sequence numbers. */
class SeqTracker {
  private val counters = ConcurrentHashMap<String, AtomicLong>()

  fun next(symbol: String): Long = counters.computeIfAbsent(symbol) { AtomicLong(0) }.incrementAndGet()
}
