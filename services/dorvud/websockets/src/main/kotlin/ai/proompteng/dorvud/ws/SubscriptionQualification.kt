package ai.proompteng.dorvud.ws

import kotlinx.serialization.Serializable
import java.util.concurrent.atomic.AtomicReference

internal const val SUBSCRIPTION_QUALIFICATION_BAR_INTERVAL_MS = 60_000L

internal sealed interface SubscriptionQualificationCommand {
  data class Add(
    val symbolsByChannel: Map<String, List<String>>,
  ) : SubscriptionQualificationCommand

  data class Remove(
    val symbolsByChannel: Map<String, List<String>>,
  ) : SubscriptionQualificationCommand

  data class Close(
    val reason: String,
  ) : SubscriptionQualificationCommand
}

@Serializable
data class SubscriptionQualificationObservation(
  val usableSamples: Long = 0,
  val unusableSamples: Long = 0,
  val firstReceivedAtMs: Long? = null,
  val latestProviderAtMs: Long? = null,
  val latestReceivedAtMs: Long? = null,
  val latestProcessedAtMs: Long? = null,
  val maximumProviderAgeMs: Long? = null,
  val maximumQueueDelayMs: Long? = null,
  val maximumReceiptGapMs: Long = 0,
)

@Serializable
data class SubscriptionQualificationProof(
  val generation: Long,
  val candidateAcknowledgedAtMs: Long,
  val observationCompletedAtMs: Long,
  val baselineRestoredAtMs: Long,
  val observations: Map<String, Map<String, SubscriptionQualificationObservation>>,
)

@Serializable
data class SubscriptionQualificationStatus(
  val generation: Long,
  val phase: String,
  val attempted: Boolean,
  val qualified: Boolean,
  val baselineRestored: Boolean,
  val outcome: String?,
  val admittedSymbolsByChannel: Map<String, List<String>>,
  val candidateSymbolsByChannel: Map<String, List<String>>,
  val targetSymbolsByChannel: Map<String, List<String>>,
  val acknowledgedSymbolsByChannel: Map<String, List<String>>,
  val candidateAcknowledgedAtMs: Long?,
  val observations: Map<String, Map<String, SubscriptionQualificationObservation>>,
  val incompleteSymbolsByChannel: Map<String, List<String>>,
  val completedProof: SubscriptionQualificationProof?,
)

