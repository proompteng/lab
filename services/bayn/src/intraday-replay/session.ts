import { Clock, Effect, Semaphore } from 'effect'
import { TestClock } from 'effect/testing'
import type { RecoveryFirstCycleAdvance } from '../observe-composition/model'
import { ReplayBrokerFailure } from './broker'
import { utcInstantFromEpochMillis } from '../time'

/** One owner advances raw arrivals, SQL time, and Effect time; database I/O consumes no modeled market time. */
export const makeReplayTimeline = <SourceError, DatabaseError>(
  source: { readonly advanceTo: (atMs: number) => Effect.Effect<void, SourceError> },
  databaseClock: { readonly advanceTo: (instant: string) => Effect.Effect<void, DatabaseError> },
  lastPermittedAtMs: number,
) =>
  Effect.gen(function* () {
    const permit = yield* Semaphore.make(1)
    return (atMs: number) =>
      permit
        .withPermit(
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis
            if (!Number.isSafeInteger(atMs) || atMs < nowMs || atMs > lastPermittedAtMs)
              return yield* new ReplayBrokerFailure({
                message: 'Replay time is outside its declared monotonic session interval',
              })
            yield* source.advanceTo(atMs)
            yield* databaseClock.advanceTo(utcInstantFromEpochMillis(atMs))
            yield* TestClock.setTime(atMs)
          }),
        )
        .pipe(
          Effect.mapError((cause) => new ReplayBrokerFailure({ message: 'Replay timeline could not advance', cause })),
        )
  })

type SessionRuntime<E> = { readonly advance: Effect.Effect<RecoveryFirstCycleAdvance, E>; readonly nextDelayMs: number }

/** Execute every scheduled production command, including the terminal boundary. No entry/close hours are removed. */
export const driveReplaySession = <E>(
  runtime: SessionRuntime<E>,
  advanceTo: (atMs: number) => Effect.Effect<void, ReplayBrokerFailure>,
  firstPollAtMs: number,
  lastPollAtMs: number,
) =>
  Effect.gen(function* () {
    if (
      !Number.isSafeInteger(firstPollAtMs) ||
      !Number.isSafeInteger(lastPollAtMs) ||
      firstPollAtMs > lastPollAtMs ||
      firstPollAtMs < (yield* Clock.currentTimeMillis)
    )
      return yield* new ReplayBrokerFailure({ message: 'Invalid replay session interval' })
    let scheduledAtMs = firstPollAtMs
    let passCount = 0
    let failedPassCount = 0
    while (true) {
      yield* advanceTo(scheduledAtMs)
      const pass = yield* runtime.advance
      passCount++
      if (pass.observation.result === 'FAILURE') failedPassCount++
      const completedAtMs = yield* Clock.currentTimeMillis
      if (completedAtMs < scheduledAtMs)
        return yield* new ReplayBrokerFailure({ message: 'Execution command moved replay time backwards' })
      if (completedAtMs >= lastPollAtMs) break
      const delay = pass.nextDelayMs ?? runtime.nextDelayMs
      if (!Number.isSafeInteger(delay) || delay <= 0)
        return yield* new ReplayBrokerFailure({ message: 'Execution command returned an invalid polling delay' })
      scheduledAtMs = Math.min(completedAtMs + delay, lastPollAtMs)
    }
    return { firstPollAtMs, lastPollAtMs, completedAtMs: yield* Clock.currentTimeMillis, passCount, failedPassCount }
  })
