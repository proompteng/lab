package ai.proompteng.dorvud.hyperliquid

import kotlinx.serialization.Serializable
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

@Serializable
data class KafkaClickHouseWriterSnapshot(
  val status: String,
  val ready: Boolean,
  val alive: Boolean,
  val phase: String,
  val assignedPartitions: Int,
  val pendingRecords: Int,
  val consumerLag: Long,
  val maxPartitionLag: Long,
  val lastPollTs: String?,
  val lastCommitTs: String?,
  val lastErrorCode: String?,
  val lastErrorDetail: String?,
  val unresolvedErrors: Int,
)

private data class WriterFailure(
  val code: String,
  val detail: String,
  val observedAtMs: Long,
)

class KafkaClickHouseWriterState(
  private val readinessMaxAgeMs: Long,
  private val readinessMaxPartitionLagRecords: Long = 1_000,
  private val nowMs: () -> Long = System::currentTimeMillis,
) {
  private val alive = AtomicBoolean(true)
  private val phase = AtomicReference("starting")
  private val assignedPartitions = AtomicInteger(0)
  private val pendingRecords = AtomicInteger(0)
  private val consumerLag = AtomicLong(0)
  private val maxPartitionLag = AtomicLong(0)
  private val lastPollMs = AtomicLong(0)
  private val lastCommitMs = AtomicLong(0)
  private val failures = ConcurrentHashMap<String, WriterFailure>()

  fun markRunning(partitionCount: Int) {
    assignedPartitions.set(partitionCount)
    refreshPhase()
  }

  fun markPoll() {
    lastPollMs.set(nowMs())
  }

  fun markCommit(scope: String) {
    lastCommitMs.set(nowMs())
    clearError(scope)
  }

  fun markError(
    scope: String,
    code: String,
    detail: String,
  ) {
    failures[scope] = WriterFailure(code = code, detail = detail.take(500), observedAtMs = nowMs())
    phase.set("degraded")
  }

  fun clearError(scope: String) {
    failures.remove(scope)
    refreshPhase()
  }

  fun markPending(value: Int) {
    pendingRecords.set(value.coerceAtLeast(0))
  }

  fun markConsumerLag(
    total: Long,
    maximum: Long,
  ) {
    consumerLag.set(total.coerceAtLeast(0))
    maxPartitionLag.set(maximum.coerceAtLeast(0))
  }

  fun markStopped() {
    alive.set(false)
    phase.set("stopped")
  }

  fun isAlive(): Boolean = alive.get()

  fun snapshot(): KafkaClickHouseWriterSnapshot {
    val observedAt = nowMs()
    val pollMs = lastPollMs.get()
    val commitMs = lastCommitMs.get()
    val latestFailure = failures.values.maxByOrNull(WriterFailure::observedAtMs)
    val isReady =
      alive.get() &&
        phase.get() == "running" &&
        assignedPartitions.get() > 0 &&
        pollMs > 0 &&
        commitMs > 0 &&
        observedAt - pollMs <= readinessMaxAgeMs &&
        maxPartitionLag.get() <= readinessMaxPartitionLagRecords &&
        failures.isEmpty()
    return KafkaClickHouseWriterSnapshot(
      status = if (isReady) "ready" else "not_ready",
      ready = isReady,
      alive = alive.get(),
      phase = phase.get(),
      assignedPartitions = assignedPartitions.get(),
      pendingRecords = pendingRecords.get(),
      consumerLag = consumerLag.get(),
      maxPartitionLag = maxPartitionLag.get(),
      lastPollTs = pollMs.takeIf { it > 0 }?.let(Instant::ofEpochMilli)?.toString(),
      lastCommitTs = commitMs.takeIf { it > 0 }?.let(Instant::ofEpochMilli)?.toString(),
      lastErrorCode = latestFailure?.code,
      lastErrorDetail = latestFailure?.detail,
      unresolvedErrors = failures.size,
    )
  }

  private fun refreshPhase() {
    if (alive.get()) {
      phase.set(if (failures.isEmpty()) "running" else "degraded")
    }
  }
}
