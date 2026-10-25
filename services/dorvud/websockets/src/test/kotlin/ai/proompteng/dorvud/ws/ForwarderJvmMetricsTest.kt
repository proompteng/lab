package ai.proompteng.dorvud.ws

import io.micrometer.prometheusmetrics.PrometheusConfig
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ForwarderJvmMetricsTest {
  @Test
  fun `exports live heap buffer and thread measurements`() {
    val registry = PrometheusMeterRegistry(PrometheusConfig.DEFAULT)
    try {
      observeJvmMetrics(registry).use {
        val heap =
          registry
            .find("jvm.memory.used")
            .tag("area", "heap")
            .gauges()
            .sumOf { it.value() }
        assertTrue(heap.isFinite() && heap > 0)
        assertTrue(registry.get("jvm.threads.live").gauge().value() > 0)
        assertTrue(registry.find("jvm.buffer.memory.used").gauges().isNotEmpty())
        assertTrue(
          registry
            .get("jvm.gc.max.data.size")
            .gauge()
            .value()
            .isFinite(),
        )

        val scrape = registry.scrape()
        assertTrue(scrape.contains("jvm_memory_used_bytes{area=\"heap\""))
        assertTrue(scrape.contains("jvm_buffer_memory_used_bytes"))
        assertTrue(scrape.contains("jvm_threads_live_threads"))
        assertTrue(scrape.contains("jvm_gc_max_data_size_bytes"))
        assertTrue(registry.meters.all { meter -> meter.id.tags.none { it.key == "symbol" || it.key == "cycle_id" } })
      }
    } finally {
      registry.close()
    }
  }

  @Test
  fun `records native GC pauses and removes the listener on close`() {
    val registry = PrometheusMeterRegistry(PrometheusConfig.DEFAULT)
    try {
      val observer = observeJvmMetrics(registry)
      try {
        val before = registry.find("jvm.gc.pause").timers().sumOf { it.count() }
        System.gc()
        val deadline = System.nanoTime() + 5_000_000_000
        while (registry.find("jvm.gc.pause").timers().sumOf { it.count() } == before && System.nanoTime() < deadline) {
          Thread.sleep(10)
        }
        assertTrue(registry.find("jvm.gc.pause").timers().sumOf { it.count() } > before)
        assertTrue(registry.scrape().contains("jvm_gc_pause_seconds_count"))

        observer.close()
        observer.close()
        Thread.sleep(100)
        val closedCount = registry.find("jvm.gc.pause").timers().sumOf { it.count() }
        System.gc()
        Thread.sleep(250)
        assertEquals(closedCount, registry.find("jvm.gc.pause").timers().sumOf { it.count() })
      } finally {
        observer.close()
      }
    } finally {
      registry.close()
    }
  }
}
