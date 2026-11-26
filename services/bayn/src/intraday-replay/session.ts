import { DecisionReadinessReason } from '../cycle/runner/readiness'
import { Clock, Effect, Semaphore } from 'effect'
import { TestClock } from 'effect/testing'
import type { RecoveryFirstCycleAdvance } from '../observe-composition/model'
import { ReplayBrokerFailure } from './broker'
import { utcInstantFromEpochMillis } from '../time'
import { executionControllerSuccessorSchedule, type ExecutionControllerState } from '../execution/controller'
import { ExecutionControllerOutcome } from '../execution/controller-status'

/** One owner advances raw arrivals, the account clock and Effect time at each synchronization point. */
export const makeReplayTimeline = <SourceError, DatabaseError>(
  source: { readonly advanceTo: (atMs: number) => Effect.Effect<void, SourceError> },
  databaseClock: { readonly advanceTo: (instant: string) => Effect.Effect<void, DatabaseError> },
  lastPermittedAtMs: number,
) =>
  Effect.gen(function* () {
    const permit = yield* Semaphore.make(1)
    const advance = (atMs: number, publishSource: boolean) =>
      permit
        .withPermit(
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis
            if (!Number.isSafeInteger(atMs) || atMs < nowMs || atMs > lastPermittedAtMs)
              return yield* new ReplayBrokerFailure({
                message: 'Replay time is outside its declared monotonic session interval',
              })
            if (publishSource) yield* source.advanceTo(atMs)
            yield* databaseClock.advanceTo(utcInstantFromEpochMillis(atMs))
            yield* TestClock.setTime(atMs)
          }),
        )
        .pipe(
          Effect.mapError((cause) => new ReplayBrokerFailure({ message: 'Replay timeline could not advance', cause })),
        )
    return {
      advanceTo: (atMs: number) => advance(atMs, true),
      advanceDeadlineTo: (atMs: number) => advance(atMs, false),
    }
  })

type SessionRuntime<E> = { readonly advance: Effect.Effect<RecoveryFirstCycleAdvance, E>; readonly nextDelayMs: number }

