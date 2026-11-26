import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { ObjectContext, ObjectSharedContext, RunOptions } from '@restatedev/restate-sdk'
import { Effect, Redacted, Result, Schema } from 'effect'

import { makeBrokerIdentity, BrokerEnvironment, BrokerProvider } from '../broker/identity'
import { SignedBrokerNotificationSchema, verifyBrokerNotification } from '../broker/notifications'
import { type BrokerSourceProjectionReceipt, BrokerStreamReconciliationReason } from '../broker/trade-update-projection'
import { BrokerReadError, BrokerReadErrorKind } from '../broker/alpaca/failures'
import { settleCompletedBrokerObservationPoll } from '../composition/broker-observation-runtime'
import {
  brokerSourceProjectionContract,
  makeBaynBrokerObservations,
  makeBaynBrokerSourceProjector,
  type BrokerObservationPoll,
  type BrokerObservationRuntime,
  type BrokerObservationOwnerStateSchema,
} from './restate-broker-observations'

const fixture = Result.getOrThrow(
  Schema.decodeUnknownResult(
    Schema.fromJsonString(
      Schema.Struct({
        description: Schema.String,
        accountId: Schema.String,
        keyId: Schema.String,
        secret: Schema.String,
        key: Schema.String,
        notification: SignedBrokerNotificationSchema,
      }),
    ),
  )(readFileSync(new URL('../../../dorvud/fixtures/bayn-broker-notification-v1.json', import.meta.url), 'utf8')),
)
const identity = Result.getOrThrow(
  makeBrokerIdentity({
    schemaVersion: 'bayn.broker-identity.v2',
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    accountId: fixture.accountId,
  }),
)
const connection = { identity, key: Redacted.make(fixture.keyId), secret: Redacted.make(fixture.secret) }
const controllerKey = identity.identityHash
const sourceRevision = 'a'.repeat(40)
const initialNow = Date.parse('2026-11-11T17:37:20.000Z')
const config = { controllerKey, sourceRevision, maxAgeMs: 60_000, freshnessLeadMs: 30_000, operationTimeoutMs: 30_000 }
type State = typeof BrokerObservationOwnerStateSchema.Type
type Delivery = {
  service: string
  method: string
  parameter: unknown
  idempotencyKey: string
  delay?: { milliseconds: number }
}
const harness = (
  input: {
    runtime?: Partial<BrokerObservationRuntime>
    state?: State
    previous?: unknown
    key?: string
    elapsedMs?: number
    quotaDeadline?: number
    legacyBudget?: number
    runResults?: Map<string, unknown>
    loseResult?: 'before-journal' | 'after-journal'
    ownerConfig?: Partial<typeof config>
  } = {},
) => {
  const durable = new Map<string, unknown>([
    ...(input.state === undefined ? [] : [['observation', input.state] as const]),
    ...(input.previous === undefined ? [] : [['polling', input.previous] as const]),
    ...(input.legacyBudget === undefined ? [] : [['next-poll-not-before-ms', input.legacyBudget] as const]),
  ])
  let quotaDeadline = input.quotaDeadline ?? 0
  let activations = 0
  let polls = 0
  let invalidations = 0
  let now = initialNow
  let request = 0
  const sleeps: number[] = []
  const commands: string[] = []
  const runOptions = new Map<string, RunOptions<unknown> | undefined>()
  const deliveries: Delivery[] = []
  const runtime: BrokerObservationRuntime = {
    verifyNotification: (candidate, nowMs) => verifyBrokerNotification(candidate, connection, nowMs),
    probeProtection: async () => undefined,
    recordNotification: async () => ({ covered: false }),
    isNotificationCovered: async () => false,
    project: async (_signal, eventId) => ({
      _tag: 'ReconcileRequired',
      eventId,
      observedAt: new Date(initialNow).toISOString(),
      reason: BrokerStreamReconciliationReason.SessionBoundary,
    }),
    invalidate: async () => {
      invalidations += 1
    },
    activate: async (_signal, deadline) => {
      quotaDeadline = Math.max(quotaDeadline, deadline)
      activations += 1
    },
    poll: async () => {
      const startedAtMs = now
      if (quotaDeadline > now)
        return { poll: { _tag: 'QuotaWait', nextPollNotBeforeMs: quotaDeadline }, startedAtMs, completedAtMs: now }
      polls += 1
      now += input.elapsedMs ?? 0
      return {
        poll: {
          _tag: 'Published',
          snapshotHash: 'c'.repeat(64),
          observedAt: new Date(startedAtMs).toISOString(),
          nextPollNotBeforeMs: 0,
        },
        startedAtMs,
        completedAtMs: now,
      }
    },
    ...input.runtime,
  }
  const object = makeBaynBrokerObservations({ ...config, ...input.ownerConfig }, runtime, [], {
    currentTimeMillisUnsafe: () => now,
  })
  const projector = makeBaynBrokerSourceProjector({ ...config, ...input.ownerConfig }, runtime)
  const context = {
    key: input.key ?? controllerKey,
    date: { now: async () => now },
    console: { warn: () => undefined },
    request: () => ({ id: `test-capture-${request}`, attemptCompletedSignal: new AbortController().signal }),
    get: async (key: string) => durable.get(key) ?? null,
    clear: (key: string) => durable.delete(key),
    set: (key: string, value: unknown) => durable.set(key, value),
    run: async (name: string, action: () => Promise<unknown>, options?: RunOptions<unknown>) => {
      commands.push(name)
      runOptions.set(name, options)
      if (input.runResults?.has(name)) return input.runResults.get(name)
      const value = await action()
      if (name === 'capture and publish broker observation' && input.loseResult === 'before-journal')
        throw new Error('interrupted before capture result was journaled')
      input.runResults?.set(name, value)
      if (name === 'capture and publish broker observation' && input.loseResult === 'after-journal')
        throw new Error('interrupted after capture result was journaled')
      return value
    },
    sleep: async ({ milliseconds }: { milliseconds: number }) => {
      sleeps.push(milliseconds)
      now += milliseconds
    },
    genericSend: (delivery: Delivery) => deliveries.push(delivery),
  } as unknown as ObjectContext
  const handlers = (
    object as unknown as {
      object: {
        activate: (ctx: ObjectContext, input: unknown) => Promise<State>
        notify: (
          ctx: ObjectSharedContext,
          input: unknown,
        ) => Promise<{ accepted: boolean; eventId: string; sourceRevision: string; projectionContract: string }>
        reconcile: (ctx: ObjectContext, input: unknown) => Promise<void>
        refresh: (ctx: ObjectContext, input: unknown) => Promise<void>
        capture: (ctx: ObjectContext, input: unknown) => Promise<void>
        freshness: (ctx: ObjectContext, input: unknown) => Promise<void>
        status: (ctx: ObjectSharedContext, input: unknown) => Promise<State | null>
      }
    }
  ).object
  const projectorHandlers = (
    projector as unknown as {
      object: {
        project: (ctx: ObjectContext, input: unknown) => Promise<BrokerSourceProjectionReceipt>
      }
    }
  ).object
  return {
    handlers,
    projectorHandlers,
    context,
    deliveries,
    sleeps,
    commands,
    runOptions,
    durable,
    calls: () => ({ activations, polls }),
    invalidations: () => invalidations,
    state: () => durable.get('observation') as State | undefined,
    advance: (ms: number) => {
      now += ms
    },
    nextRequest: () => {
      request += 1
    },
    timers: () => deliveries.filter((delivery) => delivery.service === 'BaynBrokerObservations'),
    projections: () => deliveries.filter((delivery) => delivery.service === 'BaynBrokerSourceProjector'),
  }
}
const tick = (state: State) => ({ sourceRevision: state.sourceRevision, epoch: state.epoch, sequence: state.sequence })
const active = (overrides: Partial<State> = {}): State => ({
  sourceRevision,
  epoch: 1,
  sequence: 1,
  captureScheduled: false,
  nextCaptureNotBeforeMs: 0,
  lastSnapshotHash: 'c'.repeat(64),
  lastObservedAt: new Date(initialNow).toISOString(),
  ...overrides,
})
const receipt = { eventId: 'd'.repeat(64) }
const pollResult = (poll: BrokerObservationPoll) => ({ poll, startedAtMs: initialNow, completedAtMs: initialNow })