internal class SubscriptionQualification(
  baseline: Map<String, List<String>>,
  candidateSymbols: List<String>,
  private val acknowledgementTimeoutMs: Long = 10_000,
  private val maximumProviderAgeMs: Long = 10_000,
  private val observationDurationMs: Long = 2 * SUBSCRIPTION_QUALIFICATION_BAR_INTERVAL_MS + maximumProviderAgeMs,
  private val maximumQueueDelayMs: Long = 1_000,
) {
  private sealed interface Phase {
    data object WaitingBaseline : Phase

    data object Armed : Phase

    data class AwaitingCandidate(
      val deadlineMs: Long,
    ) : Phase

    data class Observing(
      val deadlineMs: Long,
    ) : Phase

    data class AwaitingRollback(
      val deadlineMs: Long,
      val qualified: Boolean,
    ) : Phase

    data class Finished(
      val qualified: Boolean,
    ) : Phase

    data object Closed : Phase
  }

  private data class State(
    val generation: Long = 0,
    val lastSeenNowMs: Long? = null,
    val clockFailurePending: Boolean = false,
    val phase: Phase = Phase.Closed,
    val attempted: Boolean = false,
    val outcome: String? = null,
    val acknowledged: Map<String, List<String>> = emptyMap(),
    val candidateAcknowledgedAtMs: Long? = null,
    val observationCompletedAtMs: Long? = null,
    val observations: Map<String, Map<String, SubscriptionQualificationObservation>> = emptyMap(),
    val invalidObservation: Boolean = false,
    val incomplete: Map<String, List<String>> = emptyMap(),
    val completedProof: SubscriptionQualificationProof? = null,
  )

  private val channels = listOf("trades", "quotes", "bars")
  private val admitted = channels.associateWith { baseline[it].orEmpty().toList() }
  private val candidates = listOf("trades", "quotes").associateWith { candidateSymbols.toList() }
  private val target = channels.associateWith { (admitted.getValue(it) + candidates[it].orEmpty()).sorted() }
  private val state = AtomicReference(State())

  init {
    require(acknowledgementTimeoutMs > 0 && observationDurationMs > 0 && maximumProviderAgeMs > 0 && maximumQueueDelayMs >= 0)
    require(baseline.keys == channels.toSet()) { "qualification requires only trades, quotes and bars" }
    require(candidateSymbols.isNotEmpty() && candidateSymbols == candidateSymbols.distinct().sorted())
    require(admitted.values.all { it.isNotEmpty() && it == it.distinct().sorted() })
    require(candidates.all { (channel, symbols) -> symbols.none { it in admitted.getValue(channel) } })
    require(target.values.all { it == admitted.getValue("bars") }) { "qualification must preserve the complete bar universe" }
  }

  fun sessionOpened(nowMs: Long): Long {
    val previous = state.get()
    val next =
      State(
        generation = previous.generation + 1,
        lastSeenNowMs = nowMs,
        phase = Phase.WaitingBaseline,
        attempted = previous.attempted,
        outcome = previous.outcome,
        completedProof = previous.completedProof,
      )
    state.set(next)
    return next.generation
  }

  fun sessionClosed(
    generation: Long,
    nowMs: Long,
  ) {
    val current = state.get()
    if (current.generation != generation || current.phase == Phase.Closed) return
    state.set(current.copy(phase = Phase.Closed, outcome = retainedOutcome(current, "session-disconnected")))
  }

  fun isAdmitted(
    channel: String,
    symbol: String,
  ): Boolean = symbol in admitted[channel].orEmpty()

  fun isCandidate(
    channel: String,
    symbol: String,
  ): Boolean = symbol in candidates[channel].orEmpty()

  fun onAcknowledgement(
    generation: Long,
    actual: Map<String, List<String>>,
    nowMs: Long,
    regularSession: Boolean,
  ): SubscriptionQualificationCommand? {
    val previous = state.get()
    if (previous.generation != generation || previous.phase == Phase.Closed) return null
    if (clockRegressed(previous, nowMs)) return close(previous, "qualification-clock-regressed")
    val current = previous.copy(lastSeenNowMs = nowMs)
    val acknowledged = channels.associateWith { actual[it].orEmpty().distinct().sorted() }
    val updated = current.copy(acknowledged = acknowledged)
    state.set(updated)
    return when (val phase = current.phase) {
      Phase.WaitingBaseline -> {
        if (acknowledged != admitted) return null
        if (current.attempted) {
          state.set(updated.copy(phase = Phase.Finished(false), outcome = current.outcome ?: "attempt-already-latched"))
          null
        } else {
          state.set(updated.copy(phase = Phase.Armed))
          tick(generation, nowMs, regularSession)
        }
      }
      Phase.Armed -> {
        if (acknowledged != admitted) close(updated, "baseline-acknowledgement-changed") else tick(generation, nowMs, regularSession)
      }
      is Phase.AwaitingCandidate -> {
        if (nowMs >= phase.deadlineMs || acknowledged != target) {
          rollback(
            updated,
            nowMs,
            false,
            if (nowMs >=
              phase.deadlineMs
            ) {
              "candidate-acknowledgement-timeout"
            } else {
              "candidate-acknowledgement-incomplete"
            },
          )
        } else if (!regularSession) {
          rollback(updated, nowMs, false, "outside-regular-session")
        } else {
          state.set(updated.copy(phase = Phase.Observing(nowMs + observationDurationMs), candidateAcknowledgedAtMs = nowMs))
          null
        }
      }
      is Phase.Observing -> {
        if (acknowledged !=
          target
        ) {
          rollback(updated, nowMs, false, "candidate-acknowledgement-changed")
        } else {
          tick(generation, nowMs, regularSession)
        }
      }
      is Phase.AwaitingRollback -> {
        if (nowMs >= phase.deadlineMs || acknowledged != admitted) {
          close(updated, if (nowMs >= phase.deadlineMs) "baseline-rollback-timeout" else "baseline-rollback-unverified")
        } else {
          val proof =
            if (phase.qualified) {
              SubscriptionQualificationProof(
                generation,
                checkNotNull(current.candidateAcknowledgedAtMs),
                checkNotNull(current.observationCompletedAtMs),
                nowMs,
                current.observations,
              )
            } else {
              current.completedProof
            }
          state.set(updated.copy(phase = Phase.Finished(phase.qualified), completedProof = proof))
          null
        }
      }
      is Phase.Finished -> if (acknowledged != admitted) close(updated, "baseline-acknowledgement-changed") else null
      Phase.Closed -> null
    }
  }

  fun onProviderError(
    generation: Long,
    code: Int?,
    nowMs: Long,
  ): Boolean {
    val previous = state.get()
    if (previous.generation != generation || previous.phase == Phase.Closed) return false
    if (clockRegressed(previous, nowMs)) {
      close(previous, "qualification-clock-regressed")
      return false
    }
    val current = previous.copy(lastSeenNowMs = nowMs)
    if (code == 405 && current.phase is Phase.AwaitingCandidate) {
      // Alpaca's 405 contract preserves the subscription preceding the rejected additive request.
      state.set(current.copy(phase = Phase.Finished(false), outcome = "provider-rejected-405", acknowledged = admitted))
      return true
    }
    state.set(current.copy(phase = Phase.Closed, outcome = retainedOutcome(current, "provider-error-${code ?: "unknown"}")))
    return false
  }

  fun tick(
    generation: Long,
    nowMs: Long,
    regularSession: Boolean,
  ): SubscriptionQualificationCommand? {
    val previous = state.get()
    if (previous.generation != generation || previous.phase == Phase.Closed) return null
    if (clockRegressed(previous, nowMs)) return close(previous, "qualification-clock-regressed")
    val current = previous.copy(lastSeenNowMs = nowMs)
    state.set(current)
    return when (val phase = current.phase) {
      Phase.Armed -> {
        if (!regularSession) return null
        state.set(current.copy(phase = Phase.AwaitingCandidate(nowMs + acknowledgementTimeoutMs), attempted = true))
        SubscriptionQualificationCommand.Add(candidates)
      }
      is Phase.AwaitingCandidate -> {
        if (nowMs >= phase.deadlineMs) rollback(current, nowMs, false, "candidate-acknowledgement-timeout") else null
      }
      is Phase.Observing -> {
        if (!regularSession) {
          rollback(current, nowMs, false, "outside-regular-session")
        } else if (nowMs >= phase.deadlineMs) {
          val incomplete = incomplete(current, nowMs)
          val qualified = !current.invalidObservation && incomplete.isEmpty()
          rollback(
            current.copy(incomplete = incomplete, observationCompletedAtMs = nowMs),
            nowMs,
            qualified,
            if (qualified) "qualified" else "coverage-unproved",
          )
        } else {
          null
        }
      }
      is Phase.AwaitingRollback -> if (nowMs >= phase.deadlineMs) close(current, "baseline-rollback-timeout") else null
      else -> null
    }
  }

  fun nextWakeDelayMs(
    generation: Long,
    nowMs: Long,
  ): Long? {
    val current = state.get()
    if (current.generation != generation) return null
    if (clockRegressed(current, nowMs)) return 1
    val deadline =
      when (val phase = current.phase) {
        Phase.Armed -> return 60_000
        is Phase.AwaitingCandidate -> phase.deadlineMs
        is Phase.Observing -> phase.deadlineMs
        is Phase.AwaitingRollback -> phase.deadlineMs
        else -> return null
      }
    return (deadline - nowMs).coerceAtLeast(1)
  }

  fun observe(
    generation: Long,
    channel: String,
    symbol: String,
    providerAtMs: Long?,
    receivedAtMs: Long,
    processedAtMs: Long,
    usable: Boolean,
    regularSession: Boolean,
  ) {
    val previous = state.get()
    if (previous.generation != generation || previous.phase !is Phase.Observing) return
    if (clockRegressed(previous, processedAtMs)) {
      // Observation callbacks cannot issue transport commands; wake the owner to close coherently.
      state.set(previous.copy(clockFailurePending = true, invalidObservation = true))
      return
    }
    val current = previous.copy(lastSeenNowMs = processedAtMs)
    state.set(current)
    if (symbol !in target[channel].orEmpty()) return
    if (receivedAtMs >= previous.phase.deadlineMs || processedAtMs >= previous.phase.deadlineMs) return
    val prior = current.observations[channel]?.get(symbol) ?: SubscriptionQualificationObservation()
    val age = providerAtMs?.let { receivedAtMs - it }
    val queue = processedAtMs - receivedAtMs
    val limit = ageLimit(channel)
    val valid =
      usable && regularSession && age != null && age in 0..limit && queue in 0..maximumQueueDelayMs &&
        receivedAtMs >= checkNotNull(current.candidateAcknowledgedAtMs) &&
        (prior.latestReceivedAtMs == null || receivedAtMs >= prior.latestReceivedAtMs)
    val observation =
      prior.copy(
        usableSamples = prior.usableSamples + if (valid) 1 else 0,
        unusableSamples = prior.unusableSamples + if (valid) 0 else 1,
        firstReceivedAtMs = if (valid) prior.firstReceivedAtMs ?: receivedAtMs else prior.firstReceivedAtMs,
        latestProviderAtMs = if (valid) providerAtMs else prior.latestProviderAtMs,
        latestReceivedAtMs = if (valid) receivedAtMs else prior.latestReceivedAtMs,
        latestProcessedAtMs = if (valid) processedAtMs else prior.latestProcessedAtMs,
        maximumProviderAgeMs = age?.let { maxOf(prior.maximumProviderAgeMs ?: it, it) } ?: prior.maximumProviderAgeMs,
        maximumQueueDelayMs = maxOf(prior.maximumQueueDelayMs ?: queue, queue),
        maximumReceiptGapMs =
          if (valid &&
            prior.latestReceivedAtMs != null
          ) {
            maxOf(prior.maximumReceiptGapMs, receivedAtMs - prior.latestReceivedAtMs)
          } else {
            prior.maximumReceiptGapMs
          },
      )
    state.set(
      current.copy(
        observations = current.observations + (channel to (current.observations[channel].orEmpty() + (symbol to observation))),
        invalidObservation = current.invalidObservation || !valid,
      ),
    )
  }

  fun snapshot(): SubscriptionQualificationStatus {
    val current = state.get()
    val phaseName =
      when (current.phase) {
        Phase.WaitingBaseline -> "waiting-baseline"
        Phase.Armed -> "armed-waiting-regular-session"
        is Phase.AwaitingCandidate -> "awaiting-candidate-acknowledgement"
        is Phase.Observing -> "observing"
        is Phase.AwaitingRollback -> "awaiting-baseline-rollback"
        is Phase.Finished -> "finished"
        Phase.Closed -> "closed"
      }
    return SubscriptionQualificationStatus(
      current.generation,
      phaseName,
      current.attempted,
      (current.phase as? Phase.Finished)?.qualified == true,
      current.phase is Phase.Finished,
      current.outcome,
      admitted,
      candidates,
      target,
      current.acknowledged,
      current.candidateAcknowledgedAtMs,
      current.observations,
      current.incomplete,
      current.completedProof,
    )
  }

  private fun ageLimit(channel: String): Long =
    if (channel == "bars") 2 * SUBSCRIPTION_QUALIFICATION_BAR_INTERVAL_MS + maximumProviderAgeMs else maximumProviderAgeMs

  private fun incomplete(
    current: State,
    nowMs: Long,
  ): Map<String, List<String>> =
    target
      .mapValues { (channel, symbols) ->
        val limit = ageLimit(channel)
        symbols.filter { symbol ->
          val observation = current.observations[channel]?.get(symbol)
          val first = observation?.firstReceivedAtMs
          val latest = observation?.latestReceivedAtMs
          val provider = observation?.latestProviderAtMs
          observation == null || first == null || latest == null || provider == null ||
            first - checkNotNull(current.candidateAcknowledgedAtMs) > limit || nowMs - latest !in 0..limit ||
            nowMs - provider !in 0..limit || observation.maximumReceiptGapMs > limit
        }
      }.filterValues { it.isNotEmpty() }

  private fun rollback(
    current: State,
    nowMs: Long,
    qualified: Boolean,
    reason: String,
  ): SubscriptionQualificationCommand.Remove {
    state.set(current.copy(phase = Phase.AwaitingRollback(nowMs + acknowledgementTimeoutMs, qualified), outcome = reason))
    return SubscriptionQualificationCommand.Remove(candidates)
  }

  private fun clockRegressed(
    current: State,
    nowMs: Long,
  ): Boolean {
    val startedAtMs = phaseStartedAtMs(current.phase) ?: return false
    return current.clockFailurePending || current.lastSeenNowMs?.let { nowMs < it } == true || nowMs < startedAtMs
  }

  private fun phaseStartedAtMs(phase: Phase): Long? =
    when (phase) {
      is Phase.AwaitingCandidate -> phase.deadlineMs - acknowledgementTimeoutMs
      is Phase.Observing -> phase.deadlineMs - observationDurationMs
      is Phase.AwaitingRollback -> phase.deadlineMs - acknowledgementTimeoutMs
      else -> null
    }

  private fun retainedOutcome(
    current: State,
    reason: String,
  ): String =
    if (current.phase is Phase.Finished || current.phase == Phase.Closed ||
      (current.phase == Phase.WaitingBaseline && current.attempted)
    ) {
      current.outcome ?: reason
    } else {
      reason
    }

  private fun close(
    current: State,
    reason: String,
  ): SubscriptionQualificationCommand.Close {
    state.set(current.copy(phase = Phase.Closed, outcome = retainedOutcome(current, reason)))
    return SubscriptionQualificationCommand.Close(reason)
  }
}
