import { expect, test } from 'bun:test'
import type { ObjectContext, ObjectSharedContext } from '@restatedev/restate-sdk'
import { Result } from 'effect'

import type { ExecutionControllerState } from '../execution/controller'
import { ExecutionControllerOutcome } from '../execution/controller-status'
import {
  executionActivationAuthorizationHash,
  executionControllerDeploymentCompletionMaximumAttempts,
  makeBaynExecutionController,
} from './restate-execution-controller'
import { makeBaynBrokerObservations, type BrokerObservationOwnerStateSchema } from './restate-broker-observations'

const controllerKey = 'a'.repeat(64)
const planHash = 'b'.repeat(64)
const sourceRevision = 'c'.repeat(40)
const previousSourceRevision = 'd'.repeat(40)
const token = Buffer.alloc(32, 7).toString('base64url')
const config = {
  controllerKey,
  planHash,
  sourceRevision,
  operationTimeoutMs: 30_000,
  activationAuthorizationHash: Result.getOrThrow(executionActivationAuthorizationHash(token)),
}
type BrokerState = typeof BrokerObservationOwnerStateSchema.Type
type ControllerContext = ObjectContext<{ readonly controller: ExecutionControllerState }>
type Delivery = {
  readonly service: string
  readonly method: string
  readonly parameter: unknown
  readonly idempotencyKey?: string
}

