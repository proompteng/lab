package ai.proompteng.dorvud.platform

import java.time.Duration
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
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

  @Test
  fun `TTL turnover keeps all retained key storage bounded`() {
    val cache = DedupCache<String>(Duration.ofSeconds(1), maxEntries = 2)
    val start = Instant.parse("2025-12-03T00:00:00Z")
    repeat(10_000) { index ->
      assertFalse(cache.isDuplicate("expired-$index", start.plusSeconds(index * 2L)))
    }
    // Check auxiliary storage too: a bounded lookup map does not bound a stale-key queue.
    cache.javaClass.declaredFields.forEach { field ->
      field.isAccessible = true
      val count =
        when (val value = field.get(cache)) {
          is Map<*, *> -> value.size
          is Collection<*> -> value.size
          else -> 0
        }
      assertTrue(count <= 2, "${field.name} retained $count entries despite capacity 2")
    }
  }

  @Test
  fun `expired history cannot displace capacity eviction of live entries`() {
    val cache = DedupCache<String>(Duration.ofSeconds(1), maxEntries = 2)
    val start = Instant.parse("2025-12-03T00:00:00Z")
    // Sustained TTL turnover must not leave a second unbounded queue of old keys.
    repeat(10_000) { index ->
      assertFalse(cache.isDuplicate("expired-$index", start.plusSeconds(index * 2L)))
    }
    val now = start.plusSeconds(20_000)
    assertFalse(cache.isDuplicate("oldest", now))
    assertFalse(cache.isDuplicate("middle", now))
    assertFalse(cache.isDuplicate("newest", now))
    assertTrue(cache.isDuplicate("middle", now))
    assertTrue(cache.isDuplicate("newest", now))
    assertFalse(cache.isDuplicate("oldest", now))
  }

  @Test
  fun `reinserting an expired key uses its new insertion position`() {
    val cache = DedupCache<String>(Duration.ofSeconds(1), maxEntries = 2)
    val start = Instant.parse("2025-12-03T00:00:00Z")
    assertFalse(cache.isDuplicate("reused", start))
    val now = start.plusSeconds(2)
    assertFalse(cache.isDuplicate("oldest", now))
    assertFalse(cache.isDuplicate("reused", now))
    assertFalse(cache.isDuplicate("newest", now))
    assertTrue(cache.isDuplicate("reused", now))
    assertFalse(cache.isDuplicate("oldest", now))
  }

  @Test
  fun `duplicate hits do not extend ttl or change insertion order`() {
    val cache = DedupCache<String>(Duration.ofSeconds(5), maxEntries = 2)
    val start = Instant.parse("2025-12-03T00:00:00Z")
    assertFalse(cache.isDuplicate("oldest", start))
    assertFalse(cache.isDuplicate("newer", start.plusSeconds(1)))
    assertTrue(cache.isDuplicate("oldest", start.plusSeconds(5)))
    assertFalse(cache.isDuplicate("newest", start.plusSeconds(5)))
    assertFalse(cache.isDuplicate("oldest", start.plusSeconds(5)))
    assertTrue(cache.isDuplicate("oldest", start.plusSeconds(10)))
    assertFalse(cache.isDuplicate("oldest", start.plusSeconds(11)))
  }

  @Test
  fun `expiry still scans entries when supplied time moves backwards`() {
    val cache = DedupCache<String>(Duration.ofSeconds(5), maxEntries = 3)
    val start = Instant.parse("2025-12-03T00:00:00Z")
    assertFalse(cache.isDuplicate("future", start.plusSeconds(10)))
    assertFalse(cache.isDuplicate("earlier", start))
    assertFalse(cache.isDuplicate("earlier", start.plusSeconds(6)))
    assertTrue(cache.isDuplicate("future", start.plusSeconds(6)))
  }

  @Test
  fun `concurrent identical observations admit exactly one record`() {
    val cache = DedupCache<String>(Duration.ofSeconds(5), maxEntries = 2)
    val now = Instant.parse("2025-12-03T00:00:00Z")
    val pool = Executors.newFixedThreadPool(8)
    val start = CountDownLatch(1)
    try {
      val attempts =
        (1..8).map {
          pool.submit<Boolean> {
            start.await()
            cache.isDuplicate("same", now)
          }
        }
      start.countDown()
      assertEquals(1, attempts.count { !it.get(5, TimeUnit.SECONDS) })
    } finally {
      pool.shutdownNow()
    }
  }
}