/** One serialized stream owner survives reporting cuts, just as the live owner survives idle market periods. */
export const makeStreamingReplaySession = <SourceError, BrokerError>(events: {
  readonly nextAvailableAtMs: Effect.Effect<number | null, SourceError>
  readonly sourceRevision: Effect.Effect<number, SourceError>
  readonly brokerStateHash: Effect.Effect<string, BrokerError>
}) => {
  let initialized = false
  let sourceRevision = 0
  let brokerStateHash: string | undefined
  let schedule: Pick<ExecutionControllerState, 'nextDueAt' | 'marketEligibleAt' | 'marketDataWakeSuppressed'> = {}
  let timerAtMs: number | null = null
  return <E>(
    runtime: SessionRuntime<E>,
    advanceTo: (atMs: number) => Effect.Effect<void, ReplayBrokerFailure>,
    firstPollAtMs: number,
    lastPollAtMs: number,
    _finalWindow: boolean,
  ) =>
    Effect.gen(function* () {
      let now = yield* Clock.currentTimeMillis
      if (!Number.isSafeInteger(firstPollAtMs) || !Number.isSafeInteger(lastPollAtMs) || lastPollAtMs < now)
        return yield* new ReplayBrokerFailure({ message: 'Invalid streaming replay session interval' })
      let initialWake = !initialized
      if (!initialized) {
        if (firstPollAtMs < now)
          return yield* new ReplayBrokerFailure({ message: 'Streaming activation precedes its replay clock' })
        yield* advanceTo(Math.min(firstPollAtMs, lastPollAtMs))
        now = yield* Clock.currentTimeMillis
        sourceRevision = yield* events.sourceRevision
        brokerStateHash = yield* events.brokerStateHash
        initialized = true
      }
      let firstPassAtMs: number | undefined
      let passCount = 0
      let failedPassCount = 0
      let unavailableDecisionPassCount = 0
      const readinessCounts: Partial<Record<DecisionReadinessReason, number>> = {}
      while (now <= lastPollAtMs) {
        const currentSource = yield* events.sourceRevision
        const currentBroker = yield* events.brokerStateHash
        const changedSource = currentSource !== sourceRevision
        const changedBroker = currentBroker !== brokerStateHash
        // A suppressed market hint still advances the frontier; it cannot be resurrected at a later clock.
        sourceRevision = currentSource
        brokerStateHash = currentBroker
        const marketEligible =
          schedule.marketDataWakeSuppressed !== true &&
          (schedule.marketEligibleAt === undefined || now >= Date.parse(schedule.marketEligibleAt))
        const deadline = timerAtMs
        const due = deadline !== null && deadline <= now
        if (initialWake || due || changedBroker || (changedSource && marketEligible)) {
          initialWake = false
          firstPassAtMs ??= now
          const pass = yield* runtime.advance
          passCount++
          if (pass.observation.result === 'FAILURE') failedPassCount++
          else if (pass.observation.readiness !== undefined) {
            const { reason } = pass.observation.readiness
            readinessCounts[reason] = (readinessCounts[reason] ?? 0) + 1
            switch (reason) {
              case DecisionReadinessReason.AccountProtection:
              case DecisionReadinessReason.TurnoverBudgetExhausted:
              case DecisionReadinessReason.LookbackWarmup:
              case DecisionReadinessReason.NoEligibleCandidate:
              case DecisionReadinessReason.SignalWindowObserved:
                break
              case DecisionReadinessReason.DecisionPending:
              case DecisionReadinessReason.InferenceUnavailable:
              case DecisionReadinessReason.InferenceExpired:
              case DecisionReadinessReason.ExecutionRiskExpired:
              case DecisionReadinessReason.SnapshotUnavailable:
              case DecisionReadinessReason.SnapshotCoverage:
              case DecisionReadinessReason.SnapshotStale:
              case DecisionReadinessReason.ArchiveWatermark:
                unavailableDecisionPassCount++
                break
              default: {
                const unhandled: never = reason
                return yield* new ReplayBrokerFailure({ message: `Unsupported decision readiness ${unhandled}` })
              }
            }
          }
          const completedAtMs = yield* Clock.currentTimeMillis
          if (completedAtMs < now)
            return yield* new ReplayBrokerFailure({ message: 'Streaming command moved replay time backwards' })
          schedule = yield* Effect.fromResult(
            executionControllerSuccessorSchedule(schedule, {
              completedAt: utcInstantFromEpochMillis(completedAtMs),
              observation: pass.observation,
              outcome: {
                _tag:
                  pass.observation.result === 'FAILURE'
                    ? ExecutionControllerOutcome.Blocked
                    : ExecutionControllerOutcome.Waiting,
                ...(pass.nextWakeAt === undefined ? {} : { nextWakeAt: pass.nextWakeAt }),
              },
            }),
          )
          // Live Restate delivery schedules an already elapsed native deadline at least one millisecond later.
          timerAtMs =
            schedule.nextDueAt === undefined ? null : Math.max(completedAtMs + 1, Date.parse(schedule.nextDueAt))
          now = completedAtMs
          // Source and broker transitions during a pass are serialized behind that pass, never discarded.
          continue
        }
        if (now >= lastPollAtMs) break
        const nextSource = yield* events.nextAvailableAtMs
        if (nextSource !== null && (!Number.isSafeInteger(nextSource) || nextSource <= now))
          return yield* new ReplayBrokerFailure({ message: 'Streaming source did not advance its arrival frontier' })
        const next = Math.min(nextSource ?? lastPollAtMs, deadline ?? lastPollAtMs, lastPollAtMs)
        yield* advanceTo(next)
        now = yield* Clock.currentTimeMillis
      }
      return {
        // These retained field names describe command timestamps, not a synthetic polling cadence.
        nextPollAtMs: timerAtMs ?? Number.MAX_SAFE_INTEGER,
        firstPollAtMs: firstPassAtMs ?? Math.min(firstPollAtMs, lastPollAtMs),
        lastPollAtMs,
        completedAtMs: yield* Clock.currentTimeMillis,
        passCount,
        failedPassCount,
        unavailableDecisionPassCount,
        readinessCounts,
      }
    }).pipe(
      Effect.mapError(
        (cause) => new ReplayBrokerFailure({ message: 'Streaming replay session could not advance', cause }),
      ),
    )
}

