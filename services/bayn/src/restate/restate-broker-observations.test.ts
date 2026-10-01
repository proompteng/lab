import { describe, expect, test } from 'bun:test'
import type { ObjectContext } from '@restatedev/restate-sdk'
import { makeBaynBrokerObservations, type BrokerObservationRuntime } from './restate-broker-observations'

const controllerKey = 'a'.repeat(64)
const sourceRevision = 'b'.repeat(40)
const config = { controllerKey, sourceRevision, pollIntervalMs: 30_000, operationTimeoutMs: 30_000 }
type State = { sourceRevision: string; epoch: number; sequence: number; lastSnapshotHash?: string }
const harness = (
  input: { runtime?: Partial<BrokerObservationRuntime>; state?: State; key?: string; elapsedMs?: number } = {},
) => {
  let state: State | null = input.state ?? null
  let activations = 0
  let polls = 0
  let clockReads = 0
  const deliveries: Array<{
    parameter: { sourceRevision: string; epoch: number; sequence: number }
    idempotencyKey: string
  }> = []
  const object = makeBaynBrokerObservations(config, {
    activate:
      input.runtime?.activate ??
      (async () => {
        activations += 1
      }),
    poll:
      input.runtime?.poll ??
      (async () => {
        polls += 1
        return 'c'.repeat(64)
      }),
  })
  const context = {
    key: input.key ?? controllerKey,
    date: { now: async () => (clockReads++ % 2 === 0 ? 0 : (input.elapsedMs ?? 0)) },
    console: { warn: () => undefined },
    request: () => ({ attemptCompletedSignal: new AbortController().signal }),
    get: async () => state,
    set: (_key: string, value: State) => {
      state = value
    },
    run: async (_name: string, action: () => Promise<unknown>) => action(),
    genericSend: (delivery: (typeof deliveries)[number] & { delay: { milliseconds: number } }) => {
      expect(delivery.delay.milliseconds).toBe(Math.max(1000, config.pollIntervalMs - (input.elapsedMs ?? 0)))
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
  return { handlers, context, deliveries, calls: () => ({ activations, polls }), state: () => state }
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
    const h = harness({ runtime: { poll: async () => (failures ? null : 'e'.repeat(64)) } })
    expect((await h.handlers.activate(h.context, { sourceRevision })).lastSnapshotHash).toBeUndefined()
    failures = false
    await h.handlers.poll(h.context, { sourceRevision, epoch: 1, sequence: 1 })
    expect(h.state()?.lastSnapshotHash).toBe('e'.repeat(64))
    failures = true
    await h.handlers.poll(h.context, { sourceRevision, epoch: 1, sequence: 2 })
    expect(h.state()?.lastSnapshotHash).toBeUndefined()
    expect(h.state()?.sequence).toBe(3)
  })
  test.each([250, 29_500, 40_000])('includes a %s ms capture in the poll cadence', async (elapsedMs) => {
    const h = harness({ elapsedMs })
    await h.handlers.activate(h.context, { sourceRevision })
    await h.handlers.poll(h.context, { sourceRevision, epoch: 1, sequence: 1 })
    expect(h.deliveries).toHaveLength(2)
  })
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
