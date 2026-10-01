import { describe, expect, test } from 'bun:test'
import type { ObjectContext } from '@restatedev/restate-sdk'
import { Clock, Effect, Fiber } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { TestClock } from 'effect/testing'

import { makeBrokerObservationBudget } from '../broker/alpaca/poll-budget'
import { makeBaynBrokerObservations, type BrokerObservationRuntime } from './restate-broker-observations'

const controllerKey = 'a'.repeat(64)
const sourceRevision = 'b'.repeat(40)
const config = { controllerKey, sourceRevision, pollIntervalMs: 10_000, operationTimeoutMs: 30_000 }
type State = { sourceRevision: string; epoch: number; sequence: number; lastSnapshotHash?: string }
const harness = (
  input: {
    runtime?: Partial<BrokerObservationRuntime>
    state?: State
    key?: string
    elapsedMs?: number
    now?: () => Promise<number>
    sleep?: (milliseconds: number) => Promise<void>
  } = {},
) => {
  let state: State | null = input.state ?? null
  let activations = 0
  let polls = 0
  let clockReads = 0
  const sleeps: number[] = []
  const deliveries: Array<{
    parameter: { sourceRevision: string; epoch: number; sequence: number }
    idempotencyKey: string
    delay: { milliseconds: number }
  }> = []
  const object = makeBaynBrokerObservations(config, {
    nextPollNotBeforeMs: input.runtime?.nextPollNotBeforeMs ?? (async () => 0),
    activate:
      input.runtime?.activate ??
      (async () => {
        activations += 1
      }),
    poll:
      input.runtime?.poll ??
      (async () => {
        polls += 1
        return { _tag: 'Published', snapshotHash: 'c'.repeat(64), nextPollNotBeforeMs: 0 }
      }),
  })
  const context = {
    key: input.key ?? controllerKey,
    date: { now: input.now ?? (async () => (clockReads++ % 2 === 0 ? 0 : (input.elapsedMs ?? 0))) },
    console: { warn: () => undefined },
    request: () => ({ attemptCompletedSignal: new AbortController().signal }),
    get: async () => state,
    set: (_key: string, value: State) => {
      state = value
    },
    run: async (_name: string, action: () => Promise<unknown>) => action(),
    sleep: async (duration: { milliseconds: number }) => {
      sleeps.push(duration.milliseconds)
      await input.sleep?.(duration.milliseconds)
    },
    genericSend: (delivery: (typeof deliveries)[number]) => {
      deliveries.push(delivery)
    },
  } as unknown as ObjectContext
  const handlers = (
    object as unknown as {
      object: {
        activate: (ctx: ObjectContext, input: unknown) => Promise<State>
        poll: (ctx: ObjectContext, input: unknown) => Promise<void>
      }
    }
  ).object
  return { handlers, context, deliveries, sleeps, calls: () => ({ activations, polls }), state: () => state }
}