/** Reporting cuts preserve the next production poll; only the final interval forces a terminal pass. */
export const driveReplaySession = <E>(
  runtime: SessionRuntime<E>,
  advanceTo: (atMs: number) => Effect.Effect<void, ReplayBrokerFailure>,
  firstPollAtMs: number,
  lastPollAtMs: number,
  finalWindow: boolean,
) =>
  Effect.gen(function* () {
    if (
      !Number.isSafeInteger(firstPollAtMs) ||
      !Number.isSafeInteger(lastPollAtMs) ||
      firstPollAtMs < (yield* Clock.currentTimeMillis)
    )
      return yield* new ReplayBrokerFailure({ message: 'Invalid replay session interval' })
    const initialTimeMs = yield* Clock.currentTimeMillis
    let scheduledAtMs =
      finalWindow && initialTimeMs < lastPollAtMs ? Math.min(firstPollAtMs, lastPollAtMs) : firstPollAtMs
    const firstScheduledAtMs = scheduledAtMs
    let passCount = 0
    let failedPassCount = 0
    let unavailableDecisionPassCount = 0
    const readinessCounts: Partial<Record<DecisionReadinessReason, number>> = {}
    while (scheduledAtMs <= lastPollAtMs) {
      yield* advanceTo(scheduledAtMs)
      const pass = yield* runtime.advance
      passCount++
      if (pass.observation.result === 'FAILURE') failedPassCount++
      else if (pass.observation.readiness !== undefined) {
        const { reason } = pass.observation.readiness
        readinessCounts[reason] = (readinessCounts[reason] ?? 0) + 1
        switch (reason) {
          case DecisionReadinessReason.AccountProtection:
          case DecisionReadinessReason.TurnoverBudgetExhausted:
          case DecisionReadinessReason.LookbackWarmup:
          case DecisionReadinessReason.NoEligibleCandidate:
          case DecisionReadinessReason.SignalWindowObserved:
            break
          case DecisionReadinessReason.DecisionPending:
          case DecisionReadinessReason.InferenceUnavailable:
          case DecisionReadinessReason.InferenceExpired:
          case DecisionReadinessReason.ExecutionRiskExpired:
          case DecisionReadinessReason.SnapshotUnavailable:
          case DecisionReadinessReason.SnapshotCoverage:
          case DecisionReadinessReason.SnapshotStale:
          case DecisionReadinessReason.ArchiveWatermark:
            unavailableDecisionPassCount++
            break
          default: {
            const unhandled: never = reason
            return yield* new ReplayBrokerFailure({ message: `Unsupported decision readiness ${unhandled}` })
          }
        }
      }
      const completedAtMs = yield* Clock.currentTimeMillis
      if (completedAtMs < scheduledAtMs)
        return yield* new ReplayBrokerFailure({ message: 'Execution command moved replay time backwards' })
      const delay = pass.nextDelayMs ?? runtime.nextDelayMs
      if (!Number.isSafeInteger(delay) || delay <= 0)
        return yield* new ReplayBrokerFailure({ message: 'Execution command returned an invalid polling delay' })
      scheduledAtMs = completedAtMs + delay
      if (finalWindow && completedAtMs < lastPollAtMs) scheduledAtMs = Math.min(scheduledAtMs, lastPollAtMs)
    }
    yield* advanceTo(Math.max(yield* Clock.currentTimeMillis, lastPollAtMs))
    return {
      nextPollAtMs: scheduledAtMs,
      firstPollAtMs: firstScheduledAtMs,
      lastPollAtMs,
      completedAtMs: yield* Clock.currentTimeMillis,
      passCount,
      failedPassCount,
      unavailableDecisionPassCount,
      readinessCounts,
    }
  })
