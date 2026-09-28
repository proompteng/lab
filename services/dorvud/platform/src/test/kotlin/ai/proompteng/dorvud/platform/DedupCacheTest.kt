package ai.proompteng.dorvud.platform

import java.time.Duration
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DedupCacheTest {
  @Test
  fun `marks duplicates within ttl`() {
    val cache = DedupCache<String>(Duration.ofSeconds(5), maxEntries = 2)
    val now = Instant.parse("2025-12-03T00:00:00Z")

    assertFalse(cache.isDuplicate("k1", now))
    assertTrue(cache.isDuplicate("k1", now.plusSeconds(1)))
  }

  @Test
  fun `evicts after ttl`() {
    val cache = DedupCache<String>(Duration.ofSeconds(1), maxEntries = 2)
    val start = Instant.parse("2025-12-03T00:00:00Z")

    assertFalse(cache.isDuplicate("k1", start))
    assertFalse(cache.isDuplicate("k1", start.plusSeconds(2)))
  }
}
