package ai.proompteng.dorvud.hyperliquid

import java.util.concurrent.atomic.AtomicLong

data class KafkaReadinessSnapshot(
  val ready: Boolean,
  val lastSuccessEpochMs: Long?,
  val lastSuccessLagMs: Long?,
  val lastFailureEpochMs: Long?,
  val lastFailureAgeMs: Long?,
  val lastFailureReason: String?,
  val maxSuccessAgeMs: Long,
)

class KafkaReadinessTracker(
  private val maxSuccessAgeMs: Long,
  private val nowMs: () -> Long,
) {
  private val lastSuccessMs = AtomicLong(0)
  private val lastFailureMs = AtomicLong(0)

  @Volatile
  private var lastFailureReason: String? = null

  fun recordSuccess() {
    lastSuccessMs.set(nowMs())
  }

  fun recordFailure(error: Throwable) {
    lastFailureMs.set(nowMs())
    lastFailureReason = error.javaClass.simpleName.ifBlank { error.message ?: "unknown" }
  }

  fun isReady(): Boolean = isReadyAt(nowMs())

  fun snapshot(): KafkaReadinessSnapshot {
    val observedAt = nowMs()
    val lastSuccess = lastSuccessMs.get()
    val lastFailure = lastFailureMs.get()
    return KafkaReadinessSnapshot(
      ready = isReadyAt(observedAt),
      lastSuccessEpochMs = lastSuccess.takeIf { it > 0 },
      lastSuccessLagMs = lastSuccess.takeIf { it > 0 }?.let { observedAt - it },
      lastFailureEpochMs = lastFailure.takeIf { it > 0 },
      lastFailureAgeMs = lastFailure.takeIf { it > 0 }?.let { observedAt - it },
      lastFailureReason = lastFailureReason,
      maxSuccessAgeMs = maxSuccessAgeMs,
    )
  }

  private fun isReadyAt(observedAt: Long): Boolean {
    val lastSuccess = lastSuccessMs.get()
    return lastSuccess > 0 && observedAt - lastSuccess <= maxSuccessAgeMs
  }
}
