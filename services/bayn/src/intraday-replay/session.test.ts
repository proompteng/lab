import { expect, test } from 'bun:test'
import { Clock, Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { makeReplayTimeline, driveReplaySession } from './session'
import { utcInstantFromEpochMillis } from '../time'

test('every market hour and final boundary run at production cadence with delivery latency', async () => {
  const open = Date.parse('2026-09-04T13:30:00Z')
  const close = Date.parse('2026-09-04T20:00:00Z')
  const polls: number[] = []
  const sourceTimes: number[] = []
  const sqlTimes: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(open - 1)
      const advance = yield* makeReplayTimeline(
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
      const advance = yield* makeReplayTimeline(
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
