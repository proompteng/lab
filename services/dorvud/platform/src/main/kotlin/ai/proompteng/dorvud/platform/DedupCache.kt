package ai.proompteng.dorvud.platform

import java.time.Duration
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * TTL + size bounded dedup cache. Returns true when the key is already present (i.e., duplicate).
 */
class DedupCache<K>(
  private val ttl: Duration,
  private val maxEntries: Int,
) {
  private val entries = ConcurrentHashMap<K, Instant>()
  private val order = ConcurrentLinkedQueue<K>()

  fun isDuplicate(key: K, now: Instant = Instant.now()): Boolean {
    evictExpired(now)
    val existing = entries.putIfAbsent(key, now)
    if (existing != null) return true

    order.add(key)
    if (entries.size > maxEntries) {
      val victim = order.poll()
      if (victim != null) entries.remove(victim)
    }
    return false
  }

  private fun evictExpired(now: Instant) {
    val cutoff = now.minus(ttl)
    val iterator = entries.entries.iterator()
    while (iterator.hasNext()) {
      val entry = iterator.next()
      if (entry.value.isBefore(cutoff)) {
        iterator.remove()
      }
    }
  }
}
