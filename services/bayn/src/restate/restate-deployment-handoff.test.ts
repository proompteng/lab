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
type Delivery = { readonly parameter: unknown }

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
  let brokerState: BrokerState = { sourceRevision: previousSourceRevision, epoch: 7, sequence: 19 }
  const events: string[] = []
  const brokerDeliveries: Delivery[] = []
  const controllerDeliveries: Delivery[] = []
  let captures = 0
  let advances = 0
  let sleeps = 0
  let brokerActivations = 0
  let preflights = 0
  const signal = new AbortController().signal
  const clock = { currentTimeMillisUnsafe: () => Date.parse('2026-11-09T18:00:00.000Z') }
  const broker = makeBaynBrokerObservations(
    { ...config, pollIntervalMs: 10_000 },
    {
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
            ? { _tag: 'Published', snapshotHash: 'e'.repeat(64), nextPollNotBeforeMs: 0 }
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
      poll: (ctx: ObjectContext, input: unknown) => Promise<void>
      status: (ctx: ObjectSharedContext, input: unknown) => Promise<BrokerState>
    }
  }
  const brokerContext = {
    key: controllerKey,
    get: async (key: string) => (key === 'polling' ? brokerState : null),
    set: (_key: string, next: BrokerState) => {
      brokerState = next
    },
    clear: () => undefined,
    run: async <A>(_name: string, action: () => Promise<A>) => action(),
    request: () => ({ id: `broker-capture-${captures}`, attemptCompletedSignal: signal }),
    genericSend: (delivery: Delivery) => brokerDeliveries.push(delivery),
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
      activateDeployment: (ctx: ObjectSharedContext, input: unknown) => Promise<ExecutionControllerState>
    }
  }
  const controllerContext = {
    key: controllerKey,
    get: async () => state,
    set: (_key: string, next: ExecutionControllerState) => {
      state = next
    },
    run: async <A>(_name: string, action: () => Promise<A>) => action(),
    request: () => ({ id: 'handoff-controller', attemptCompletedSignal: signal }),
    genericSend: (delivery: Delivery) => controllerDeliveries.push(delivery),
  } as unknown as ControllerContext
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
        let delivery = brokerDeliveries.shift()
        if (delivery === undefined) throw new Error('broker recovery has no scheduled successor')
        // A retained predecessor delivery and a duplicated recovery delivery must not start another capture.
        await broker.object.poll(brokerContext, {
          sourceRevision: previousSourceRevision,
          epoch: 7,
          sequence: 19,
        })
        const before = captures
        await broker.object.poll(brokerContext, delivery.parameter)
        while (captures === before) {
          delivery = brokerDeliveries.shift()
          if (delivery === undefined) throw new Error('broker recovery has no current successor')
          await broker.object.poll(brokerContext, delivery.parameter)
        }
        expect(captures).toBe(before + 1)
        await broker.object.poll(brokerContext, delivery.parameter)
        expect(captures).toBe(before + 1)
        if (failure === 'foreign') brokerState = { ...brokerState, sourceRevision: previousSourceRevision }
      } else {
        const delivery = controllerDeliveries.shift()
        if (delivery === undefined) throw new Error('controller recovery has no scheduled successor')
        await controller.object.tick(controllerContext, delivery.parameter)
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
      await broker.object.poll(brokerContext, retained.parameter)
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
      nextSequence: 14,
      lastCompletion: { sequence: 13 },
    })
    expect(h.events.indexOf('broker-published')).toBeLessThan(h.events.indexOf('controller-activated'))
    expect(h.events).not.toContain('controller-deactivated')
    expect(h.counts()).toEqual({ captures: 3, advances: 2, sleeps: 3, brokerActivations: 1 })
    await h.staleBrokerTick()
    expect(h.counts().captures).toBe(3)
    expect(h.brokerDeliveries).toHaveLength(1)
    expect(h.controllerDeliveries).toHaveLength(1)
    await h.staleControllerTick()
    expect(h.counts().advances).toBe(2)
  },
)

test('broker recovery after the first readiness budget completes the same activation with fresh journaled work', async () => {
  const h = handoff('extended')
  await h.run()
  expect(h.state()).toMatchObject({ active: true, epoch: 5, sourceRevision, nextSequence: 14 })
  const attempts = executionControllerDeploymentCompletionMaximumAttempts(config.operationTimeoutMs)
  expect(h.counts().captures).toBeGreaterThan(attempts)
  expect(h.counts().advances).toBe(2)
  expect(h.counts().brokerActivations).toBe(1)
  expect(h.preflights()).toBe(2)
  expect(h.events).not.toContain('controller-deactivated')
})

test.each(['superseded', 'paused'] as const)(
  'a %s deployment cannot renew its broker-readiness wait',
  async (failure) => {
    const h = handoff(failure)
    await expect(h.run()).rejects.toThrow()
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
    await expect(h.run()).rejects.toThrow()
    expect(h.state()).toMatchObject({ active: true, epoch: 4, sourceRevision: previousSourceRevision })
    expect(h.counts().advances).toBe(0)
    expect(h.counts().sleeps).toBe(1)
    expect(h.brokerDeliveries).toHaveLength(1)
    expect(h.controllerDeliveries).toHaveLength(0)
  },
)

test('a failed fresh confirmation retries instead of accepting the retained successful broker status', async () => {
  const h = handoff('confirmation')
  await h.run()
  expect(h.state()).toMatchObject({ active: true, epoch: 5, sourceRevision })
  expect(h.counts()).toEqual({ captures: 5, advances: 2, sleeps: 4, brokerActivations: 1 })
  expect(h.events.lastIndexOf('broker-published')).toBeLessThan(h.events.indexOf('controller-activated'))
  expect(h.events).not.toContain('controller-deactivated')
})
