package ai.proompteng.dorvud.platform

import java.time.Duration
import java.time.Instant

/**
 * TTL + size bounded dedup cache. Returns true when the key is already present (i.e., duplicate).
 */
class DedupCache<K>(
  private val ttl: Duration,
  private val maxEntries: Int,
) {
  // Keep expiration and insertion order in one bounded store. A separate FIFO must
  // not retain keys after their TTL expires or evict a newer incarnation of a key.
  private val entries = LinkedHashMap<K, Instant>()

  @Synchronized
  fun isDuplicate(
    key: K,
    now: Instant = Instant.now(),
  ): Boolean {
    evictExpired(now)
    if (entries.containsKey(key)) return true

    entries[key] = now
    if (entries.size > maxEntries) {
      val oldest = entries.entries.iterator()
      oldest.next()
      oldest.remove()
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
