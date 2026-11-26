import { expect, test } from 'bun:test'
import { Clock, Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { makeReplayTimeline, driveReplaySession, makeStreamingReplaySession } from './session'
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
        true,
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
        true,
      )
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(outcome).toMatchObject({ passCount: 3, failedPassCount: 0, unavailableDecisionPassCount: 3 })
})

test('expected warmup, valid no-trade and lifecycle waits preserve complete decision coverage', async () => {
  const observations: RetainedAutonomousCyclePassObservation[] = [
    ...(
      [
        DecisionReadinessReason.AccountProtection,
        DecisionReadinessReason.TurnoverBudgetExhausted,
        DecisionReadinessReason.LookbackWarmup,
        DecisionReadinessReason.NoEligibleCandidate,
        DecisionReadinessReason.SignalWindowObserved,
      ] as const
    ).map((reason) => ({
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
        true,
      )
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(outcome.unavailableDecisionPassCount).toBe(0)
  expect(outcome.readinessCounts).toEqual({
    ACCOUNT_PROTECTION: 1,
    TURNOVER_BUDGET_EXHAUSTED: 1,
    LOOKBACK_WARMUP: 1,
    NO_ELIGIBLE_CANDIDATE: 1,
    SIGNAL_WINDOW_OBSERVED: 1,
  })
})

test('risk-expiry recovery remains unavailable decision work', async () => {
  const clock = (ms: number) => utcInstantFromEpochMillis(ms)
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(2000)
      return yield* driveReplaySession(
        {
          nextDelayMs: 1,
          advance: Clock.currentTimeMillis.pipe(
            Effect.map((now) => ({
              observation: {
                result: 'SUCCESS' as const,
                outcome: 'RECOVERED' as const,
                recoveryAction: 'WAITING' as const,
                observedAt: clock(now),
                readiness: {
                  reason: DecisionReadinessReason.ExecutionRiskExpired as const,
                  message: 'Risk expired before binding',
                  riskClockRejection: {
                    schemaVersion: 'bayn.intent-risk-clock-rejection.v1' as const,
                    violation: 'EXPIRED' as const,
                    intentId: 'a'.repeat(64),
                    decisionId: 'b'.repeat(64),
                    decidedAt: clock(0),
                    updatedAt: clock(1),
                    expiresAt: clock(1000),
                    checkedAt: clock(now),
                  },
                },
              },
            })),
          ),
        },
        (at) => TestClock.setTime(at),
        2000,
        2002,
        true,
      )
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(outcome).toMatchObject({
    passCount: 3,
    failedPassCount: 0,
    unavailableDecisionPassCount: 3,
    readinessCounts: { EXECUTION_RISK_EXPIRED: 3 },
  })
})

test('UTC reporting windows preserve the pending production poll after measured cleanup', async () => {
  const boundary = Date.parse('2026-10-19T00:00:00.000Z')
  const open = boundary - 30_000
  const close = boundary + 30_000
  const polls: number[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(open)
      const runtime = {
        nextDelayMs: 40_000,
        advance: Clock.currentTimeMillis.pipe(
          Effect.map((at) => {
            polls.push(at)
            return {
              observation: {
                result: 'SUCCESS' as const,
                outcome: 'WINDOW_CLOSED' as const,
                observedAt: utcInstantFromEpochMillis(at),
              },
            }
          }),
        ),
      }
      const first = yield* driveReplaySession(runtime, (at) => TestClock.setTime(at), open, boundary, false)
      expect(polls).toEqual([open])
      expect(first.nextPollAtMs).toBe(open + 40_000)
      yield* TestClock.setTime(boundary + 1)
      const second = yield* driveReplaySession(
        runtime,
        (at) => TestClock.setTime(at),
        Math.max(first.nextPollAtMs, yield* Clock.currentTimeMillis),
        close,
        true,
      )
      expect(polls).toEqual([open, open + 40_000, close])
      expect(second.passCount).toBe(2)
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

test('final reporting does not repeat a command that already completed at the terminal boundary', async () => {
  let calls = 0
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(1000)
      return yield* driveReplaySession(
        {
          nextDelayMs: 265,
          advance: Effect.sync(() => {
            calls++
            return {
              observation: {
                result: 'SUCCESS' as const,
                outcome: 'WINDOW_CLOSED' as const,
                observedAt: utcInstantFromEpochMillis(1000),
              },
            }
          }),
        },
        (at) => TestClock.setTime(at),
        1265,
        1000,
        true,
      )
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(calls).toBe(0)
  expect(result.passCount).toBe(0)
  expect(result.nextPollAtMs).toBe(1265)
})

test('a forced terminal pass reports its actual start when the pending command lies beyond the reporting window', async () => {
  const polls: number[] = []
  const schedule = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      return yield* driveReplaySession(
        {
          nextDelayMs: 1000,
          advance: Clock.currentTimeMillis.pipe(
            Effect.map((at) => {
              polls.push(at)
              return {
                observation: {
                  result: 'SUCCESS' as const,
                  outcome: 'WINDOW_CLOSED' as const,
                  observedAt: utcInstantFromEpochMillis(at),
                },
              }
            }),
          ),
        },
        (at) => TestClock.setTime(at),
        1000,
        10,
        true,
      )
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(polls).toEqual([10])
  expect(schedule).toMatchObject({ firstPollAtMs: 10, lastPollAtMs: 10, completedAtMs: 10, passCount: 1 })
})

const streamingFixture = (arrivals: readonly number[], brokerChanges: readonly number[] = []) => {
  let revision = 0
  let brokerRevision = 0
  const advanceTo = (at: number) =>
    Effect.gen(function* () {
      while ((arrivals[revision] ?? Number.MAX_SAFE_INTEGER) <= at) revision++
      while ((brokerChanges[brokerRevision] ?? Number.MAX_SAFE_INTEGER) <= at) brokerRevision++
      yield* TestClock.setTime(at)
    })
  return {
    advanceTo,
    drive: makeStreamingReplaySession({
      nextAvailableAtMs: Effect.sync(() => {
        const market = arrivals[revision]
        const broker = brokerChanges[brokerRevision]
        return market === undefined ? (broker ?? null) : Math.min(market, broker ?? market)
      }),
      sourceRevision: Effect.sync(() => revision),
      brokerStateHash: Effect.sync(() => String(brokerRevision)),
    }),
  }
}

test('streaming replay waits for arrivals and does not resurrect suppressed hints or invent a final poll', async () => {
  const passes: number[] = []
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const f = streamingFixture([5, 7, 12])
      return yield* f.drive(
        {
          nextDelayMs: 1,
          advance: Clock.currentTimeMillis.pipe(
            Effect.map((at) => {
              passes.push(at)
              return {
                observation: {
                  result: 'SUCCESS' as const,
                  outcome: 'RECOVERED' as const,
                  recoveryAction: 'WAITING' as const,
                  observedAt: utcInstantFromEpochMillis(at),
                  readiness: {
                    reason: DecisionReadinessReason.SignalWindowObserved,
                    message: 'Wait for a new signal window',
                    ...(at === 5 ? { availableAt: utcInstantFromEpochMillis(10) } : {}),
                  },
                },
              }
            }),
          ),
        },
        f.advanceTo,
        0,
        15,
        true,
      )
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(passes).toEqual([0, 5, 12])
  expect(result).toMatchObject({ passCount: 3, completedAtMs: 15, nextPollAtMs: Number.MAX_SAFE_INTEGER })
})

test('broker transitions wake a closed owner while quote-only arrivals remain suppressed', async () => {
  const passes: number[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const f = streamingFixture([3, 5, 9], [7])
      yield* f.drive(
        {
          nextDelayMs: 1,
          advance: Clock.currentTimeMillis.pipe(
            Effect.map((at) => {
              passes.push(at)
              return {
                observation: {
                  result: 'SUCCESS' as const,
                  outcome: 'WINDOW_CLOSED' as const,
                  observedAt: utcInstantFromEpochMillis(at),
                },
              }
            }),
          ),
        },
        f.advanceTo,
        0,
        10,
        true,
      )
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(passes).toEqual([0, 7])
})

test('an early broker wake preserves the original native reconciliation deadline', async () => {
  const passes: number[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const f = streamingFixture([], [5])
      yield* f.drive(
        {
          nextDelayMs: 1,
          advance: Clock.currentTimeMillis.pipe(
            Effect.map((at) => {
              passes.push(at)
              return at < 12
                ? {
                    nextWakeAt: utcInstantFromEpochMillis(at + 12),
                    observation: {
                      result: 'SUCCESS' as const,
                      outcome: 'WAITING' as const,
                      waitReason: 'BROKER_OBSERVATION_PENDING' as const,
                      observedAt: utcInstantFromEpochMillis(at),
                    },
                  }
                : {
                    observation: {
                      result: 'SUCCESS' as const,
                      outcome: 'WINDOW_CLOSED' as const,
                      observedAt: utcInstantFromEpochMillis(at),
                    },
                  }
            }),
          ),
        },
        f.advanceTo,
        0,
        20,
        true,
      )
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(passes).toEqual([0, 5, 12])
})

test('arrivals during native work produce one serialized wake after completion', async () => {
  const passes: number[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const f = streamingFixture([3, 5])
      yield* f.drive(
        {
          nextDelayMs: 1,
          advance: Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            passes.push(at)
            if (at === 0) yield* f.advanceTo(8)
            return {
              observation: {
                result: 'SUCCESS' as const,
                outcome: 'ACQUIRED' as const,
                observedAt: utcInstantFromEpochMillis(at),
              },
            }
          }),
        },
        f.advanceTo,
        0,
        10,
        true,
      )
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(passes).toEqual([0, 8])
})

test('streaming reporting cuts preserve native deadlines and continue consuming arrivals while idle', async () => {
  const passes: number[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const f = streamingFixture([9])
      const runtime = {
        nextDelayMs: 1,
        advance: Clock.currentTimeMillis.pipe(
          Effect.map((at) => {
            passes.push(at)
            return {
              ...(at < 10 ? { nextWakeAt: utcInstantFromEpochMillis(10) } : {}),
              observation: {
                result: 'SUCCESS' as const,
                outcome: 'ACQUIRED' as const,
                observedAt: utcInstantFromEpochMillis(at),
              },
            }
          }),
        ),
      }
      const first = yield* f.drive(runtime, f.advanceTo, 0, 6, false)
      expect(first.nextPollAtMs).toBe(10)
      expect(passes).toEqual([0])
      const second = yield* f.drive(runtime, f.advanceTo, Number.MAX_SAFE_INTEGER, 12, true)
      expect(second.passCount).toBe(2)
      expect(second.nextPollAtMs).toBe(Number.MAX_SAFE_INTEGER)
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(passes).toEqual([0, 9, 10])
})

test('streaming commands admitted before the reporting cut retain measured completion without a post-cut command', async () => {
  const issuedAt: number[] = []
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const f = streamingFixture([8, 9, 12])
      return yield* f.drive(
        {
          nextDelayMs: 1,
          advance: Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            issuedAt.push(at)
            if (at === 8) yield* f.advanceTo(13)
            return {
              observation: {
                result: 'SUCCESS' as const,
                outcome: 'ACQUIRED' as const,
                observedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
              },
            }
          }),
        },
        f.advanceTo,
        0,
        10,
        true,
      )
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(issuedAt).toEqual([0, 8])
  expect(result).toMatchObject({ lastPollAtMs: 10, completedAtMs: 13, passCount: 2 })
})

test('streaming source frontier failures withhold a completed replay', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const drive = makeStreamingReplaySession({
        nextAvailableAtMs: Effect.succeed(0),
        sourceRevision: Effect.succeed(0),
        brokerStateHash: Effect.succeed('unchanged'),
      })

      return yield* Effect.result(
        drive(
          {
            nextDelayMs: 1,
            advance: Effect.succeed({
              observation: { result: 'SUCCESS', outcome: 'ACQUIRED', observedAt: utcInstantFromEpochMillis(0) },
            }),
          },
          (at) => TestClock.setTime(at),
          0,
          10,
          true,
        ),
      )
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(result._tag).toBe('Failure')
})