const handoff = (
  failure:
    | 'unavailable'
    | 'rejected'
    | 'extended'
    | 'superseded'
    | 'paused'
    | 'foreign'
    | 'interrupted'
    | 'confirmation',
) => {
  let state: ExecutionControllerState = {
    schemaVersion: 1,
    active: true,
    epoch: 4,
    planHash,
    sourceRevision: previousSourceRevision,
    initialSequence: 7,
    nextSequence: 12,
  }
  let brokerState: BrokerState = {
    sourceRevision: previousSourceRevision,
    epoch: 7,
    sequence: 19,
    captureScheduled: false,
    nextCaptureNotBeforeMs: 0,
  }
  const events: string[] = []
  const brokerDeliveries: Delivery[] = []
  const controllerDeliveries: Delivery[] = []
  const acceptedDeliveries = new Set<string>()
  const send = (delivery: Delivery) => {
    const identity = `${delivery.service}:${delivery.method}:${delivery.idempotencyKey ?? ''}`
    if (acceptedDeliveries.has(identity)) return
    acceptedDeliveries.add(identity)
    if (delivery.service === 'BaynBrokerObservations') brokerDeliveries.push(delivery)
    else controllerDeliveries.push(delivery)
  }
  let captures = 0
  let advances = 0
  let sleeps = 0
  let brokerActivations = 0
  let preflights = 0
  const signal = new AbortController().signal
  const clock = { currentTimeMillisUnsafe: () => Date.parse('2026-11-09T18:00:00.000Z') }
  const broker = makeBaynBrokerObservations(
    { ...config, maxAgeMs: 60_000, freshnessLeadMs: 30_000 },
    {
      verifyNotification: () => {
        throw new Error('deployment activation does not ingest notifications')
      },
      recordNotification: async () => ({ covered: false }),
      invalidate: async () => undefined,
      activate: async () => {
        brokerActivations += 1
      },
      poll: async () => {
        captures += 1
        if (captures === 1 && failure === 'rejected') throw new Error('temporary capture failure')
        const published =
          captures > 1 &&
          failure !== 'superseded' &&
          failure !== 'paused' &&
          (failure !== 'extended' ||
            captures > executionControllerDeploymentCompletionMaximumAttempts(config.operationTimeoutMs) + 2) &&
          !(captures === 3 && failure === 'confirmation')
        events.push(published ? 'broker-published' : 'broker-unavailable')
        return {
          poll: published
            ? {
                _tag: 'Published',
                snapshotHash: 'e'.repeat(64),
                observedAt: '2026-11-09T18:00:00.000Z',
                nextPollNotBeforeMs: 0,
              }
            : { _tag: 'Unavailable', nextPollNotBeforeMs: 0 },
          startedAtMs: clock.currentTimeMillisUnsafe(),
          completedAtMs: clock.currentTimeMillisUnsafe(),
        }
      },
    },
    [],
    clock,
  ) as unknown as {
    object: {
      activate: (ctx: ObjectContext, input: unknown) => Promise<BrokerState>
      capture: (ctx: ObjectContext, input: unknown) => Promise<void>
      freshness: (ctx: ObjectContext, input: unknown) => Promise<void>
      status: (ctx: ObjectSharedContext, input: unknown) => Promise<BrokerState>
    }
  }
  const brokerContext = {
    key: controllerKey,
    date: { now: async () => clock.currentTimeMillisUnsafe() },
    get: async (key: string) => (key === 'observation' ? brokerState : null),
    set: (_key: string, next: BrokerState) => {
      brokerState = next
    },
    clear: () => undefined,
    run: async <A>(_name: string, action: () => Promise<A>) => action(),
    request: () => ({ id: `broker-capture-${captures}`, attemptCompletedSignal: signal }),
    genericSend: send,
    console: { warn: () => undefined },
  } as unknown as ObjectContext

  const controller = makeBaynExecutionController(
    config,
    {
      prepareActivation: async () => undefined,
      advance: async () => {
        expect(brokerState.lastSnapshotHash).toBeDefined()
        expect(state.sourceRevision).toBe(sourceRevision)
        advances += 1
        return {
          completedAt: '2026-11-09T18:00:01.000Z',
          outcome: { _tag: ExecutionControllerOutcome.Waiting, receiptHash: 'f'.repeat(64), nextDelayMs: 30_000 },
        }
      },
      log: async () => undefined,
      projectState: async (_key, projected) => {
        expect(brokerState.lastSnapshotHash).toBeDefined()
        events.push(projected.active ? 'controller-activated' : 'controller-deactivated')
      },
    },
    [],
    clock,
  ) as unknown as {
    object: {
      activate: (ctx: ControllerContext, input: unknown) => Promise<ExecutionControllerState>
      rotate: (ctx: ControllerContext, input: unknown) => Promise<ExecutionControllerState>
      deactivate: (ctx: ControllerContext, input: unknown) => Promise<ExecutionControllerState>
      tick: (ctx: ControllerContext, input: unknown) => Promise<void>
      wake: (ctx: ControllerContext, input: unknown) => Promise<void>
      activateDeployment: (ctx: ObjectSharedContext, input: unknown) => Promise<ExecutionControllerState>
    }
  }
  const controllerContext = {
    key: controllerKey,
    date: { now: async () => clock.currentTimeMillisUnsafe() },
    get: async (key: string) => (key === 'controller' ? state : null),
    set: (_key: string, next: ExecutionControllerState) => {
      state = next
    },
    run: async <A>(_name: string, action: () => Promise<A>) => action(),
    request: () => ({ id: 'handoff-controller', attemptCompletedSignal: signal }),
    genericSend: send,
  } as unknown as ControllerContext
  const deliverController = async (delivery: Delivery) => {
    if (delivery.method === 'wake') await controller.object.wake(controllerContext, delivery.parameter)
    else if (delivery.method === 'tick') await controller.object.tick(controllerContext, delivery.parameter)
    else throw new Error(`Unexpected controller delivery ${delivery.method}`)
  }
  const coordinator = {
    key: controllerKey,
    date: { now: async () => clock.currentTimeMillisUnsafe() },
    request: () => ({
      id: 'handoff-deployment',
      headers: new Map([['authorization', `Bearer ${token}`]]),
      attemptCompletedSignal: signal,
    }),
    objectClient: () => ({
      prepareActivation: async () => {
        preflights += 1
        if (preflights > 1 && failure === 'superseded')
          throw new Error('execution controller deployment activation does not match this immutable deployment')
        if (preflights > 1 && failure === 'paused') state = { ...state, active: false, epoch: state.epoch + 1 }
        return state
      },
      status: async () => state,
      rotate: (input: unknown) => controller.object.rotate(controllerContext, input),
      activate: (input: unknown) => controller.object.activate(controllerContext, input),
    }),
    genericCall: async ({ method }: { method: string }) =>
      method === 'activate'
        ? broker.object.activate(brokerContext, { sourceRevision })
        : broker.object.status(brokerContext, {}),
    sleep: async () => {
      sleeps += 1
      if (failure === 'interrupted') throw new Error('activation interrupted')
      if (brokerState.lastSnapshotHash === undefined) {
        expect(state).toMatchObject({ active: true, epoch: 4, sourceRevision: previousSourceRevision })
        const takeCapture = () => {
          const index = brokerDeliveries.findIndex((delivery) => delivery.method === 'capture')
          return index < 0 ? undefined : brokerDeliveries.splice(index, 1)[0]
        }
        let delivery = takeCapture()
        if (delivery === undefined) throw new Error('broker recovery has no scheduled successor')
        // A retained predecessor delivery and a duplicated recovery delivery must not start another capture.
        await broker.object.capture(brokerContext, {
          sourceRevision: previousSourceRevision,
          epoch: 7,
          sequence: 19,
        })
        const before = captures
        await broker.object.capture(brokerContext, delivery.parameter)
        while (captures === before) {
          delivery = takeCapture()
          if (delivery === undefined) throw new Error('broker recovery has no current successor')
          await broker.object.capture(brokerContext, delivery.parameter)
        }
        expect(captures).toBe(before + 1)
        await broker.object.capture(brokerContext, delivery.parameter)
        expect(captures).toBe(before + 1)
        if (failure === 'foreign') brokerState = { ...brokerState, sourceRevision: previousSourceRevision }
      } else {
        const before = advances
        while (advances === before) {
          const delivery = controllerDeliveries.shift()
          if (delivery === undefined) throw new Error('controller activation has no scheduled financial pass')
          await deliverController(delivery)
        }
      }
    },
  } as unknown as ObjectSharedContext
  return {
    run: () =>
      controller.object.activateDeployment(coordinator, {
        schemaVersion: 'bayn.execution-deployment-activation.v2',
        controllerKey,
        planHash,
        sourceRevision,
      }),
    staleControllerTick: () =>
      controller.object.tick(controllerContext, {
        schemaVersion: 'bayn.execution-controller-tick.v1',
        epoch: 4,
        sequence: 12,
      }),
    staleBrokerTick: async () => {
      const retained = brokerDeliveries.shift()
      if (retained === undefined) throw new Error('missing retained broker delivery')
      if (retained.method === 'capture') await broker.object.capture(brokerContext, retained.parameter)
      else if (retained.method === 'freshness') await broker.object.freshness(brokerContext, retained.parameter)
      else throw new Error(`Unexpected broker delivery ${retained.method}`)
    },
    drainControllerEvents: async () => {
      while (controllerDeliveries.length > 0) {
        const delivery = controllerDeliveries.shift()
        if (delivery !== undefined) await deliverController(delivery)
      }
    },
    state: () => state,
    counts: () => ({ captures, advances, sleeps, brokerActivations }),
    preflights: () => preflights,
    events,
    brokerDeliveries,
    controllerDeliveries,
  }
}

