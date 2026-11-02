import { describe, expect, test } from 'bun:test'
import type { ObjectContext } from '@restatedev/restate-sdk'
import { Effect } from 'effect'

import { BrokerReadError, BrokerReadErrorKind } from '../broker/alpaca/failures'
import { settleCompletedBrokerObservationPoll } from '../composition/broker-observation-runtime'
import {
  makeBaynBrokerObservations,
  type BrokerObservationPoll,
  type BrokerObservationRuntime,
} from './restate-broker-observations'

const controllerKey = 'a'.repeat(64)
const sourceRevision = 'b'.repeat(40)
const config = { controllerKey, sourceRevision, pollIntervalMs: 10_000, operationTimeoutMs: 30_000 }
type TestRuntime = Omit<Partial<BrokerObservationRuntime>, 'poll'> & {
  poll?: (signal: AbortSignal, reservation: { captureId: string }) => Promise<BrokerObservationPoll>
}
type State = { sourceRevision: string; epoch: number; sequence: number; lastSnapshotHash?: string }
const harness = (
  input: {
    runtime?: TestRuntime
    state?: State
    key?: string
    elapsedMs?: number
    now?: () => Promise<number>
    sleep?: (milliseconds: number) => Promise<void>
    budgetDeadline?: number
    quotaDeadline?: number
    runResults?: Map<string, unknown>
    losePollResult?: 'before-journal' | 'after-journal'
  } = {},
) => {
  let state: State | null = input.state ?? null
  let budgetDeadline = input.budgetDeadline ?? null
  let quotaDeadline = input.quotaDeadline ?? 0
  let activations = 0
  let polls = 0
  let now = 0
  const sleeps: number[] = []
  const commands: string[] = []
  const deliveries: Array<{
    parameter: { sourceRevision: string; epoch: number; sequence: number }
    idempotencyKey: string
    delay: { milliseconds: number }
  }> = []
  const object = makeBaynBrokerObservations(
    config,
    {
      activate: async (signal, deadline) => {
        quotaDeadline = Math.max(quotaDeadline, deadline)
        if (input.runtime?.activate) await input.runtime.activate(signal, deadline)
        else activations += 1
      },
      poll: async (signal, reservation) => {
        const startedAtMs = now
        if (quotaDeadline > now)
          return { poll: { _tag: 'QuotaWait', nextPollNotBeforeMs: quotaDeadline }, startedAtMs, completedAtMs: now }
        quotaDeadline = now + 180_000
        const result = await (
          input.runtime?.poll ??
          (async () => {
            polls += 1
            return { _tag: 'Published', snapshotHash: 'c'.repeat(64), nextPollNotBeforeMs: 0 } as const
          })
        )(signal, reservation)
        now += input.elapsedMs ?? 0
        quotaDeadline = result.nextPollNotBeforeMs
        return { poll: result, startedAtMs, completedAtMs: now }
      },
    },
    [],
    { currentTimeMillisUnsafe: () => now },
  )
  const context = {
    key: input.key ?? controllerKey,
    date: { now: input.now ?? (async () => now) },
    console: { warn: () => undefined },
    request: () => ({ id: 'test-capture', attemptCompletedSignal: new AbortController().signal }),
    get: async (key: string) => (key === 'polling' ? state : budgetDeadline),
    clear: () => {
      budgetDeadline = null
    },
    set: (key: string, value: State | number) => {
      if (key === 'polling') {
        if (typeof value === 'number') throw new Error('unexpected numeric owner state')
        state = value
      } else {
        if (typeof value !== 'number') throw new Error('unexpected budget state')
        budgetDeadline = value
      }
    },
    run: async (name: string, action: () => Promise<unknown>) => {
      commands.push(name)
      if (input.runResults?.has(name)) return input.runResults.get(name)
      const value = await action()
      if (name === 'poll and publish broker observation' && input.losePollResult === 'before-journal')
        throw new Error('interrupted before poll result was journaled')
      input.runResults?.set(name, value)
      if (name === 'poll and publish broker observation' && input.losePollResult === 'after-journal')
        throw new Error('interrupted after poll result was journaled')
      return value
    },
    sleep: async (duration: { milliseconds: number }) => {
      sleeps.push(duration.milliseconds)
      if (input.sleep === undefined) now += duration.milliseconds
      else await input.sleep(duration.milliseconds)
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
  return {
    handlers,
    context,
    deliveries,
    sleeps,
    commands,
    advance: (milliseconds: number) => {
      now += milliseconds
    },
    calls: () => ({ activations, polls }),
    state: () => state,
    budgetDeadline: () => quotaDeadline,
    legacyBudget: () => budgetDeadline,
  }
}

describe('Restate broker observation owner', () => {
  test('a reserved quota window schedules a successor without holding the owner or starting HTTP', async () => {
    const h = harness({ state: { sourceRevision, epoch: 1, sequence: 1 }, quotaDeadline: 180_000 })
    await h.handlers.poll(h.context, { sourceRevision, epoch: 1, sequence: 1 })
    expect(h.sleeps).toEqual([])
    expect(h.commands).toEqual(['poll and publish broker observation'])
    expect(h.calls().polls).toBe(0)
    expect(h.deliveries[0]?.delay.milliseconds).toBe(180_000)
  })
  test('deployment activation waits for reserved quota and returns its fresh published cut', async () => {
    const h = harness({ state: { sourceRevision, epoch: 1, sequence: 1 }, quotaDeadline: 180_000 })
    const state = await h.handlers.activate(h.context, { sourceRevision })
    expect(h.sleeps).toEqual([180_000])
    expect(state.lastSnapshotHash).toBe('c'.repeat(64))
    expect(h.calls().polls).toBe(1)
  })
  test.each(['before-journal', 'after-journal'] as const)(
    'lost poll proof retains the reservation until durable replay (%s)',
    async (losePollResult) => {
      const runResults = new Map<string, unknown>()
      let captures = 0
      const runtime: TestRuntime = {
        poll: async (_, reservation) => {
          expect(reservation.captureId).toBe('test-capture')
          return ++captures === 1
            ? { _tag: 'Unavailable', nextPollNotBeforeMs: 0 }
            : { _tag: 'Unavailable', nextPollNotBeforeMs: 180_000 }
        },
      }
      const first = harness({ runtime, runResults, losePollResult })
      await first.handlers.activate(first.context, { sourceRevision })
      expect(first.budgetDeadline()).toBe(0)
      const replay = harness({ runtime, runResults })
      await replay.handlers.activate(replay.context, { sourceRevision })
      expect(replay.budgetDeadline()).toBe(losePollResult === 'before-journal' ? 180_000 : 0)
      expect(captures).toBe(losePollResult === 'before-journal' ? 2 : 1)
      expect(replay.commands).toEqual(['activate broker observation projection', 'poll and publish broker observation'])
    },
  )
  test.each([0, 8_400, 45_000])(
    'a completed persistence failure retains measured quota %d without the lost-worker reservation',
    async (measuredDeadline) => {
      const h = harness({
        runtime: {
          poll: (signal) =>
            Effect.runPromise(
              settleCompletedBrokerObservationPoll(
                Effect.fail(
                  new BrokerReadError({
                    operation: 'preflight',
                    kind: BrokerReadErrorKind.Timeout,
                    retryable: true,
                    message: 'Broker observation persistence failed',
                  }),
                ),
                Effect.succeed(measuredDeadline),
              ),
              { signal },
            ),
        },
      })
      await h.handlers.activate(h.context, { sourceRevision })
      expect(h.state()?.lastSnapshotHash).toBeUndefined()
      expect(h.budgetDeadline()).toBe(measuredDeadline)
      expect(h.deliveries[0]?.delay.milliseconds).toBe(Math.max(10_000, measuredDeadline))
    },
  )
  test.each([
    'defect',
    'interruption',
    'typed failure with cleanup defect',
    'typed failure with cleanup interruption',
  ] as const)('a poll %s retains the conservative lost-worker reservation', async (failure) => {
    const typedFailure = Effect.fail(
      new BrokerReadError({
        operation: 'preflight',
        kind: BrokerReadErrorKind.Timeout,
        retryable: true,
        message: 'injected completed persistence failure',
      }),
    )
    const poll =
      failure === 'defect'
        ? Effect.die(new Error('worker defect'))
        : failure === 'interruption'
          ? Effect.interrupt
          : typedFailure.pipe(
              Effect.ensuring(
                failure === 'typed failure with cleanup defect'
                  ? Effect.die(new Error('cleanup defect'))
                  : Effect.interrupt,
              ),
            )
    const h = harness({
      runtime: {
        poll: (signal) => Effect.runPromise(settleCompletedBrokerObservationPoll(poll, Effect.succeed(0)), { signal }),
      },
    })
    await h.handlers.activate(h.context, { sourceRevision })
    expect(h.state()?.lastSnapshotHash).toBeUndefined()
    expect(h.budgetDeadline()).toBe(180_000)
    expect(h.deliveries[0]?.delay.milliseconds).toBe(10_000)
    h.advance(10_000)
    await h.handlers.poll(h.context, { sourceRevision, epoch: 1, sequence: 1 })
    expect(h.deliveries[1]?.delay.milliseconds).toBe(170_000)
  })
  test('activation hands the legacy durable deadline to the database and clears its old key', async () => {
    const h = harness({ state: { sourceRevision: 'd'.repeat(40), epoch: 1, sequence: 1 }, budgetDeadline: 180_000 })
    await h.handlers.activate(h.context, { sourceRevision })
    expect(h.sleeps).toEqual([180_000])
    expect(h.legacyBudget()).toBeNull()
    expect(h.calls()).toEqual({ activations: 1, polls: 1 })
  })
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
      let captures = 0
      const h = harness({
        runtime: {
          poll: async () => {
            const nextPollNotBeforeMs = ++captures * 20_400
            return tag === 'Published'
              ? { _tag: tag, snapshotHash: 'f'.repeat(64), nextPollNotBeforeMs }
              : { _tag: tag, nextPollNotBeforeMs }
          },
        },
        elapsedMs: 1_000,
      })
      await h.handlers.activate(h.context, { sourceRevision })
      h.advance(19_400)
      await h.handlers.poll(h.context, { sourceRevision, epoch: 1, sequence: 1 })
      expect(h.deliveries.map((delivery) => delivery.delay.milliseconds)).toEqual([19_400, 19_400])
    },
  )
  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'refuses a corrupt durable budget %s without starting a broker poll',
    async (budgetDeadline) => {
      const h = harness({ budgetDeadline })
      const failure = await h.handlers.activate(h.context, { sourceRevision }).catch((cause: unknown) => cause)
      expect(failure).toBeInstanceOf(Error)
      expect(h.calls().polls).toBe(0)
      expect(h.legacyBudget()).toBe(budgetDeadline)
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
