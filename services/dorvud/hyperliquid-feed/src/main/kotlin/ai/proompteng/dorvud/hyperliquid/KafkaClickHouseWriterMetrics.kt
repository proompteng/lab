package ai.proompteng.dorvud.hyperliquid

import io.micrometer.core.instrument.Counter
import io.micrometer.core.instrument.DistributionSummary
import io.micrometer.core.instrument.Gauge
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Timer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

class KafkaClickHouseWriterMetrics(
  private val registry: MeterRegistry,
) {
  private val ready = AtomicInteger(0)
  private val caughtUp = AtomicInteger(0)
  private val assignedPartitions = AtomicInteger(0)
  private val pendingRecords = AtomicInteger(0)
  private val consumerLag = AtomicLong(0)
  private val maxPartitionLag = AtomicLong(0)
  private val flushes = ConcurrentHashMap<String, Counter>()
  private val batchRows = ConcurrentHashMap<String, DistributionSummary>()
  private val batchBytes = ConcurrentHashMap<String, DistributionSummary>()
  private val flushDuration = ConcurrentHashMap<String, Timer>()
  private val failures = ConcurrentHashMap<String, Counter>()
  private val reconciledOffsets = ConcurrentHashMap<String, Counter>()

  init {
    Gauge.builder("torghut_hyperliquid_clickhouse_writer_ready", ready) { it.get().toDouble() }.register(registry)
    Gauge
      .builder("torghut_hyperliquid_clickhouse_writer_caught_up", caughtUp) { it.get().toDouble() }
      .register(registry)
    Gauge
      .builder("torghut_hyperliquid_clickhouse_writer_assigned_partitions", assignedPartitions) { it.get().toDouble() }
      .register(registry)
    Gauge
      .builder("torghut_hyperliquid_clickhouse_writer_pending_records", pendingRecords) { it.get().toDouble() }
      .register(registry)
    Gauge.builder("torghut_hyperliquid_clickhouse_writer_consumer_lag", consumerLag) { it.get().toDouble() }.register(registry)
    Gauge
      .builder("torghut_hyperliquid_clickhouse_writer_max_partition_lag", maxPartitionLag) { it.get().toDouble() }
      .register(registry)
  }

  fun update(snapshot: KafkaClickHouseWriterSnapshot) {
    ready.set(if (snapshot.ready) 1 else 0)
    caughtUp.set(if (snapshot.caughtUp) 1 else 0)
    assignedPartitions.set(snapshot.assignedPartitions)
    pendingRecords.set(snapshot.pendingRecords)
    consumerLag.set(snapshot.consumerLag)
    maxPartitionLag.set(snapshot.maxPartitionLag)
  }

  fun recordFlush(
    table: String,
    reason: String,
    rows: Int,
    bytes: Int,
    durationNanos: Long,
  ) {
    val key = "$table:$reason"
    flushes
      .computeIfAbsent(key) {
        Counter
          .builder("torghut_hyperliquid_clickhouse_writer_flushes_total")
          .tag("table", table)
          .tag("reason", reason)
          .register(registry)
      }.increment()
    batchRows
      .computeIfAbsent(table) {
        DistributionSummary
          .builder("torghut_hyperliquid_clickhouse_writer_batch_rows")
          .tag("table", table)
          .register(registry)
      }.record(rows.toDouble())
    batchBytes
      .computeIfAbsent(table) {
        DistributionSummary
          .builder("torghut_hyperliquid_clickhouse_writer_batch_bytes")
          .tag("table", table)
          .register(registry)
      }.record(bytes.toDouble())
    flushDuration
      .computeIfAbsent(table) {
        Timer
          .builder("torghut_hyperliquid_clickhouse_writer_flush_duration")
          .tag("table", table)
          .register(registry)
      }.record(durationNanos, TimeUnit.NANOSECONDS)
  }

  fun recordFailure(
    table: String,
    code: String,
  ) {
    failures
      .computeIfAbsent("$table:$code") {
        Counter
          .builder("torghut_hyperliquid_clickhouse_writer_failures_total")
          .tag("table", table)
          .tag("code", code)
          .register(registry)
      }.increment()
  }

  fun recordReconciledOffsets(
    table: String,
    count: Int,
  ) {
    if (count <= 0) return
    reconciledOffsets
      .computeIfAbsent(table) {
        Counter
          .builder("torghut_hyperliquid_clickhouse_writer_reconciled_offsets_total")
          .tag("table", table)
          .register(registry)
      }.increment(count.toDouble())
  }
}