test.each(['unavailable', 'rejected'] as const)(
  'a %s initial capture recovers through the scheduled broker owner before controller handoff',
  async (failure) => {
    const h = handoff(failure)
    expect(await h.run()).toMatchObject({
      active: true,
      epoch: 5,
      sourceRevision,
      nextSequence: 13,
      lastCompletion: { sequence: 12 },
    })
    expect(h.events.indexOf('broker-published')).toBeLessThan(h.events.indexOf('controller-activated'))
    expect(h.events).not.toContain('controller-deactivated')
    expect(h.counts()).toEqual({ captures: 3, advances: 1, sleeps: 2, brokerActivations: 1 })
    await h.staleBrokerTick()
    expect(h.counts().captures).toBe(3)
    expect(h.brokerDeliveries).toHaveLength(1)
    expect(h.controllerDeliveries).toHaveLength(1)
    await h.drainControllerEvents()
    expect(h.controllerDeliveries).toHaveLength(0)
    await h.staleControllerTick()
    expect(h.counts().advances).toBe(1)
  },
)

test('broker recovery after the first readiness budget completes the same activation with fresh journaled work', async () => {
  const h = handoff('extended')
  await h.run()
  expect(h.state()).toMatchObject({ active: true, epoch: 5, sourceRevision, nextSequence: 13 })
  const attempts = executionControllerDeploymentCompletionMaximumAttempts(config.operationTimeoutMs)
  expect(h.counts().captures).toBeGreaterThan(attempts)
  expect(h.counts().advances).toBe(1)
  expect(h.counts().brokerActivations).toBe(1)
  expect(h.preflights()).toBe(2)
  expect(h.events).not.toContain('controller-deactivated')
})

test.each(['superseded', 'paused'] as const)(
  'a %s deployment cannot renew its broker-readiness wait',
  async (failure) => {
    const h = handoff(failure)
    const failureResult = await h.run().then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(failureResult).toBeInstanceOf(Error)
    expect(h.counts().advances).toBe(0)
    expect(h.preflights()).toBe(2)
    expect(h.controllerDeliveries).toHaveLength(0)
    expect(h.events).not.toContain('controller-activated')
  },
)

test.each(['foreign', 'interrupted'] as const)(
  'a %s readiness wait cannot retire or activate a controller',
  async (failure) => {
    const h = handoff(failure)
    const failureResult = await h.run().then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(failureResult).toBeInstanceOf(Error)
    expect(h.state()).toMatchObject({ active: true, epoch: 4, sourceRevision: previousSourceRevision })
    expect(h.counts().advances).toBe(0)
    expect(h.counts().sleeps).toBe(1)
    expect(h.brokerDeliveries).toHaveLength(1)
    await h.drainControllerEvents()
    expect(h.controllerDeliveries).toHaveLength(0)
  },
)

test('a failed fresh confirmation retries instead of accepting the retained successful broker status', async () => {
  const h = handoff('confirmation')
  await h.run()
  expect(h.state()).toMatchObject({ active: true, epoch: 5, sourceRevision })
  expect(h.counts()).toEqual({ captures: 5, advances: 1, sleeps: 3, brokerActivations: 1 })
  expect(h.events.lastIndexOf('broker-published')).toBeLessThan(h.events.indexOf('controller-activated'))
  expect(h.events).not.toContain('controller-deactivated')
})
