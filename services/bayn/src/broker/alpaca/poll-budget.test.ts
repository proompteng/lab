import { describe, expect, test } from 'bun:test'
import { Clock, Effect, Fiber, Result, Schedule } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { TestClock } from 'effect/testing'

import { makeBrokerObservationBudget } from './poll-budget'

const url = 'https://paper-api.alpaca.markets/v2/account'
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())))
const transport = (
  options: (attempt: number) => { readonly status?: number; readonly headers?: Record<string, string> } = () => ({}),
  latencyMs = 0,
) => {
  const starts: number[] = []
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      starts.push(yield* Clock.currentTimeMillis)
      const response = options(starts.length)
      yield* Effect.sleep(latencyMs)
      return HttpClientResponse.fromWeb(request, new Response('{}', { status: 200, ...response }))
    }),
  )
  return { client, starts }
}

describe('broker observation HTTP budget', () => {
  test.each([14, 34, 52])('charges every attempt in a %s-call paginated capture to its next poll', async (count) => {
    await run(
      Effect.gen(function* () {
        const budget = yield* makeBrokerObservationBudget
        const source = transport()
        const client = budget.decorate(source.client)
        const pending = yield* Effect.all(
          Array.from({ length: count }, () => client.get(url)),
          { concurrency: 2 },
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust(count * 600)
        yield* Fiber.join(pending)
        expect(source.starts).toEqual(Array.from({ length: count }, () => 0))
        expect(yield* budget.nextPollNotBeforeMs).toBe(count * 600)
      }),
    )
  })
  test('preserves unpaid request cost across captures and starts a new budget after it elapses', async () => {
    await run(
      Effect.gen(function* () {
        const budget = yield* makeBrokerObservationBudget
        const source = transport()
        const client = budget.decorate(source.client)
        yield* budget.beginCapture
        yield* Effect.all(
          Array.from({ length: 34 }, () => client.get(url)),
          { concurrency: 2 },
        )
        expect(yield* budget.nextPollNotBeforeMs).toBe(20_400)
        const early = yield* budget.beginCapture.pipe(
          Effect.andThen(client.get(url)),
          Effect.forkChild({ startImmediately: true }),
        )
        yield* TestClock.adjust(20_399)
        expect(source.starts).toHaveLength(34)
        expect(yield* budget.nextPollNotBeforeMs).toBe(20_400)
        yield* TestClock.adjust(1)
        yield* Fiber.join(early)
        expect(source.starts[34]).toBe(20_400)
        expect(yield* budget.nextPollNotBeforeMs).toBe(21_000)
        yield* TestClock.adjust(9_600)
        yield* budget.beginCapture
        yield* client.get(url)
        expect(yield* budget.nextPollNotBeforeMs).toBe(30_600)
      }),
    )
  })
  test('interrupting an early capture preserves its outstanding request cost', async () => {
    await run(
      Effect.gen(function* () {
        const budget = yield* makeBrokerObservationBudget
        const source = transport()
        const client = budget.decorate(source.client)
        yield* budget.beginCapture
        yield* Effect.all(
          Array.from({ length: 34 }, () => client.get(url)),
          { concurrency: 2 },
        )
        const cancelled = yield* budget.beginCapture.pipe(
          Effect.andThen(client.get(url)),
          Effect.timeout(5_000),
          Effect.result,
          Effect.forkChild({ startImmediately: true }),
        )
        yield* TestClock.adjust(5_000)
        expect(Result.isFailure(yield* Fiber.join(cancelled))).toBe(true)
        expect(source.starts).toHaveLength(34)
        expect(yield* budget.nextPollNotBeforeMs).toBe(20_400)
        const resumed = yield* budget.beginCapture.pipe(
          Effect.andThen(client.get(url)),
          Effect.forkChild({ startImmediately: true }),
        )
        yield* TestClock.adjust(15_399)
        expect(source.starts).toHaveLength(34)
        yield* TestClock.adjust(1)
        yield* Fiber.join(resumed)
        expect(source.starts[34]).toBe(20_400)
        expect(yield* budget.nextPollNotBeforeMs).toBe(21_000)
      }),
    )
  })
  test('preserves capture concurrency instead of spacing network requests', async () => {
    await run(
      Effect.gen(function* () {
        const budget = yield* makeBrokerObservationBudget
        const source = transport(() => ({}), 5_000)
        const client = budget.decorate(source.client)
        const pending = yield* Effect.all([client.get(url), client.get(url)], { concurrency: 2 }).pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        yield* TestClock.adjust(600)
        expect(source.starts).toEqual([0, 0])
        yield* TestClock.adjust(5_000)
        yield* Fiber.join(pending)
      }),
    )
  })
  test('charges actual transient retry attempts to the next poll', async () => {
    await run(
      Effect.gen(function* () {
        const budget = yield* makeBrokerObservationBudget
        const source = transport((attempt) => ({ status: attempt === 1 ? 503 : 200 }))
        const client = budget
          .decorate(source.client)
          .pipe(HttpClient.retryTransient({ times: 1, schedule: Schedule.spaced(1) }))
        const pending = yield* client.get(url).pipe(Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust(600)
        expect((yield* Fiber.join(pending)).status).toBe(200)
        expect(source.starts).toEqual([0, 1])
        expect(yield* budget.nextPollNotBeforeMs).toBe(1_200)
      }),
    )
  })
  test.each([
    {
      name: 'account reserve',
      status: 200,
      headers: { 'x-ratelimit-limit': '200', 'x-ratelimit-remaining': '50', 'x-ratelimit-reset': '60' },
      resetMs: 60_000,
    },
    { name: '429 Retry-After seconds', status: 429, headers: { 'retry-after': '75' }, resetMs: 75_000 },
    {
      name: '429 Retry-After HTTP date',
      status: 429,
      headers: { 'retry-after': new Date(75_000).toUTCString() },
      resetMs: 75_000,
    },
    {
      name: '429 without usable headers',
      status: 429,
      headers: { 'x-ratelimit-reset': 'garbage', 'retry-after': 'NaN' },
      resetMs: 60_000,
    },
    { name: 'exhausted quota without reset', status: 200, headers: { 'x-ratelimit-remaining': '0' }, resetMs: 60_000 },
  ])('defers background reads for $name', async ({ status, headers, resetMs }) => {
    await run(
      Effect.gen(function* () {
        const budget = yield* makeBrokerObservationBudget
        const source = transport((attempt) => (attempt === 1 ? { status, headers } : {}))
        const client = budget.decorate(source.client)
        yield* client.get(url)
        expect(yield* budget.nextPollNotBeforeMs).toBe(resetMs)
        const pending = yield* client.get(url).pipe(Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust(resetMs - 1)
        expect(source.starts).toEqual([0])
        yield* TestClock.adjust(1)
        yield* Fiber.join(pending)
        expect(source.starts).toEqual([0, resetMs])
      }),
    )
  })
  test('retains a smaller reported limit across responses without quota headers', async () => {
    await run(
      Effect.gen(function* () {
        const budget = yield* makeBrokerObservationBudget
        const source = transport((attempt) => (attempt === 1 ? { headers: { 'x-ratelimit-limit': '100' } } : {}))
        const client = budget.decorate(source.client)
        const pending = yield* Effect.forEach([1, 2, 3], () => client.get(url)).pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        yield* TestClock.adjust(2_400)
        yield* Fiber.join(pending)
        expect(source.starts).toEqual([0, 0, 0])
        expect(yield* budget.nextPollNotBeforeMs).toBe(3_600)
      }),
    )
  })
  test('charges every resumed history page after a quota reset to the next capture', async () => {
    await run(
      Effect.gen(function* () {
        const budget = yield* makeBrokerObservationBudget
        const source = transport((attempt) =>
          attempt === 1
            ? { headers: { 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '25', 'x-ratelimit-reset': '60' } }
            : {},
        )
        const client = budget.decorate(source.client)
        yield* budget.beginCapture
        yield* client.get(url)
        const remainingPages = yield* Effect.all(
          Array.from({ length: 51 }, () => client.get(url)),
          { concurrency: 2 },
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust(59_999)
        expect(source.starts).toEqual([0])
        yield* TestClock.adjust(1)
        yield* Fiber.join(remainingPages)
        expect(source.starts.slice(1)).toEqual(Array.from({ length: 51 }, () => 60_000))
        expect(yield* budget.nextPollNotBeforeMs).toBe(121_200)
        const next = yield* budget.beginCapture.pipe(
          Effect.andThen(client.get(url)),
          Effect.forkChild({ startImmediately: true }),
        )
        yield* TestClock.adjust(61_199)
        expect(source.starts).toHaveLength(52)
        yield* TestClock.adjust(1)
        yield* Fiber.join(next)
        expect(source.starts[52]).toBe(121_200)
        expect(yield* budget.nextPollNotBeforeMs).toBe(122_400)
      }),
    )
  })
  test('a short quota wait preserves request cost that has not elapsed', async () => {
    await run(
      Effect.gen(function* () {
        const budget = yield* makeBrokerObservationBudget
        const source = transport((attempt) =>
          attempt === 34 ? { headers: { 'x-ratelimit-remaining': '50', 'x-ratelimit-reset': '1' } } : {},
        )
        const client = budget.decorate(source.client)
        yield* budget.beginCapture
        yield* Effect.all(
          Array.from({ length: 34 }, () => client.get(url)),
          { concurrency: 2 },
        )
        const resumed = yield* client.get(url).pipe(Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust(999)
        expect(source.starts).toHaveLength(34)
        yield* TestClock.adjust(1)
        yield* Fiber.join(resumed)
        expect(source.starts[34]).toBe(1_000)
        expect(yield* budget.nextPollNotBeforeMs).toBe(21_000)
      }),
    )
  })
  test('capture cancellation and client replacement preserve the quota reset', async () => {
    await run(
      Effect.gen(function* () {
        const budget = yield* makeBrokerObservationBudget
        const first = transport(() => ({ headers: { 'x-ratelimit-remaining': '50', 'x-ratelimit-reset': '60' } }))
        const client = budget.decorate(first.client)
        yield* client.get(url)
        const cancelled = yield* client
          .get(url)
          .pipe(Effect.timeout(30_000), Effect.result, Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust(30_000)
        expect(Result.isFailure(yield* Fiber.join(cancelled))).toBe(true)
        expect(first.starts).toEqual([0])
        expect(yield* budget.nextPollNotBeforeMs).toBe(60_000)
        const replacement = transport()
        const pending = yield* budget
          .decorate(replacement.client)
          .get(url)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust(29_999)
        expect(replacement.starts).toEqual([])
        yield* TestClock.adjust(1)
        yield* Fiber.join(pending)
        expect(replacement.starts).toEqual([60_000])
      }),
    )
  })
})