describe('event-driven Restate broker observation owner', () => {
  test('probes immediately and wakes the exact protective cycle before scheduling the ordinary capture', async () => {
    const proof = {
      proofId: '1'.repeat(64),
      cycleId: '2'.repeat(64),
      checkedAt: new Date(initialNow).toISOString(),
    }
    const probes: string[] = []
    const h = harness({
      state: active(),
      runtime: {
        probeProtection: async (_signal, cycleId) => {
          probes.push(cycleId)
          return proof
        },
      },
    })
    await h.handlers.refresh(h.context, { sourceRevision: 'f'.repeat(40), cycleId: proof.cycleId })
    expect(probes).toEqual([])
    await h.handlers.refresh(h.context, { sourceRevision, cycleId: proof.cycleId })
    expect(h.sleeps).toEqual([])
    expect(probes).toEqual([proof.cycleId])
    expect(h.deliveries).toMatchObject([
      {
        service: 'BaynExecutionController',
        method: 'wake',
        parameter: { _tag: 'ProtectionRelease', sourceRevision, eventId: proof.proofId, ...proof },
      },
      { service: 'BaynBrokerObservations', method: 'capture', delay: { milliseconds: 100 } },
    ])
    expect(h.calls().polls).toBe(0)
  })

  test.each(['unproven', 'failed'])(
    '%s protection readback schedules capture without waking execution',
    async (outcome) => {
      const h = harness({
        state: active({ nextCaptureNotBeforeMs: initialNow + 30_000 }),
        runtime: {
          probeProtection: async () => {
            if (outcome === 'failed') throw new Error('injected unavailable read')
            return undefined
          },
        },
      })
      await h.handlers.refresh(h.context, { sourceRevision, cycleId: '2'.repeat(64) })
      expect(h.deliveries).toMatchObject([
        { service: 'BaynBrokerObservations', method: 'capture', delay: { milliseconds: 30_000 } },
      ])
    },
  )

  test('activation publishes one canonical cut, wakes the account and arms only its completeness deadline', async () => {
    const h = harness()
    const state = await h.handlers.activate(h.context, { sourceRevision })
    expect(state).toEqual(active())
    expect(h.calls()).toEqual({ activations: 1, polls: 1 })
    expect(h.deliveries.map((delivery) => [delivery.service, delivery.method])).toEqual([
      ['BaynExecutionController', 'wake'],
      ['BaynBrokerObservations', 'freshness'],
    ])
    expect(h.timers()[0]?.delay?.milliseconds).toBe(30_000)
    expect(h.deliveries[0]?.parameter).toEqual({
      schemaVersion: 'bayn.execution-wakeup.v1',
      _tag: 'BrokerObservation',
      sourceRevision,
      eventId: 'c'.repeat(64),
      snapshotHash: 'c'.repeat(64),
      observedAt: new Date(initialNow).toISOString(),
    })
  })
  test('a signed notification is verified once then routes durable projection and reconciliation by stable ID', async () => {
    const runResults = new Map<string, unknown>()
    const h = harness({ state: active(), runResults })
    const accepted = await h.handlers.notify(h.context, fixture.notification)
    expect(accepted).toMatchObject({
      accepted: true,
      sourceRevision,
      projectionContract: brokerSourceProjectionContract,
    })
    expect(h.commands).toEqual(['verify broker notification', 'record verified broker notification'])
    expect(h.calls().polls).toBe(0)
    expect(h.projections()[0]).toMatchObject({
      method: 'project',
      parameter: { eventId: accepted.eventId },
      idempotencyKey: `broker-source-project:${accepted.eventId}`,
    })
    expect(h.timers()).toEqual([])
    await h.projectorHandlers.project(h.context, { eventId: accepted.eventId })
    expect(h.timers()[0]).toMatchObject({
      method: 'reconcile',
      parameter: { eventId: accepted.eventId },
      idempotencyKey: `broker-source-reconcile:${accepted.eventId}`,
    })
    const replay = harness({
      runResults,
      runtime: {
        verifyNotification: () => {
          throw new Error('credentials rotated')
        },
      },
    })
    expect(await replay.handlers.notify(replay.context, fixture.notification)).toEqual(accepted)
    expect(replay.projections().map((delivery) => delivery.idempotencyKey)).toEqual(
      h.projections().map((delivery) => delivery.idempotencyKey),
    )
    expect(JSON.stringify([...h.durable.entries()])).not.toContain(fixture.secret)
  })
  test('rejects a signed notification from another source revision before persistence', async () => {
    const h = harness({ ownerConfig: { sourceRevision: 'b'.repeat(40) } })
    const failure = await h.handlers.notify(h.context, fixture.notification).catch((cause: unknown) => cause)
    expect(String(failure)).toContain('broker notification source revision mismatch')
    expect(h.commands).toEqual(['verify broker notification'])
    expect(h.deliveries).toEqual([])
  })
  test.each([
    { name: 'null', candidate: null },
    { name: 'empty', candidate: {} },
    { name: 'signature', candidate: { ...fixture.notification, signature: 'f'.repeat(64) } },
  ])('rejects malformed or unsigned ingress payloads before enqueueing ($name)', async ({ candidate }) => {
    const h = harness({ state: active() })
    const failure = await h.handlers.notify(h.context, candidate).catch((cause: unknown) => cause)
    expect(String(failure)).toContain('broker notification rejected')
    expect(h.deliveries).toEqual([])
    expect(h.calls().polls).toBe(0)
  })
  test('rejects a foreign object key before reading loaded credentials', async () => {
    const h = harness({
      key: 'another-account',
      runtime: {
        verifyNotification: () => {
          throw new Error('must not verify')
        },
      },
    })
    const failure = await h.handlers.notify(h.context, fixture.notification).catch((cause: unknown) => cause)
    expect(String(failure)).toContain('account binding mismatch')
    expect(h.commands).toEqual([])
  })
  test('canonical coverage suppresses redundant reconciliation after durable projection', async () => {
    const h = harness({ runtime: { isNotificationCovered: async () => true } })
    const accepted = await h.handlers.notify(h.context, fixture.notification)
    expect(accepted.accepted).toBe(true)
    await h.projectorHandlers.project(h.context, { eventId: accepted.eventId })
    expect(h.deliveries).toHaveLength(1)
    expect(h.deliveries[0]?.method).toBe('project')
    expect(h.invalidations()).toBe(0)
  })
  test('canonical source coverage completes without another database check, wake, or reconciliation', async () => {
    const h = harness({
      runtime: {
        project: async (_signal, eventId) => ({
          _tag: 'CanonicallyCovered',
          eventId,
          observedAt: new Date(initialNow).toISOString(),
        }),
        isNotificationCovered: async () => {
          throw new Error('canonical coverage receipt is final')
        },
      },
    })
    expect(await h.projectorHandlers.project(h.context, receipt)).toEqual({
      _tag: 'CanonicallyCovered',
      eventId: receipt.eventId,
      observedAt: new Date(initialNow).toISOString(),
    })
    expect(h.commands).toEqual(['project durable broker source event'])
    expect(h.deliveries).toEqual([])
  })
  test.each(['CanonicallyCovered', 'Projected'] as const)(
    'an early child dispatches independent recovery and resolves as %s',
    async (outcome) => {
      let calls = 0
      const h = harness({
        runtime: {
          project: async (_signal, eventId) => {
            calls++
            if (calls === 1)
              return {
                _tag: 'AwaitingProtection',
                eventId,
                observedAt: new Date(initialNow).toISOString(),
                deadlineAt: new Date(initialNow + config.operationTimeoutMs).toISOString(),
              }
            expect(h.timers()[0]).toMatchObject({
              method: 'reconcile',
              idempotencyKey: `broker-source-reconcile:${eventId}`,
            })
            return outcome === 'CanonicallyCovered'
              ? { _tag: outcome, eventId, observedAt: new Date(initialNow).toISOString() }
              : {
                  _tag: outcome,
                  eventId,
                  observedAt: new Date(initialNow).toISOString(),
                  orderEventId: 'e'.repeat(64),
                }
          },
          isNotificationCovered: async () => true,
        },
      })
      expect(await h.projectorHandlers.project(h.context, receipt)).toMatchObject({ _tag: outcome })
      expect(h.sleeps).toEqual([1000])
      expect(h.calls().polls).toBe(0)
      expect(h.deliveries.filter((delivery) => delivery.method === 'wake')).toHaveLength(
        outcome === 'Projected' ? 1 : 0,
      )
      expect(h.commands).toContain('resolve broker protection binding 1')
    },
  )
  test('a missing protection identity exhausts only its original remaining deadline and keeps fail-closed reconciliation', async () => {
    const permissions: boolean[] = []
    const h = harness({
      runtime: {
        project: async (_signal, eventId, allowProtectionWait = true) => {
          permissions.push(allowProtectionWait)
          return allowProtectionWait
            ? {
                _tag: 'AwaitingProtection',
                eventId,
                observedAt: new Date(initialNow - 28000).toISOString(),
                deadlineAt: new Date(initialNow + 2000).toISOString(),
              }
            : {
                _tag: 'ReconcileRequired',
                eventId,
                observedAt: new Date(initialNow - 28000).toISOString(),
                reason: BrokerStreamReconciliationReason.MissingIntent,
              }
        },
      },
    })
    expect(await h.projectorHandlers.project(h.context, receipt)).toMatchObject({
      _tag: 'ReconcileRequired',
      reason: BrokerStreamReconciliationReason.MissingIntent,
    })
    expect(h.sleeps).toEqual([1000, 1000])
    expect(permissions).toEqual([true, true, false])
    expect(h.deliveries.every((delivery) => delivery.method === 'reconcile')).toBe(true)
  })
  test('replayed protection recovery reuses each journaled attempt and preserves delivery identity', async () => {
    const runResults = new Map<string, unknown>()
    let calls = 0
    const initial = harness({
      runResults,
      runtime: {
        project: async (_signal, eventId) => {
          calls++
          return calls === 1
            ? {
                _tag: 'AwaitingProtection',
                eventId,
                observedAt: new Date(initialNow).toISOString(),
                deadlineAt: new Date(initialNow + 30000).toISOString(),
              }
            : { _tag: 'CanonicallyCovered', eventId, observedAt: new Date(initialNow).toISOString() }
        },
      },
    })
    const expected = await initial.projectorHandlers.project(initial.context, receipt)
    const replay = harness({
      runResults,
      runtime: {
        project: async () => {
          throw new Error('must reuse journaled projection')
        },
      },
    })
    expect(await replay.projectorHandlers.project(replay.context, receipt)).toEqual(expected)
    expect(replay.deliveries).toEqual(initial.deliveries)
    expect(calls).toBe(2)
  })
  test('a database failure during protection recovery cannot publish a projection or execution wake', async () => {
    let calls = 0
    const h = harness({
      runtime: {
        project: async (_signal, eventId) => {
          if (++calls > 1) throw new Error('database unavailable')
          return {
            _tag: 'AwaitingProtection',
            eventId,
            observedAt: new Date(initialNow).toISOString(),
            deadlineAt: new Date(initialNow + 30000).toISOString(),
          }
        },
      },
    })
    const failure = await h.projectorHandlers.project(h.context, receipt).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(failure).toMatchObject({ message: 'database unavailable' })
    expect(h.deliveries.map((delivery) => delivery.method)).toEqual(['reconcile'])
    expect(h.runOptions.get('resolve broker protection binding 1')).toEqual({
      initialRetryInterval: 50,
      maxRetryInterval: 1000,
    })
  })
  test('a projected source event wakes execution immediately without waiting for the reconciliation capture', async () => {
    const h = harness({
      runtime: {
        project: async (_signal, eventId) => ({
          _tag: 'Projected',
          eventId,
          observedAt: new Date(initialNow).toISOString(),
          orderEventId: 'a'.repeat(64),
          fillEventId: 'b'.repeat(64),
        }),
      },
    })
    expect(await h.projectorHandlers.project(h.context, receipt)).toMatchObject({
      _tag: 'Projected',
      eventId: receipt.eventId,
    })
    expect(h.runOptions.get('project durable broker source event')).toEqual({
      initialRetryInterval: 50,
      maxRetryInterval: 1_000,
    })
    expect(h.runOptions.get('check canonical broker source coverage')).toEqual({
      initialRetryInterval: 50,
      maxRetryInterval: 1_000,
    })
    expect(h.deliveries).toMatchObject([
      {
        service: 'BaynExecutionController',
        method: 'wake',
        idempotencyKey: `broker-source-wake:${receipt.eventId}`,
        parameter: {
          _tag: 'BrokerEvent',
          eventId: receipt.eventId,
          sourceRevision,
          observedAt: new Date(initialNow).toISOString(),
        },
      },
      {
        service: 'BaynBrokerObservations',
        method: 'reconcile',
        idempotencyKey: `broker-source-reconcile:${receipt.eventId}`,
      },
    ])
    expect(h.calls().polls).toBe(0)
  })
  test('receipt and notification invalidation retain durable retries independently of finite handler attempts', async () => {
    const h = harness({ state: active() })
    await h.handlers.notify(h.context, fixture.notification)
    await h.handlers.reconcile(h.context, receipt)
    for (const operation of [
      'record verified broker notification',
      'invalidate broker observation after source event',
    ]) {
      expect(h.runOptions.get(operation)).toEqual({ initialRetryInterval: 50, maxRetryInterval: 1_000 })
    }
    expect(h.deliveries.some((delivery) => delivery.method === 'capture')).toBe(true)
  })
  test('known mutation invalidation retries durably while canonical HTTP capture keeps its separate recovery owner', async () => {
    const h = harness({ state: active() })
    await h.handlers.refresh(h.context, { sourceRevision })
    expect(h.runOptions.get('invalidate broker observation after execution mutation')).toEqual({
      initialRetryInterval: 50,
      maxRetryInterval: 1_000,
    })
    const scheduled = h.timers()[0]
    if (scheduled === undefined) throw new Error('missing mutation continuation')
    h.advance(1_000)
    await h.handlers.capture(h.context, scheduled.parameter)
    expect(h.runOptions.get('capture and publish broker observation')).toEqual({ maxRetryAttempts: 0 })
  })
  test('ingress does not acknowledge a verified notification whose durable receipt cannot be retained', async () => {
    const h = harness({
      runtime: {
        recordNotification: async () => {
          throw new Error('receipt persistence unavailable')
        },
      },
    })
    const failure = await h.handlers.notify(h.context, fixture.notification).catch((cause: unknown) => cause)
    expect(String(failure)).toContain('receipt persistence unavailable')
    expect(h.deliveries).toEqual([])
  })
  test('a notification arriving behind a freshness capture invalidates the older projection once without another timer', async () => {
    const h = harness({ state: active({ captureScheduled: true }) })
    await h.handlers.reconcile(h.context, receipt)
    await h.handlers.reconcile(h.context, { eventId: 'e'.repeat(64) })
    expect(h.invalidations()).toBe(1)
    expect(h.state()).toMatchObject({ captureScheduled: true, pendingNotificationId: receipt.eventId, sequence: 1 })
    expect(h.state()?.lastSnapshotHash).toBeUndefined()
    expect(h.timers()).toEqual([])
  })
  test('coalesces a hundred unique queued wakeups into one quota-paced capture', async () => {
    const h = harness({ state: active({ nextCaptureNotBeforeMs: initialNow + 16_800 }) })
    for (let i = 0; i < 100; i++) await h.handlers.reconcile(h.context, { eventId: i.toString(16).padStart(64, '0') })
    expect(h.calls().polls).toBe(0)
    expect(h.timers()).toHaveLength(1)
    expect(h.invalidations()).toBe(1)
    expect(h.state()?.lastSnapshotHash).toBeUndefined()
    expect(h.timers()[0]?.delay?.milliseconds).toBe(16_800)
    const capture = h.timers()[0]
    if (capture === undefined) throw new Error('missing coalesced capture')
    h.advance(16_800)
    await h.handlers.capture(h.context, capture.parameter)
    expect(h.calls().polls).toBe(1)
    expect(h.state()?.captureScheduled).toBe(false)
    await h.handlers.capture(h.context, capture.parameter)
    expect(h.calls().polls).toBe(1)
  })
  test('a burst preempts the retained freshness timer and fences its stale delivery', async () => {
    const h = harness()
    const initial = await h.handlers.activate(h.context, { sourceRevision })
    await h.handlers.reconcile(h.context, receipt)
    await h.handlers.freshness(h.context, tick(initial))
    expect(h.timers().map((delivery) => delivery.method)).toEqual(['freshness', 'capture'])
    expect(h.timers()[1]?.delay?.milliseconds).toBe(100)
  })
  test.each([0, 16_800])(
    'a known execution mutation coalesces a capture behind its existing database deadline (%s)',
    async (quotaDelay) => {
      const previous = active({ nextCaptureNotBeforeMs: initialNow + quotaDelay })
      const h = harness({ state: previous })
      await h.handlers.refresh(h.context, { sourceRevision })
      expect(h.calls().polls).toBe(0)
      expect(h.invalidations()).toBe(1)
      expect(h.state()?.lastSnapshotHash).toBeUndefined()
      expect(h.timers()).toHaveLength(1)
      expect(h.timers()[0]).toMatchObject({ method: 'capture', delay: { milliseconds: Math.max(100, quotaDelay) } })
      await h.handlers.freshness(h.context, tick(previous))
      expect(h.timers()).toHaveLength(1)
    },
  )
  test('a late mutation refresh preserves the original database consistency deadline instead of renewing it', async () => {
    const h = harness({
      state: active({ captureScheduled: true }),
      runtime: { poll: async () => pollResult({ _tag: 'QuotaWait', nextPollNotBeforeMs: initialNow + 1_000 }) },
    })
    h.advance(150)
    await h.handlers.capture(h.context, tick(active()))
    h.advance(100)
    await h.handlers.refresh(h.context, { sourceRevision })
    expect(h.state()?.nextCaptureNotBeforeMs).toBe(initialNow + 1_000)
    expect(h.timers().at(-1)).toMatchObject({ method: 'capture', delay: { milliseconds: 750 } })
    expect(h.calls().polls).toBe(0)
  })
  test('a known mutation supersedes an earlier queued capture without resetting the quota deadline', async () => {
    const previous = active({ captureScheduled: true, nextCaptureNotBeforeMs: initialNow + 16_800 })
    const h = harness({ state: previous })
    await h.handlers.refresh(h.context, { sourceRevision })
    await h.handlers.capture(h.context, tick(previous))
    expect(h.calls().polls).toBe(0)
    expect(h.state()).toMatchObject({
      captureScheduled: true,
      sequence: 2,
      nextCaptureNotBeforeMs: initialNow + 16_800,
    })
    expect(h.timers()).toHaveLength(1)
  })
  test('a stale source cannot request mutation refresh on the replacement owner', async () => {
    const h = harness({ state: active() })
    await h.handlers.refresh(h.context, { sourceRevision: 'f'.repeat(40) })
    expect(h.invalidations()).toBe(0)
    expect(h.timers()).toEqual([])
  })
  test('a quiet websocket still refreshes cash, fees and historical corrections at the original completeness deadline', async () => {
    const h = harness({ elapsedMs: 8_400 })
    const initial = await h.handlers.activate(h.context, { sourceRevision })
    expect(h.timers()[0]?.delay?.milliseconds).toBe(21_600)
    h.advance(21_600)
    await h.handlers.freshness(h.context, tick(initial))
    expect(h.timers()[1]).toMatchObject({ method: 'capture', delay: { milliseconds: 0 } })
    expect(h.calls().polls).toBe(1)
    const delivery = h.timers()[1]
    if (delivery === undefined) throw new Error('missing freshness capture')
    await h.handlers.capture(h.context, delivery.parameter)
    expect(h.calls().polls).toBe(2)
  })
  test('short configured freshness never inherits a recovery delay beyond its original expiration', async () => {
    const h = harness({ ownerConfig: { maxAgeMs: 1_000, freshnessLeadMs: 500 }, elapsedMs: 400 })
    await h.handlers.activate(h.context, { sourceRevision })
    expect(h.timers()[0]).toMatchObject({ method: 'freshness', delay: { milliseconds: 100 } })
  })
  test('quota wait releases the owner and retains one delayed successor', async () => {
    const h = harness({ state: active({ captureScheduled: true }), quotaDeadline: initialNow + 180_000 })
    await h.handlers.capture(h.context, tick(active()))
    expect(h.calls().polls).toBe(0)
    expect(h.sleeps).toEqual([])
    expect(h.timers()).toHaveLength(1)
    expect(h.timers()[0]?.delay?.milliseconds).toBe(180_000)
  })
  test('deployment activation waits for existing quota before returning a published canonical cut', async () => {
    const h = harness({ quotaDeadline: initialNow + 180_000 })
    const state = await h.handlers.activate(h.context, { sourceRevision })
    expect(h.sleeps).toEqual([180_000])
    expect(state.lastSnapshotHash).toBe('c'.repeat(64))
    expect(h.calls().polls).toBe(1)
  })
  test('one-way handover carries the previous epoch and quota debt then deletes obsolete owner state', async () => {
    const h = harness({
      previous: { sourceRevision: 'e'.repeat(40), epoch: 7, sequence: 19 },
      legacyBudget: initialNow + 180_000,
    })
    const state = await h.handlers.activate(h.context, { sourceRevision })
    expect(state).toMatchObject({ epoch: 8, sequence: 20 })
    expect(h.sleeps).toEqual([180_000])
    expect(h.durable.has('polling')).toBe(false)
    expect(h.durable.has('next-poll-not-before-ms')).toBe(false)
  })
  test('restart and revision handover preserve quota and fence retained work', async () => {
    const current = active({
      sourceRevision: 'e'.repeat(40),
      epoch: 7,
      sequence: 19,
      nextCaptureNotBeforeMs: initialNow + 180_000,
    })
    const h = harness({ state: current })
    const state = await h.handlers.activate(h.context, { sourceRevision })
    expect(h.sleeps).toEqual([180_000])
    await h.handlers.capture(h.context, tick(current))
    expect(h.calls().polls).toBe(1)
    const restarted = harness({ state })
    await restarted.handlers.reconcile(restarted.context, receipt)
    expect(restarted.calls().activations).toBe(0)
    expect(restarted.timers()).toHaveLength(1)
  })
  test.each(['Invalidated', 'Unavailable'] as const)(
    'a %s cut omits readiness and schedules only a named recovery',
    async (_tag) => {
      const h = harness({
        runtime: { poll: async () => pollResult({ _tag, nextPollNotBeforeMs: initialNow + 20_400 }) },
      })
      const state = await h.handlers.activate(h.context, { sourceRevision })
      expect(state.lastSnapshotHash).toBeUndefined()
      expect(h.deliveries).toHaveLength(1)
      expect(h.timers()[0]).toMatchObject({ method: 'capture', delay: { milliseconds: 20_400 } })
    },
  )
  test.each([0, 8_400, 45_000])(
    'a completed persistence failure preserves its measured quota (%s ms)',
    async (delay) => {
      const failure = new BrokerReadError({
        operation: 'preflight',
        kind: BrokerReadErrorKind.Timeout,
        retryable: true,
        message: 'injected unavailable persistence',
      })
      const h = harness({
        runtime: {
          poll: async (signal) =>
            pollResult(
              await Effect.runPromise(
                settleCompletedBrokerObservationPoll(Effect.fail(failure), Effect.succeed(initialNow + delay)),
                { signal },
              ),
            ),
        },
      })
      const state = await h.handlers.activate(h.context, { sourceRevision })
      expect(state.nextCaptureNotBeforeMs).toBe(initialNow + delay)
      expect(state.lastSnapshotHash).toBeUndefined()
      expect(h.timers()[0]?.delay?.milliseconds).toBe(Math.max(1_000, delay))
    },
  )
  test.each(['before-journal', 'after-journal'] as const)(
    'lost publication proof retries the same durable capture claim (%s)',
    async (loseResult) => {
      let captures = 0
      const runResults = new Map<string, unknown>()
      const runtime = {
        poll: async (_: AbortSignal, { captureId }: { captureId: string }) => {
          expect(captureId).toBe('test-capture-0')
          captures++
          return pollResult({ _tag: 'Unavailable', nextPollNotBeforeMs: initialNow + 180_000 })
        },
      }
      const first = harness({ runtime, runResults, loseResult })
      await first.handlers.activate(first.context, { sourceRevision })
      const replay = harness({ runtime, runResults })
      const state = await replay.handlers.activate(replay.context, { sourceRevision })
      expect(state.nextCaptureNotBeforeMs).toBe(initialNow + 180_000)
      expect(captures).toBe(loseResult === 'before-journal' ? 2 : 1)
    },
  )
  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'refuses corrupt durable quota debt %s without HTTP',
    async (legacyBudget) => {
      const h = harness({ legacyBudget })
      const failure = await h.handlers.activate(h.context, { sourceRevision }).catch((cause: unknown) => cause)
      expect(String(failure)).toContain('validation')
      expect(h.calls().polls).toBe(0)
    },
  )
  test.each([{ sourceRevision: 'f'.repeat(40) }, { sourceRevision, interval: 1 }])(
    'refuses foreign revisions and additional activation fields (%j)',
    async (request) => {
      const h = harness()
      const failure = await h.handlers.activate(h.context, request).catch((cause: unknown) => cause)
      expect(failure).toBeInstanceOf(Error)
      expect(h.calls()).toEqual({ activations: 0, polls: 0 })
    },
  )
})
