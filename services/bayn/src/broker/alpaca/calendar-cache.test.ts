import { describe, expect, test } from 'bun:test'
import { Cause, Clock, Effect, Exit, Fiber, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { makePassMarketCalendarRead } from './calendar-cache'
import { BrokerReadError, BrokerReadErrorKind } from './failures'
import { decodeMarketCalendarQuery, type MarketCalendarQuery } from './model'
import { normalizeMarketCalendarResult } from './normalizers'

const query = { start: '2026-11-06', end: '2026-12-06' }
const now = Date.parse('2026-11-06T15:00:00.000Z')
const raw = [
  { date: '2026-11-06', open: '09:30', close: '16:00', session_open: '0400', session_close: '2000' },
] as const
const response = (range: MarketCalendarQuery) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((at) => ({
      value: Result.getOrThrow(normalizeMarketCalendarResult(raw, Result.getOrThrow(decodeMarketCalendarQuery(range)))),
      evidence: {
        requestId: 'calendar-request',
        status: 200,
        contentHash: 'a'.repeat(64),
        observedAt: new Date(at).toISOString(),
      },
    })),
  )
const unavailable = new BrokerReadError({
  operation: 'market-calendar',
  kind: BrokerReadErrorKind.Timeout,
  retryable: true,
  message: 'calendar fixture unavailable',
})

