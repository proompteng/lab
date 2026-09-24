import { expect, test } from 'bun:test'
import { Clock, Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { makeReplayTimeline, driveReplaySession } from './session'
import { utcInstantFromEpochMillis } from '../time'
import { DecisionReadinessReason } from '../cycle/runner/readiness'
import type { RetainedAutonomousCyclePassObservation } from '../cycle/runner/pass-observation'

test('deadline advancement leaves arrivals unpublished until the next source boundary', async () => {
  const sourceTimes: number[] = []
  const sqlTimes: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(100)
      const timeline = yield* makeReplayTimeline(
        {
          advanceTo: (at) =>
            Effect.sync(() => {
              sourceTimes.push(at)
            }),
        },
        {
          advanceTo: (at) =>
            Effect.sync(() => {
              sqlTimes.push(at)
            }),
        },
        200,
      )
      yield* timeline.advanceDeadlineTo(150)
      expect(yield* Clock.currentTimeMillis).toBe(150)
      expect(sourceTimes).toEqual([])
      expect(sqlTimes).toEqual([utcInstantFromEpochMillis(150)])
      yield* timeline.advanceTo(150)
      expect(sourceTimes).toEqual([150])
      expect((yield* Effect.exit(timeline.advanceDeadlineTo(149)))._tag).toBe('Failure')
      expect((yield* Effect.exit(timeline.advanceDeadlineTo(201)))._tag).toBe('Failure')
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

test('every market hour and final boundary run at production cadence with delivery latency', async () => {
  const open = Date.parse('2026-09-04T13:30:00Z')
  const close = Date.parse('2026-09-04T20:00:00Z')
  const polls: number[] = []
  const sourceTimes: number[] = []
  const sqlTimes: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(open - 1)
      const { advanceTo: advance } = yield* makeReplayTimeline(
        {
          advanceTo: (at) =>
            Effect.sync(() => {
              sourceTimes.push(at)
            }),
        },
        {
          advanceTo: (at) =>
            Effect.sync(() => {
              sqlTimes.push(at)
            }),
        },
        close,
      )
      const outcome = yield* driveReplaySession(
        {
          nextDelayMs: 60_000,
          advance: Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            polls.push(at)
            if (at === open) yield* advance(at + 100)
            return {
              observation: {
                result: 'SUCCESS' as const,
                outcome: 'WINDOW_CLOSED' as const,
                observedAt: utcInstantFromEpochMillis(at),
              },
            }
          }),
        },
        advance,
        open,
        close,
      )
      expect(polls[0]).toBe(open)
      expect(polls[1]).toBe(open + 60_100)
      expect(polls.at(-1)).toBe(close)
      expect(outcome.passCount).toBe(391)
      expect(outcome.failedPassCount).toBe(0)
      expect(sourceTimes[1]).toBe(open + 100)
      expect(sqlTimes).toEqual(sourceTimes.map(utcInstantFromEpochMillis))
      expect((yield* Effect.exit(advance(close + 1)))._tag).toBe('Failure')
      expect((yield* Effect.exit(advance(open)))._tag).toBe('Failure')
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

test('source advancement failure cannot advance SQL or Effect clocks', async () => {
  let wroteSql = false
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(100)
      const { advanceTo: advance } = yield* makeReplayTimeline(
        { advanceTo: () => Effect.fail(new Error('source failed')) },
        {
          advanceTo: () =>
            Effect.sync(() => {
              wroteSql = true
            }),
        },
        200,
      )
      const exit = yield* Effect.exit(advance(150))
      return { exit, now: yield* Clock.currentTimeMillis }
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(result.exit._tag).toBe('Failure')
  expect(result.now).toBe(100)
  expect(wroteSql).toBe(false)
})

test('unavailable decision evidence is counted separately from lifecycle waits and valid no-trade', async () => {
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      return yield* driveReplaySession(
        {
          nextDelayMs: 1,
          advance: Clock.currentTimeMillis.pipe(
            Effect.map((at) => ({
              observation: {
                result: 'SUCCESS' as const,
                outcome: 'RECOVERED' as const,
                recoveryAction: 'WAITING' as const,
                observedAt: utcInstantFromEpochMillis(at),
                readiness: {
                  reason: DecisionReadinessReason.SnapshotUnavailable,
                  message: 'Required benchmark input is missing',
                },
              },
            })),
          ),
        },
        (at) => TestClock.setTime(at),
        0,
        2,
      )
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(outcome).toMatchObject({ passCount: 3, failedPassCount: 0, unavailableDecisionPassCount: 3 })
})

test('expected warmup, valid no-trade and lifecycle waits preserve complete decision coverage', async () => {
  const observations: RetainedAutonomousCyclePassObservation[] = [
    ...[
      DecisionReadinessReason.LookbackWarmup,
      DecisionReadinessReason.NoEligibleCandidate,
      DecisionReadinessReason.SignalWindowObserved,
    ].map((reason) => ({
      result: 'SUCCESS' as const,
      outcome: 'RECOVERED' as const,
      recoveryAction: 'WAITING' as const,
      observedAt: utcInstantFromEpochMillis(0),
      readiness: { reason, message: 'Expected decision state' },
    })),
    {
      result: 'SUCCESS',
      outcome: 'RECOVERED',
      recoveryAction: 'WAITING',
      observedAt: utcInstantFromEpochMillis(0),
      waitReason: 'open-position',
    },
    { result: 'SUCCESS', outcome: 'RECOVERED', recoveryAction: 'NO_TRADE', observedAt: utcInstantFromEpochMillis(0) },
  ]
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      return yield* driveReplaySession(
        {
          nextDelayMs: 1,
          advance: Clock.currentTimeMillis.pipe(
            Effect.map((at) => {
              const observation = observations[at]
              if (observation === undefined) throw new Error('Unexpected poll')
              return { observation }
            }),
          ),
        },
        (at) => TestClock.setTime(at),
        0,
        observations.length - 1,
      )
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(outcome.unavailableDecisionPassCount).toBe(0)
  expect(outcome.readinessCounts).toEqual({ LOOKBACK_WARMUP: 1, NO_ELIGIBLE_CANDIDATE: 1, SIGNAL_WINDOW_OBSERVED: 1 })
})