describe('Restate broker observation owner', () => {
  test('publishes before returning activation and schedules only one serial successor', async () => {
    const h = harness()
    const state = await h.handlers.activate(h.context, { sourceRevision })
    expect(state).toEqual({ sourceRevision, epoch: 1, sequence: 1, lastSnapshotHash: 'c'.repeat(64) })
    expect(h.calls()).toEqual({ activations: 1, polls: 1 })
    expect(h.deliveries).toHaveLength(1)
    const delivery = h.deliveries[0]
    if (delivery === undefined) throw new Error('missing durable tick')
    await h.handlers.poll(h.context, delivery.parameter)
    expect(h.calls().polls).toBe(2)
    expect(h.state()?.sequence).toBe(2)
    expect(h.deliveries).toHaveLength(2)
    await h.handlers.poll(h.context, delivery.parameter)
    expect(h.calls().polls).toBe(2)
    expect(h.deliveries).toHaveLength(2)
  })
  test('same revision activation refreshes the cut without changing its epoch or tick identity', async () => {
    const h = harness()
    await h.handlers.activate(h.context, { sourceRevision })
    await h.handlers.activate(h.context, { sourceRevision })
    expect(h.calls()).toEqual({ activations: 1, polls: 2 })
    expect(h.deliveries[0]?.idempotencyKey).toBe(h.deliveries[1]?.idempotencyKey)
    expect(h.state()?.epoch).toBe(1)
  })
  test('repeated activation waits for the background HTTP budget before refreshing', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const execute = Effect.runPromiseWith(yield* Effect.context<never>())
        const budget = yield* makeBrokerObservationBudget
        const starts: number[] = []
        const client = budget.decorate(
          HttpClient.make((request) =>
            Effect.gen(function* () {
              starts.push(yield* Clock.currentTimeMillis)
              return HttpClientResponse.fromWeb(request, new Response('{}'))
            }),
          ),
        )
        const h = harness({
          now: () => execute(Clock.currentTimeMillis),
          sleep: (milliseconds) => execute(Effect.sleep(milliseconds)),
          runtime: {
            nextPollNotBeforeMs: (signal) => execute(budget.nextPollNotBeforeMs, { signal }),
            poll: (signal) =>
              execute(
                Effect.gen(function* () {
                  yield* budget.beginCapture
                  yield* Effect.all(
                    Array.from({ length: 34 }, () => client.get('https://paper-api.alpaca.markets/v2/account')),
                    { concurrency: 2 },
                  )
                  return {
                    _tag: 'Published',
                    snapshotHash: 'c'.repeat(64),
                    nextPollNotBeforeMs: yield* budget.nextPollNotBeforeMs,
                  } as const
                }),
                { signal },
              ),
          },
        })
        yield* Effect.promise(() => h.handlers.activate(h.context, { sourceRevision }))
        for (const capture of [2, 3]) {
          const pending = yield* Effect.promise(() => h.handlers.activate(h.context, { sourceRevision })).pipe(
            Effect.forkChild({ startImmediately: true }),
          )
          yield* TestClock.adjust(20_399)
          expect(starts).toHaveLength((capture - 1) * 34)
          expect(h.deliveries).toHaveLength(capture - 1)
          yield* TestClock.adjust(1)
          yield* Fiber.join(pending)
          expect(starts.slice((capture - 1) * 34)).toEqual(Array.from({ length: 34 }, () => (capture - 1) * 20_400))
        }
        expect(h.state()?.epoch).toBe(1)
        expect(h.deliveries.map((delivery) => delivery.delay.milliseconds)).toEqual([20_400, 20_400, 20_400])
        expect(new Set(h.deliveries.map((delivery) => delivery.idempotencyKey)).size).toBe(1)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  })
  test('waits durably beyond the inactivity bound before starting an activation capture', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const execute = Effect.runPromiseWith(yield* Effect.context<never>())
        const budget = yield* makeBrokerObservationBudget
        const polls: number[] = []
        const requests: number[] = []
        const client = budget.decorate(
          HttpClient.make((request) =>
            Effect.gen(function* () {
              requests.push(yield* Clock.currentTimeMillis)
              return HttpClientResponse.fromWeb(
                request,
                new Response('{}', { headers: { 'x-ratelimit-limit': '100' } }),
              )
            }),
          ),
        )
        const h = harness({
          now: () => execute(Clock.currentTimeMillis),
          sleep: (milliseconds) => execute(Effect.sleep(milliseconds)),
          runtime: {
            nextPollNotBeforeMs: (signal) => execute(budget.nextPollNotBeforeMs, { signal }),
            poll: (signal) =>
              execute(
                Effect.gen(function* () {
                  polls.push(yield* Clock.currentTimeMillis)
                  yield* budget.beginCapture
                  yield* Effect.all(
                    Array.from({ length: 52 }, () => client.get('https://paper-api.alpaca.markets/v2/account')),
                    { concurrency: 2 },
                  )
                  return {
                    _tag: 'Published',
                    snapshotHash: 'c'.repeat(64),
                    nextPollNotBeforeMs: yield* budget.nextPollNotBeforeMs,
                  } as const
                }),
                { signal },
              ),
          },
        })
        yield* Effect.promise(() => h.handlers.activate(h.context, { sourceRevision }))
        const pending = yield* Effect.promise(() => h.handlers.activate(h.context, { sourceRevision })).pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        yield* TestClock.adjust(config.operationTimeoutMs * 2)
        expect(h.sleeps).toEqual([62_400])
        expect(polls).toEqual([0])
        expect(requests).toHaveLength(52)
        yield* TestClock.adjust(2_400)
        expect((yield* Fiber.join(pending)).lastSnapshotHash).toBe('c'.repeat(64))
        expect(polls).toEqual([0, 62_400])
        expect(requests.slice(52)).toEqual(Array.from({ length: 52 }, () => 62_400))
        expect(h.deliveries.map((delivery) => delivery.delay.milliseconds)).toEqual([62_400, 62_400])
        expect(h.state()?.epoch).toBe(1)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  })
  test('rotation revokes old epochs and survives reconstruction from durable state', async () => {
    const h = harness({ state: { sourceRevision: 'd'.repeat(40), epoch: 7, sequence: 19 } })
    await h.handlers.activate(h.context, { sourceRevision })
    expect(h.state()?.epoch).toBe(8)
    await h.handlers.poll(h.context, { sourceRevision: 'd'.repeat(40), epoch: 7, sequence: 19 })
    expect(h.calls().polls).toBe(1)
    const state = h.state()
    if (state === null) throw new Error('missing durable observation state')
    const restarted = harness({ state })
    await restarted.handlers.poll(restarted.context, { sourceRevision, epoch: 8, sequence: 1 })
    expect(restarted.calls()).toEqual({ activations: 0, polls: 1 })
    expect(restarted.state()?.sequence).toBe(2)
  })
  test('failed polls omit readiness and keep the background loop progressing', async () => {
    let failures = true
    const h = harness({
      runtime: {
        poll: async () =>
          failures
            ? { _tag: 'Unavailable', nextPollNotBeforeMs: 0 }
            : { _tag: 'Published', snapshotHash: 'e'.repeat(64), nextPollNotBeforeMs: 0 },
      },
    })
    expect((await h.handlers.activate(h.context, { sourceRevision })).lastSnapshotHash).toBeUndefined()
    failures = false
    await h.handlers.poll(h.context, { sourceRevision, epoch: 1, sequence: 1 })
    expect(h.state()?.lastSnapshotHash).toBe('e'.repeat(64))
    failures = true
    await h.handlers.poll(h.context, { sourceRevision, epoch: 1, sequence: 2 })
    expect(h.state()?.lastSnapshotHash).toBeUndefined()
    expect(h.state()?.sequence).toBe(3)
    expect(h.deliveries.map((delivery) => delivery.delay.milliseconds)).toEqual([10_000, 10_000, 10_000])
  })
  test.each([250, 9_500, 40_000])('includes a %s ms capture in the poll cadence', async (elapsedMs) => {
    const h = harness({ elapsedMs })
    await h.handlers.activate(h.context, { sourceRevision })
    await h.handlers.poll(h.context, { sourceRevision, epoch: 1, sequence: 1 })
    expect(h.deliveries).toHaveLength(2)
    expect(h.deliveries.map((delivery) => delivery.delay.milliseconds)).toEqual([
      Math.max(1_000, config.pollIntervalMs - elapsedMs),
      Math.max(1_000, config.pollIntervalMs - elapsedMs),
    ])
  })
  test('retries an invalidated publication after the consistency window instead of the regular poll interval', async () => {
    const h = harness({
      runtime: { poll: async () => ({ _tag: 'Invalidated', nextPollNotBeforeMs: 0 }) },
      elapsedMs: 250,
    })
    await h.handlers.activate(h.context, { sourceRevision })
    expect(h.deliveries[0]?.delay.milliseconds).toBe(1_000)
    expect(h.state()?.lastSnapshotHash).toBeUndefined()
    await h.handlers.poll(h.context, { sourceRevision, epoch: 1, sequence: 1 })
    expect(h.state()?.lastSnapshotHash).toBeUndefined()
    expect(h.deliveries[1]?.delay.milliseconds).toBe(1_000)
  })
  test('returns to the regular cadence once a raced publication succeeds', async () => {
    let invalidated = true
    const h = harness({
      runtime: {
        poll: async () =>
          invalidated
            ? { _tag: 'Invalidated', nextPollNotBeforeMs: 0 }
            : { _tag: 'Published', snapshotHash: 'f'.repeat(64), nextPollNotBeforeMs: 0 },
      },
      elapsedMs: 250,
    })
    await h.handlers.activate(h.context, { sourceRevision })
    invalidated = false
    await h.handlers.poll(h.context, { sourceRevision, epoch: 1, sequence: 1 })
    expect(h.state()?.lastSnapshotHash).toBe('f'.repeat(64))
    expect(h.deliveries.map((delivery) => delivery.delay.milliseconds)).toEqual([1_000, 9_750])
    await h.handlers.poll(h.context, { sourceRevision, epoch: 1, sequence: 1 })
    expect(h.deliveries).toHaveLength(2)
  })
  test.each(['Published', 'Invalidated', 'Unavailable'] as const)(
    'preserves the HTTP budget deadline for a %s capture',
    async (tag) => {
      const h = harness({
        runtime: {
          poll: async () =>
            tag === 'Published'
              ? { _tag: tag, snapshotHash: 'f'.repeat(64), nextPollNotBeforeMs: 20_400 }
              : { _tag: tag, nextPollNotBeforeMs: 20_400 },
        },
        elapsedMs: 1_000,
      })
      await h.handlers.activate(h.context, { sourceRevision })
      await h.handlers.poll(h.context, { sourceRevision, epoch: 1, sequence: 1 })
      expect(h.deliveries.map((delivery) => delivery.delay.milliseconds)).toEqual([19_400, 19_400])
    },
  )
  test.each([{ sourceRevision: 'd'.repeat(40) }, { sourceRevision, interval: 1 }])(
    'rejects foreign revision or extra activation fields',
    async (input) => {
      const h = harness()
      const failure = await h.handlers.activate(h.context, input).catch((cause: unknown) => cause)
      expect(failure).toBeInstanceOf(Error)
      expect(h.calls()).toEqual({ activations: 0, polls: 0 })
    },
  )
  test('rejects a foreign account key without reading credentials or polling', async () => {
    const h = harness({ key: 'foreign-account' })
    const failure = await h.handlers.activate(h.context, { sourceRevision }).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain('account binding mismatch')
    expect(h.calls()).toEqual({ activations: 0, polls: 0 })
  })
})