describe('pass-owned market calendar reads', () => {
  test('reuses the exact observation without changing evidence or sharing mutable return values', async () => {
    await Effect.gen(function* () {
      yield* TestClock.setTime(now)
      let calls = 0
      const read = yield* makePassMarketCalendarRead((range) =>
        Effect.sync(() => calls++).pipe(Effect.andThen(response(range))),
      )
      const requested = { ...query }
      const first = yield* read(requested)
      const expected = structuredClone(first)
      Reflect.set(requested, 'end', '2026-11-07')
      Reflect.set(first.value.requestedRange, 'start', 'caller-mutated')
      Reflect.set(first.value.sessions[0] ?? {}, 'closeAt', 'caller-mutated')
      Reflect.set(first.evidence, 'observedAt', 'caller-mutated')
      yield* TestClock.adjust(1_000)
      const second = yield* read(query)
      expect(second).toEqual(expected)
      Reflect.set(second.value.providerSessions[0] ?? {}, 'regularCloseAt', 'caller-mutated')
      expect(yield* read(query)).toEqual(expected)
      expect(calls).toBe(1)
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)
  })

  test('different and malformed query ranges cannot hit a retained observation', async () => {
    await Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const queries: MarketCalendarQuery[] = []
      const read = yield* makePassMarketCalendarRead((range) =>
        Effect.sync(() => queries.push(range)).pipe(Effect.andThen(response(range))),
      )
      yield* read(query)
      const malformed = { ...query, unsupported: true }
      for (const invalid of [malformed, { start: query.end, end: query.start }, { ...query, end: '2026-12-07' }]) {
        const result = yield* Effect.result(read(invalid))
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isSuccess(result)) throw new Error('invalid calendar query unexpectedly succeeded')
        expect(result.failure.kind).toBe(BrokerReadErrorKind.InvalidRequest)
      }
      expect(queries).toHaveLength(1)
      const other = { ...query, end: '2026-11-07' }
      expect((yield* read(other)).value.requestedRange).toEqual(other)
      yield* read(query)
      expect(queries).toEqual([query, other, query])
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)
  })

  test.each([
    '2026-11-06T09:00:00.000Z',
    '2026-11-06T13:00:00.000Z',
    '2026-11-06T14:30:00.000Z',
    '2026-11-06T21:00:00.000Z',
    '2026-11-06T22:00:00.000Z',
    '2026-11-07T00:00:00.000Z',
    '2026-11-07T01:00:00.000Z',
  ])('refreshes exactly at the session or UTC boundary %s', async (boundary) => {
    await Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(boundary) - 1_000)
      let calls = 0
      const read = yield* makePassMarketCalendarRead((range) =>
        Effect.sync(() => calls++).pipe(Effect.andThen(response(range))),
      )
      const original = yield* read(query)
      yield* TestClock.adjust(999)
      expect(yield* read(query)).toEqual(original)
      expect(calls).toBe(1)
      yield* TestClock.adjust(1)
      expect((yield* read(query)).evidence.observedAt).toBe(boundary)
      expect(calls).toBe(2)
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)
  })

  test('does not retain a fetch that crosses a session boundary', async () => {
    await Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse('2026-11-06T21:00:00.000Z') - 500)
      let calls = 0
      const read = yield* makePassMarketCalendarRead((range) =>
        Effect.gen(function* () {
          calls++
          if (calls === 1) yield* Effect.sleep(1_000)
          return yield* response(range)
        }),
      )
      const pending = yield* read(query).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust(1_000)
      yield* Fiber.join(pending)
      yield* read(query)
      expect(calls).toBe(2)
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)
  })

  test.each([0, 1_000])('refreshes after a clock rollback following %s ms of reuse', async (elapsed) => {
    await Effect.gen(function* () {
      yield* TestClock.setTime(now)
      let calls = 0
      const read = yield* makePassMarketCalendarRead((range) =>
        Effect.sync(() => calls++).pipe(Effect.andThen(response(range))),
      )
      yield* read(query)
      yield* TestClock.adjust(elapsed)
      yield* read(query)
      expect(calls).toBe(1)
      yield* TestClock.setTime(now + elapsed - 1)
      expect((yield* read(query)).evidence.observedAt).toBe(new Date(now + elapsed - 1).toISOString())
      expect(calls).toBe(2)
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)
  })

  test.each(['failure', 'defect'] as const)('does not retain a %s or restore an expired result', async (kind) => {
    await Effect.gen(function* () {
      const boundary = Date.parse('2026-11-06T21:00:00.000Z')
      yield* TestClock.setTime(boundary - 1)
      let calls = 0
      const read = yield* makePassMarketCalendarRead((range) =>
        Effect.gen(function* () {
          calls++
          if (calls === 2) return yield* kind === 'failure' ? Effect.fail(unavailable) : Effect.die(unavailable)
          return yield* response(range)
        }),
      )
      yield* read(query)
      yield* TestClock.adjust(1)
      const result = yield* Effect.exit(read(query))
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isSuccess(result)) throw new Error('calendar refresh unexpectedly succeeded')
      if (kind === 'failure') expect(Cause.findErrorOption(result.cause)).toEqual(Option.some(unavailable))
      else expect(Cause.findDefect(result.cause)).toEqual(Result.succeed(unavailable))
      yield* TestClock.setTime(boundary - 1)
      yield* read(query)
      expect(calls).toBe(3)
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)
  })

  test('shares one in-flight successful read across concurrent callers', async () => {
    await Effect.gen(function* () {
      yield* TestClock.setTime(now)
      let calls = 0
      let finalized = 0
      const read = yield* makePassMarketCalendarRead((range) =>
        Effect.gen(function* () {
          calls++
          yield* Effect.sleep(1_000)
          return yield* response(range)
        }).pipe(Effect.ensuring(Effect.sync(() => finalized++))),
      )
      const pending = yield* Effect.all([read(query), read(query), read(query)], { concurrency: 'unbounded' }).pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust(1_000)
      const results = yield* Fiber.join(pending)
      expect(calls).toBe(1)
      expect(finalized).toBe(1)
      expect(results[0]).toEqual(results[1])
      expect(results[1]).toEqual(results[2])
      expect(results[0]).not.toBe(results[1])
      expect(results[1]).not.toBe(results[2])
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)
  })

  test('interrupting a waiter does not cancel its active reader or leak a permit', async () => {
    await Effect.gen(function* () {
      yield* TestClock.setTime(now)
      let calls = 0
      let interrupted = 0
      let finalized = 0
      const read = yield* makePassMarketCalendarRead((range) =>
        Effect.gen(function* () {
          calls++
          yield* Effect.sleep(1_000)
          return yield* response(range)
        }).pipe(
          Effect.onInterrupt(() => Effect.sync(() => interrupted++)),
          Effect.ensuring(Effect.sync(() => finalized++)),
        ),
      )
      const owner = yield* read(query).pipe(Effect.forkChild({ startImmediately: true }))
      const waiter = yield* read(query).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Fiber.interrupt(waiter)
      yield* TestClock.adjust(1_000)
      const result = yield* Fiber.join(owner)
      expect(yield* read(query)).toEqual(result)
      expect(calls).toBe(1)
      expect(interrupted).toBe(0)
      expect(finalized).toBe(1)
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)
  })

  test.each(['interrupt', 'timeout'] as const)(
    'cancels an active %s and allows a waiting caller to refresh',
    async (kind) => {
      await Effect.gen(function* () {
        yield* TestClock.setTime(now)
        let calls = 0
        let interrupted = 0
        let finalized = 0
        const read = yield* makePassMarketCalendarRead((range) =>
          Effect.gen(function* () {
            calls++
            if (calls === 1) return yield* Effect.never
            return yield* response(range)
          }).pipe(
            Effect.onInterrupt(() => Effect.sync(() => interrupted++)),
            Effect.ensuring(Effect.sync(() => finalized++)),
          ),
        )
        const first = read(query)
        const owner = yield* (
          kind === 'timeout'
            ? first.pipe(Effect.timeoutOrElse({ duration: 5_000, orElse: () => Effect.fail(unavailable) }))
            : first
        ).pipe(Effect.forkChild({ startImmediately: true }))
        const waiter = yield* read(query).pipe(Effect.forkChild({ startImmediately: true }))
        if (kind === 'timeout') yield* TestClock.adjust(5_000)
        else yield* Fiber.interrupt(owner)
        const exit = yield* Fiber.await(owner)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) throw new Error('canceled calendar unexpectedly succeeded')
        expect(
          kind === 'timeout' ? Option.isSome(Cause.findErrorOption(exit.cause)) : Cause.hasInterrupts(exit.cause),
        ).toBe(true)
        const result = yield* Fiber.join(waiter)
        expect(yield* read(query)).toEqual(result)
        expect(calls).toBe(2)
        expect(interrupted).toBe(1)
        expect(finalized).toBe(2)
      }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)
    },
  )
})
