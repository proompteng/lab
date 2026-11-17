import { describe, expect, test } from 'bun:test'

import {
  InvocationIdParser,
  TerminalError,
  type ObjectSharedContext,
  type ObjectContext,
} from '@restatedev/restate-sdk'
import { Result } from 'effect'

import {
  executionControllerMaximumRecoveryWindow,
  executionControllerSuccessorPassCompleted,
  decodeExecutionControllerState,
  type ExecutionControllerState,
} from '../execution/controller'
import { TransientExecutionFailure } from '../execution/advance'
import { sha256 } from '../hash'
import { ExecutionControllerOutcome } from '../execution/controller-status'
import { MarketChangeReason, marketChangedEventId } from '../execution/events'
import { CycleRunnerError } from '../cycle/runner/model'
import { DecisionReadinessReason } from '../cycle/runner/readiness'
import { OperationalError } from '../errors'
import {
  executionControllerAdvanceRunOptions,
  executionControllerAdvanceMaximumAttempts,
  executionControllerDeploymentCompletionMaximumAttempts,
  executionControllerDeploymentCompletionPollIntervalMs,
  executionControllerDeploymentHandlerTimeouts,
  executionControllerDeploymentRotationBoundMs,
  executionControllerCommandRetryPolicy,
  executionControllerHandlerTimeouts,
  executionControllerInitialTickDelayMs,
  executionControllerRecoveryTickDelayMs,
  executionControllerRecoveryTickIdempotencyKey,
  executionControllerSourceCatchUpTickIdempotencyKey,
  executionControllerTickIdempotencyKey,
  executionControllerTickRetryPolicy,
  executionActivationAuthorizationHash,
  makeBaynExecutionController as makeController,
} from './restate-execution-controller'

const fixtureTransportClock = {
  currentTimeMillisUnsafe: () => Date.parse('2026-08-13T18:00:00.000Z'),
}
const makeBaynExecutionController: typeof makeController = (configuration, runtime, hooks, transportClock) =>
  makeController(configuration, runtime, hooks, transportClock ?? fixtureTransportClock)

const controllerKey = 'a'.repeat(64)
const planHash = 'b'.repeat(64)
const sourceRevision = 'c'.repeat(40)
const producerId = '11111111-1111-4111-8111-111111111111'
const marketChange = (sequence: number, producer = producerId) => ({
  schemaVersion: 'bayn.execution-wakeup.v1' as const,
  _tag: 'MarketChanged' as const,
  sourceRevision,
  eventId: marketChangedEventId(producer, sequence),
  producerId: producer,
  sequence,
  reason: MarketChangeReason.Data,
})
const config = {
  controllerKey,
  operationTimeoutMs: 30_000,
  planHash,
  sourceRevision,
  activationAuthorizationHash: Result.getOrThrow(
    executionActivationAuthorizationHash(Buffer.alloc(32, 7).toString('base64url')),
  ),
}
const activation = {
  schemaVersion: 'bayn.execution-controller-activation.v1' as const,
  controllerKey,
  epoch: 1,
  firstSequence: 4,
  planHash,
  sourceRevision,
}

type Delivery = {
  readonly parameter: unknown
  readonly delay?: number
  readonly idempotencyKey?: string
}

const handlers = (controller: ReturnType<typeof makeBaynExecutionController>) => {
  const privateState = new Map<string, Map<string, unknown>>()
  let sends = 0
  const contextWithPrivateState = (context: TestContext): TestContext => {
    let retained = privateState.get(context.key)
    if (retained === undefined) {
      retained = new Map()
      privateState.set(context.key, retained)
    }
    const values = retained
    return {
      ...context,
      date: {
        ...context.date,
        now: async () => (context.date?.now ? context.date.now() : fixtureTransportClock.currentTimeMillisUnsafe()),
      },
      get: async (key: string) => (key === 'controller' ? context.get('controller') : (values.get(key) ?? null)),
      set: (key: string, value: ExecutionControllerState | string) => {
        if (key === 'controller') context.set('controller', Result.getOrThrow(decodeExecutionControllerState(value)))
        else values.set(key, value)
      },
      clear: (key: string) => values.delete(key),
      genericSend: (delivery: Parameters<TestContext['genericSend']>[0]) => {
        const handle: unknown = context.genericSend(delivery)
        if (typeof handle === 'object' && handle !== null && 'invocationId' in handle) return handle
        return { invocationId: Promise.resolve(InvocationIdParser.fromString(`inv_test${++sends}`)) }
      },
      invocation: (id: Parameters<TestContext['invocation']>[0]) =>
        context.invocation?.(id) ?? { cancel: () => undefined },
    } as unknown as TestContext
  }
  const object = (
    controller as unknown as {
      readonly object: {
        readonly activate: (ctx: TestContext, candidate: unknown) => Promise<ExecutionControllerState>
        readonly rotate: (ctx: TestContext, candidate: unknown) => Promise<ExecutionControllerState>
        readonly tick: (ctx: TestContext, candidate: unknown) => Promise<void>
        readonly wake: (ctx: TestContext, candidate: unknown) => Promise<void>
        readonly health: (ctx: ObjectSharedContext, candidate: unknown) => Promise<unknown>
        readonly marketChanged: (ctx: ObjectSharedContext, candidate: unknown) => Promise<void>
        readonly deactivate: (ctx: TestContext, candidate: unknown) => Promise<ExecutionControllerState>
        readonly prepareActivation: (
          ctx: ObjectSharedContext,
          candidate: unknown,
        ) => Promise<ExecutionControllerState | null>
        readonly activateDeployment: (ctx: ObjectSharedContext, candidate: unknown) => Promise<ExecutionControllerState>
      }
    }
  ).object
  return {
    ...object,
    tick: (context: TestContext, candidate: unknown) => object.tick(contextWithPrivateState(context), candidate),
    wake: (context: TestContext, candidate: unknown) => object.wake(contextWithPrivateState(context), candidate),
    rotate: (context: TestContext, candidate: unknown) => object.rotate(contextWithPrivateState(context), candidate),
    deactivate: (context: TestContext, candidate: unknown) =>
      object.deactivate(contextWithPrivateState(context), candidate),
    activateDeployment: (context: ObjectSharedContext, candidate: unknown) =>
      object.activateDeployment(
        {
          ...context,
          date: {
            ...context.date,
            now: async () => (context.date?.now ? context.date.now() : fixtureTransportClock.currentTimeMillisUnsafe()),
          },
        } as ObjectSharedContext,
        candidate,
      ),
  }
}

type TestContext = ObjectContext<{ readonly controller: ExecutionControllerState }>

test('a successful successor retires its old deadline and an executing deadline never cancels itself', async () => {
  let state: ExecutionControllerState = {
    schemaVersion: 1,
    active: true,
    epoch: 1,
    planHash,
    sourceRevision,
    initialSequence: 4,
    nextSequence: 4,
  }
  let invocationId = 'inv_initial'
  let sent = 0
  let idle = false
  let projectionFails = false
  const cancelled: string[] = []
  const object = handlers(
    makeBaynExecutionController(config, {
      prepareActivation: async () => undefined,
      projectState: async () => {
        if (projectionFails) throw new Error('Controlled deactivation projection failure')
      },
      log: async () => undefined,
      advance: async () => ({
        completedAt: '2026-08-13T18:00:01.000Z',
        outcome: {
          _tag: ExecutionControllerOutcome.Waiting,
          receiptHash: 'd'.repeat(64),
          nextDelayMs: 1,
          ...(idle ? {} : { nextWakeAt: '2026-08-13T18:00:31.000Z' }),
        },
      }),
    }),
  )
  const context = {
    key: controllerKey,
    get: async () => state,
    set: (_key: string, next: ExecutionControllerState) => {
      state = next
    },
    run: async <A>(_name: string, action: () => Promise<A>) => action(),
    genericSend: () => ({
      invocationId: Promise.resolve(InvocationIdParser.fromString(`inv_deadline${++sent}`)),
    }),
    invocation: (id: string) => ({ cancel: () => cancelled.push(id) }),
    request: () => ({ id: invocationId, attemptCompletedSignal: new AbortController().signal }),
  } as unknown as TestContext
  const advance = () =>
    object.tick(context, {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: state.epoch,
      sequence: state.nextSequence,
    })
  await advance()
  expect(cancelled).toEqual([])
  expect(sent).toBe(1)
  invocationId = 'inv_accelerated'
  await advance()
  expect(cancelled).toEqual(['inv_deadline1'])
  expect(sent).toBe(2)
  invocationId = 'inv_deadline2'
  idle = true
  await advance()
  expect(cancelled).toEqual(['inv_deadline1'])
  expect(sent).toBe(2)
  expect(state.nextDueAt).toBeUndefined()
  expect(state.nextSequence).toBe(7)
  idle = false
  await advance()
  expect(sent).toBe(3)
  const deactivation = {
    schemaVersion: 'bayn.execution-controller-deactivation.v1',
    controllerKey,
    epoch: state.epoch,
    planHash,
    sourceRevision,
  }
  projectionFails = true
  const deactivationFailure = await object.deactivate(context, deactivation).catch((cause: unknown) => cause)
  expect(deactivationFailure).toMatchObject({ message: 'Controlled deactivation projection failure' })
  expect(cancelled).toEqual(['inv_deadline1'])
  expect(state.active).toBe(true)
  projectionFails = false
  await object.deactivate(context, deactivation)
  expect(cancelled).toEqual(['inv_deadline1', 'inv_deadline3'])
  expect(state.active).toBe(false)
})

test('a prepared inference is durably dispatched and releases the account owner without ordinary chaining', async () => {
  let state: ExecutionControllerState = {
    schemaVersion: 1,
    active: true,
    epoch: 1,
    planHash,
    sourceRevision,
    initialSequence: 4,
    nextSequence: 4,
  }
  const deliveries: Array<{ service: string; method: string; parameter: unknown }> = []
  const object = handlers(
    makeBaynExecutionController(config, {
      prepareActivation: async () => undefined,
      projectState: async () => undefined,
      log: async () => undefined,
      advance: async () => ({
        completedAt: '2026-08-13T18:00:01.000Z',
        outcome: { _tag: ExecutionControllerOutcome.Waiting, receiptHash: 'd'.repeat(64), nextDelayMs: 1 },
        inferenceJobs: [
          {
            schemaVersion: 'bayn.jev-inference-job.v1',
            jobId: 'e'.repeat(64),
            batchId: 'e'.repeat(64),
            cycleId: 'f'.repeat(64),
            authorityGenerationHash: '1'.repeat(64),
            expiresAt: '2026-08-13T18:01:00.000Z',
            status: 'Prepared',
          },
        ],
      }),
    }),
  )
  const context = {
    key: controllerKey,
    get: async () => state,
    set: (_key: string, next: ExecutionControllerState) => {
      state = next
    },
    run: async <A>(_name: string, action: () => Promise<A>) => action(),
    genericSend: (delivery: { service: string; method: string; parameter: unknown }) => deliveries.push(delivery),
    request: () => ({ id: 'prepared-inference-owner', attemptCompletedSignal: new AbortController().signal }),
  } as unknown as TestContext
  await object.tick(context, { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 4 })
  expect(state.nextSequence).toBe(5)
  expect(state.nextDueAt).toBeUndefined()
  expect(deliveries).toEqual([
    expect.objectContaining({
      service: 'BaynEntryInference',
      method: 'evaluate',
      parameter: expect.objectContaining({ controllerKey, epoch: 1, jobId: 'e'.repeat(64) }),
    }),
  ])
})

test('market bursts preserve eligibility and ignore duplicate, older and foreign producer hints', async () => {
  let state: ExecutionControllerState = {
    schemaVersion: 1,
    active: true,
    epoch: 1,
    planHash,
    sourceRevision,
    initialSequence: 4,
    nextSequence: 4,
    marketEligibleAt: '2026-08-13T18:01:02.000Z',
    nextDueAt: '2026-08-13T18:01:02.000Z',
  }
  let now = Date.parse('2026-08-13T18:01:00.000Z')
  const deliveries: unknown[] = []
  const object = handlers(
    makeBaynExecutionController(config, {
      prepareActivation: async () => undefined,
      projectState: async () => undefined,
      log: async () => undefined,
      advance: async () => {
        throw new Error('a notification cannot directly execute financial work')
      },
    }),
  )
  const context = {
    key: controllerKey,
    get: async () => state,
    set: (_key: string, next: ExecutionControllerState) => {
      state = next
    },
    genericSend: (delivery: unknown) => deliveries.push(delivery),
    date: { now: async () => now },
  } as unknown as TestContext
  const event = marketChange(2)
  await object.wake(context, event)
  expect(deliveries).toHaveLength(0)
  expect(state.nextDueAt).toBe('2026-08-13T18:01:02.000Z')
  now += 2_000
  await object.wake(context, event)
  await object.wake(context, marketChange(1))
  await object.wake(context, { ...event, sourceRevision: 'a'.repeat(40) })
  expect(deliveries).toHaveLength(0)
  await object.wake(context, marketChange(3))
  expect(deliveries).toHaveLength(1)
  expect(state.marketFrontier).toEqual({ producerId, sequence: 3 })
})

test('independent market producers cannot suppress one another and share one queued account tick', async () => {
  let state: ExecutionControllerState = {
    schemaVersion: 1,
    active: true,
    epoch: 1,
    planHash,
    sourceRevision,
    initialSequence: 4,
    nextSequence: 4,
  }
  const deliveries: Delivery[] = []
  let clockReads = 0
  const object = handlers(
    makeBaynExecutionController(config, {
      prepareActivation: async () => undefined,
      projectState: async () => undefined,
      log: async () => undefined,
      advance: async () => {
        throw new Error('a hint cannot perform financial work')
      },
    }),
  )
  const context = {
    key: controllerKey,
    get: async () => state,
    set: (_key: string, next: ExecutionControllerState) => {
      state = next
    },
    genericSend: (delivery: Delivery) => deliveries.push(delivery),
    date: {
      now: async () => {
        clockReads++
        return fixtureTransportClock.currentTimeMillisUnsafe()
      },
    },
  } as unknown as TestContext
  await object.wake(context, marketChange(100))
  const replacementProducer = '22222222-2222-4222-8222-222222222222'
  await object.wake(context, marketChange(1, replacementProducer))
  await object.wake(context, marketChange(1, replacementProducer))
  expect(state.marketFrontier).toEqual({ producerId: replacementProducer, sequence: 1 })
  expect(deliveries).toHaveLength(1)
  expect(new Set(deliveries.map((delivery) => delivery.idempotencyKey))).toEqual(new Set(['bayn-execution-wake-1-4']))
  expect(state.nextSequence).toBe(4)
  expect(clockReads).toBe(1)
  expect(state.wakeAcceptedAt).toBe('2026-08-13T18:00:00.000Z')
})

test('the authenticated market gateway awaits only its small private wake and rejects invalid source or identity', async () => {
  const deliveries: unknown[] = []
  let releaseWake: () => void = () => undefined
  const wakeCompletion = new Promise<void>((resolve) => {
    releaseWake = resolve
  })
  let acknowledged = false
  const object = handlers(
    makeBaynExecutionController(config, {
      prepareActivation: async () => undefined,
      projectState: async () => undefined,
      log: async () => undefined,
      advance: async () => {
        throw new Error('the ingress cannot advance financial work')
      },
    }),
  )
  const context = {
    key: controllerKey,
    request: () => ({ headers: new Map([['authorization', `Bearer ${Buffer.alloc(32, 7).toString('base64url')}`]]) }),
    genericCall: (delivery: unknown) => {
      deliveries.push(delivery)
      return wakeCompletion
    },
    objectClient: () => {
      throw new Error('the gateway cannot wait for the exclusive owner')
    },
  } as unknown as ObjectSharedContext
  const event = marketChange(1)
  const acknowledgement = object.marketChanged(context, event).then(() => {
    acknowledged = true
  })
  expect(acknowledged).toBe(false)
  expect(deliveries).toHaveLength(1)
  expect(deliveries[0]).toMatchObject({ service: 'BaynExecutionController', method: 'wake', parameter: event })
  releaseWake()
  await acknowledgement
  expect(acknowledged).toBe(true)
  expect(
    await object.marketChanged(context, { ...event, sourceRevision: 'd'.repeat(40) }).catch((cause: unknown) => cause),
  ).toMatchObject({
    code: 412,
    message: `market change source is not registered: expected ${'d'.repeat(40)}, served ${sourceRevision}`,
  })
  expect(
    await object.marketChanged(context, { ...event, eventId: 'd'.repeat(64) }).catch((cause: unknown) => cause),
  ).toBeInstanceOf(TerminalError)
  expect(
    await object
      .marketChanged({ ...context, request: () => ({ headers: new Map() }) } as unknown as ObjectSharedContext, event)
      .catch((cause: unknown) => cause),
  ).toMatchObject({ code: 403 })
  expect(deliveries).toHaveLength(1)
})

test.each(['broker', 'market-boundary'] as const)(
  'failed reconciliation retains market backoff and releases on %s',
  async (recovery) => {
    let now = Date.parse('2026-08-13T18:00:01.000Z')
    let state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 1,
      planHash,
      sourceRevision,
      initialSequence: 4,
      nextSequence: 4,
    }
    const deliveries: unknown[] = []
    const object = handlers(
      makeBaynExecutionController(config, {
        prepareActivation: async () => undefined,
        projectState: async () => undefined,
        log: async () => undefined,
        advance: async () => ({
          completedAt: '2026-08-13T18:00:00.000Z',
          observation: {
            result: 'FAILURE',
            observedAt: '2026-08-13T18:00:00.000Z',
            operation: 'reconcile',
            failure: 'market-data',
            message: 'Broker observation is unavailable or invalidated by a mutation',
          },
          outcome: {
            _tag: ExecutionControllerOutcome.Blocked,
            receiptHash: 'd'.repeat(64),
            nextDelayMs: 30_000,
            nextWakeAt: '2026-08-13T18:00:30.000Z',
          },
        }),
      }),
    )
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        state = next
      },
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      genericSend: (delivery: unknown) => deliveries.push(delivery),
      request: () => ({ id: 'broker-retry-eligibility', attemptCompletedSignal: new AbortController().signal }),
      date: { now: async () => now },
    } as unknown as TestContext
    await object.tick(context, { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 4 })
    expect(state.marketEligibleAt).toBe('2026-08-13T18:00:30.000Z')
    expect(state.nextDueAt).toBe(state.marketEligibleAt)
    for (let sequence = 1; sequence <= 100; sequence++) await object.wake(context, marketChange(sequence))
    expect(deliveries).toHaveLength(1)
    expect(state.marketFrontier?.sequence).toBe(100)
    if (recovery === 'market-boundary') {
      now = Date.parse('2026-08-13T18:00:30.000Z')
      await object.wake(context, marketChange(101))
    } else
      await object.wake(context, {
        schemaVersion: 'bayn.execution-wakeup.v1',
        _tag: 'BrokerObservation',
        sourceRevision,
        eventId: 'a'.repeat(64),
        snapshotHash: 'b'.repeat(64),
        observedAt: '2026-08-13T18:00:01.000Z',
      })
    expect(deliveries).toHaveLength(2)
    expect(state.wakeScheduledSequence).toBe(5)
  },
)

test.each(['broker', 'inference', 'Startup', 'Ready', 'Recovery'] as const)(
  'a closed owner without a deadline ignores quote bursts until %s supplies relevant work',
  async (wake) => {
    let state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 1,
      planHash,
      sourceRevision,
      initialSequence: 4,
      nextSequence: 4,
    }
    const deliveries: unknown[] = []
    let advances = 0
    const object = handlers(
      makeBaynExecutionController(config, {
        prepareActivation: async () => undefined,
        projectState: async () => undefined,
        log: async () => undefined,
        advance: async () => {
          advances++
          return {
            completedAt: '2026-08-13T18:00:00.000Z',
            ...(advances === 1
              ? {
                  observation: {
                    result: 'SUCCESS' as const,
                    outcome: 'WINDOW_CLOSED' as const,
                    observedAt: '2026-08-13T18:00:00.000Z',
                  },
                }
              : {}),
            outcome: {
              _tag: ExecutionControllerOutcome.Waiting,
              receiptHash: 'd'.repeat(64),
              nextDelayMs: 30_000,
            },
          }
        },
      }),
    )
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        state = next
      },
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      genericSend: (delivery: unknown) => deliveries.push(delivery),
      request: () => ({ id: 'closed-owner', attemptCompletedSignal: new AbortController().signal }),
      date: { now: async () => Date.parse('2026-08-13T18:00:01.000Z') },
    } as unknown as TestContext
    await object.tick(context, { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 4 })
    state = Result.getOrThrow(decodeExecutionControllerState(JSON.parse(JSON.stringify(state))))
    for (let sequence = 1; sequence <= 100; sequence++) await object.wake(context, marketChange(sequence))
    expect(deliveries).toHaveLength(0)
    expect(advances).toBe(1)
    expect(state.marketFrontier?.sequence).toBe(100)
    expect(state.nextDueAt).toBeUndefined()
    if (wake === 'broker')
      await object.wake(context, {
        schemaVersion: 'bayn.execution-wakeup.v1',
        _tag: 'BrokerObservation',
        sourceRevision,
        eventId: 'a'.repeat(64),
        snapshotHash: 'e'.repeat(64),
        observedAt: '2026-08-13T18:00:01.000Z',
      })
    else if (wake === 'inference')
      await object.wake(context, {
        schemaVersion: 'bayn.execution-wakeup.v1',
        _tag: 'InferenceCompleted',
        sourceRevision,
        eventId: 'a'.repeat(64),
        epoch: 1,
        jobId: '1'.repeat(64),
        batchId: '2'.repeat(64),
        cycleId: '3'.repeat(64),
        authorityGenerationHash: '4'.repeat(64),
        expiresAt: '2026-08-13T18:00:10.000Z',
        completedAt: '2026-08-13T18:00:01.000Z',
      })
    else await object.wake(context, { ...marketChange(101), reason: MarketChangeReason[wake] })
    expect(deliveries).toHaveLength(1)
    expect(state.wakeScheduledSequence).toBe(5)
    await object.tick(context, { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 5 })
    await object.wake(context, marketChange(102))
    expect(deliveries).toHaveLength(2)
    expect(state.wakeScheduledSequence).toBe(6)
  },
)

test('closed-session completion retains the next eligibility boundary against unrelated market bursts', async () => {
  let state: ExecutionControllerState = {
    schemaVersion: 1,
    active: true,
    epoch: 1,
    planHash,
    sourceRevision,
    initialSequence: 4,
    nextSequence: 4,
  }
  const deliveries: unknown[] = []
  const nextWakeAt = '2026-08-14T13:31:02.000Z'
  const object = handlers(
    makeBaynExecutionController(config, {
      prepareActivation: async () => undefined,
      projectState: async () => undefined,
      log: async () => undefined,
      advance: async () => ({
        completedAt: '2026-08-13T18:00:00.000Z',
        observation: { result: 'SUCCESS', outcome: 'WINDOW_CLOSED', observedAt: '2026-08-13T18:00:00.000Z' },
        outcome: { _tag: ExecutionControllerOutcome.Waiting, receiptHash: 'd'.repeat(64), nextDelayMs: 1, nextWakeAt },
      }),
    }),
  )
  const context = {
    key: controllerKey,
    get: async () => state,
    set: (_key: string, next: ExecutionControllerState) => {
      state = next
    },
    run: async <A>(_name: string, action: () => Promise<A>) => action(),
    genericSend: (delivery: unknown) => deliveries.push(delivery),
    request: () => ({ id: 'closed-session-eligibility', attemptCompletedSignal: new AbortController().signal }),
    date: { now: async () => Date.parse('2026-08-13T18:00:01.000Z') },
  } as unknown as TestContext
  await object.tick(context, { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 4 })
  expect(state.marketEligibleAt).toBe(nextWakeAt)
  await object.wake(context, marketChange(1))
  expect(deliveries).toHaveLength(1)
  expect(state.nextDueAt).toBe(nextWakeAt)
})

test.each([
  'BROKER_OBSERVATION_PENDING',
  'POST_MUTATION_RECONCILIATION',
  DecisionReadinessReason.DecisionPending,
  DecisionReadinessReason.InferenceUnavailable,
] as const)(
  'market bursts preserve the original %s boundary while completion events accelerate',
  async (waitReason) => {
    for (const completion of ['BrokerObservation', 'InferenceCompleted'] as const) {
      let state: ExecutionControllerState = {
        schemaVersion: 1,
        active: true,
        epoch: 1,
        planHash,
        sourceRevision,
        initialSequence: 4,
        nextSequence: 4,
      }
      const deliveries: unknown[] = []
      const nextWakeAt = '2026-08-13T18:00:30.000Z'
      let advances = 0
      const object = handlers(
        makeBaynExecutionController(config, {
          prepareActivation: async () => undefined,
          projectState: async () => undefined,
          log: async () => undefined,
          advance: async () => {
            advances++
            return {
              completedAt: '2026-08-13T18:00:01.000Z',
              observation:
                waitReason === 'BROKER_OBSERVATION_PENDING'
                  ? {
                      result: 'SUCCESS',
                      outcome: 'WAITING',
                      waitReason,
                      observedAt: '2026-08-13T18:00:01.000Z',
                    }
                  : {
                      result: 'SUCCESS',
                      outcome: 'RECOVERED',
                      recoveryAction: 'WAITING',
                      ...(waitReason === 'POST_MUTATION_RECONCILIATION'
                        ? { waitReason }
                        : {
                            readiness: {
                              reason: waitReason,
                              availableAt: nextWakeAt,
                              message: 'Awaiting the committed inference result',
                            },
                          }),
                      observedAt: '2026-08-13T18:00:01.000Z',
                    },
              outcome: {
                _tag: ExecutionControllerOutcome.Waiting,
                receiptHash: 'd'.repeat(64),
                nextDelayMs: 1,
                nextWakeAt,
              },
            }
          },
        }),
      )
      const context = {
        key: controllerKey,
        get: async () => state,
        set: (_key: string, next: ExecutionControllerState) => {
          state = next
        },
        run: async <A>(_name: string, action: () => Promise<A>) => action(),
        genericSend: (delivery: unknown) => deliveries.push(delivery),
        request: () => ({ id: 'broker-wait-eligibility', attemptCompletedSignal: new AbortController().signal }),
        date: { now: async () => Date.parse('2026-08-13T18:00:02.000Z') },
      } as unknown as TestContext
      await object.tick(context, { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 4 })
      deliveries.length = 0
      await object.wake(context, marketChange(1))
      await object.wake(context, marketChange(2))
      await object.wake(context, marketChange(3))
      expect(deliveries).toHaveLength(0)
      expect(state.marketEligibleAt).toBe(nextWakeAt)
      expect(state.nextDueAt).toBe(nextWakeAt)
      const common = {
        schemaVersion: 'bayn.execution-wakeup.v1',
        sourceRevision,
        eventId: 'e'.repeat(64),
      }
      await object.wake(
        context,
        completion === 'BrokerObservation'
          ? { ...common, _tag: completion, snapshotHash: 'f'.repeat(64), observedAt: '2026-08-13T18:00:02.000Z' }
          : {
              ...common,
              _tag: completion,
              epoch: 1,
              jobId: '1'.repeat(64),
              batchId: '2'.repeat(64),
              cycleId: '3'.repeat(64),
              authorityGenerationHash: '4'.repeat(64),
              expiresAt: '2026-08-13T18:00:10.000Z',
              completedAt: '2026-08-13T18:00:02.000Z',
            },
      )
      expect(deliveries).toEqual([
        expect.objectContaining({
          service: 'BaynExecutionController',
          method: 'tick',
          parameter: { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 5 },
        }),
      ])
      expect(state.nextDueAt).toBe(nextWakeAt)
      expect(advances).toBe(1)
    }
  },
)

test.each(['POST_MUTATION_RECONCILIATION', 'PROTECTION_EXIT_COMMITTED'] as const)(
  'an accepted %s outcome requests one quota-bound canonical refresh',
  async (waitReason) => {
    let state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 1,
      planHash,
      sourceRevision,
      initialSequence: 4,
      nextSequence: 4,
    }
    const deliveries: unknown[] = []
    const object = handlers(
      makeBaynExecutionController(config, {
        prepareActivation: async () => undefined,
        projectState: async () => undefined,
        log: async () => undefined,
        advance: async () => ({
          completedAt: '2026-08-13T18:00:01.000Z',
          observation: {
            result: 'SUCCESS',
            outcome: 'RECOVERED',
            recoveryAction: 'WAITING',
            waitReason,
            observedAt: '2026-08-13T18:00:01.000Z',
          },
          outcome: { _tag: ExecutionControllerOutcome.Waiting, receiptHash: 'd'.repeat(64), nextDelayMs: 1 },
        }),
      }),
    )
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        state = next
      },
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      genericSend: (delivery: unknown) => deliveries.push(delivery),
      request: () => ({ id: 'post-mutation-refresh', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const tick = { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 4 }
    await object.tick(context, tick)
    await object.tick(context, tick)
    expect(deliveries).toEqual([
      expect.objectContaining({
        service: 'BaynBrokerObservations',
        method: 'refresh',
        key: controllerKey,
        parameter: { sourceRevision },
        idempotencyKey: 'bayn-post-mutation-refresh-1-4',
      }),
    ])
  },
)

test.each([
  { absoluteWake: true, replayed: false, liveAt: '2026-08-13T18:00:05.000Z', delay: 2_000 },
  { absoluteWake: true, replayed: true, liveAt: '2026-08-13T18:00:05.000Z', delay: 2_000 },
  { absoluteWake: true, replayed: true, liveAt: '2026-08-13T18:01:00.000Z', delay: 1 },
  { absoluteWake: false, replayed: false, liveAt: '2026-08-13T18:00:03.000Z', delay: 1_000 },
  { absoluteWake: false, replayed: false, liveAt: '2026-08-13T18:00:03.750Z', delay: 250 },
  { absoluteWake: false, replayed: true, liveAt: '2026-08-13T18:00:03.750Z', delay: 250 },
  { absoluteWake: false, replayed: false, liveAt: '2026-08-13T18:00:05.000Z', delay: 1 },
  { absoluteWake: false, replayed: true, liveAt: '2026-08-13T18:01:00.000Z', delay: 1 },
  { absoluteWake: false, replayed: false, liveAt: '2026-08-13T18:00:02.000Z', delay: 1_000 },
])(
  'successor wait uses its persisted due time after worker replay or a pre-send crash (%j)',
  async ({ absoluteWake, replayed, liveAt, delay }) => {
    let state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 1,
      planHash,
      sourceRevision,
      initialSequence: 4,
      nextSequence: 4,
    }
    const deliveries: Delivery[] = []
    const events: string[] = []
    const result = {
      completedAt: '2026-08-13T18:00:03.000Z',
      outcome: {
        _tag: ExecutionControllerOutcome.Waiting,
        receiptHash: 'd'.repeat(64),
        nextDelayMs: absoluteWake ? 8_000 : 1_000,
        ...(absoluteWake ? { nextWakeAt: '2026-08-13T18:00:07.000Z' } : {}),
      },
    }
    const controller = handlers(
      makeBaynExecutionController(
        config,
        {
          advance: async () => {
            events.push('advance')
            return result
          },
          log: async () => undefined,
          prepareActivation: () => Promise.resolve(),
          projectState: async () => undefined,
        },
        [],
        {
          currentTimeMillisUnsafe: () => {
            events.push('transport-clock')
            return Date.parse(liveAt)
          },
        },
      ),
    )
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, value: ExecutionControllerState) => {
        state = value
        events.push('set')
      },
      run: async (_name: string, action: () => Promise<unknown>) => (replayed ? result : action()),
      genericSend: (delivery: Delivery) => {
        deliveries.push(delivery)
        events.push('send')
      },
      date: {
        toJSON: async () => {
          events.push('clock')
          return '2026-08-13T18:00:05.000Z'
        },
      },
      request: () => ({ id: 'successor-wait-fixture', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    await controller.tick(context, {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 1,
      sequence: 4,
      issuedAt: '2026-08-13T18:00:00.000Z',
    })
    expect(state.nextDueAt).toBe(absoluteWake ? '2026-08-13T18:00:07.000Z' : undefined)
    if (!absoluteWake) {
      expect(deliveries).toHaveLength(0)
      expect(events).toEqual(replayed ? ['set', 'transport-clock'] : ['advance', 'set', 'transport-clock'])
      return
    }
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      delay,
      idempotencyKey: executionControllerTickIdempotencyKey(1, 5, 0),
      parameter: { epoch: 1, sequence: 5, attempt: 0 },
    })
    expect(events).toEqual(
      replayed ? ['set', 'transport-clock', 'send'] : ['advance', 'set', 'transport-clock', 'send'],
    )
  },
)

describe('native Restate execution controller', () => {
  test('journals time with advance, waits for its durable result, and replays without resampling receipt time', async () => {
    const initial: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 1,
      planHash,
      sourceRevision,
      initialSequence: 4,
      nextSequence: 4,
    }
    let state = initial
    const deliveries: Delivery[] = []
    const commands: Array<Parameters<Parameters<typeof makeBaynExecutionController>[1]['advance']>[0]> = []
    const advanced = Promise.withResolvers<void>()
    const durable = Promise.withResolvers<void>()
    let now = Date.parse('2026-08-13T18:00:00.000Z')
    let recorded: unknown
    let replay = false
    let runCount = 0
    const object = handlers(
      makeBaynExecutionController(
        config,
        {
          advance: async (command) => {
            commands.push(command)
            advanced.resolve()
            return {
              completedAt: command.issuedAt,
              outcome: {
                _tag: ExecutionControllerOutcome.Waiting,
                receiptHash: 'd'.repeat(64),
                nextDelayMs: 1_000,
                nextWakeAt: '2026-08-13T18:00:01.000Z',
              },
            }
          },
          log: async () => undefined,
          prepareActivation: async () => undefined,
          projectState: async () => undefined,
        },
        [],
        { currentTimeMillisUnsafe: () => now },
      ),
    )
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, value: ExecutionControllerState) => {
        state = value
      },
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
      run: async (_name: string, action: () => Promise<unknown>) => {
        runCount += 1
        if (!replay) recorded = JSON.parse(JSON.stringify(await action()))
        await durable.promise
        return recorded
      },
      date: {
        toJSON: async () => {
          throw new Error('A separate durable clock boundary is forbidden')
        },
      },
      request: () => ({ id: 'combined-clock-advance', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const tick = { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 4 }
    const first = object.tick(context, tick)
    await advanced.promise
    expect(state).toEqual(initial)
    expect(deliveries).toHaveLength(0)
    now += 19_000
    durable.resolve()
    await first
    const completed = state
    expect(commands).toHaveLength(1)
    expect(commands[0]?.issuedAt).toBe('2026-08-13T18:00:00.000Z')
    expect(runCount).toBe(1)
    expect(deliveries[0]).toMatchObject({ delay: 1, idempotencyKey: executionControllerTickIdempotencyKey(1, 5, 0) })
    state = initial
    replay = true
    now += 60_000
    await object.tick(context, tick)
    expect(commands).toHaveLength(1)
    expect(state).toEqual(completed)
    expect(deliveries[1]).toEqual(deliveries[0])
  })

  test('uses bounded pause-on-exhaustion policies and a complete command timeout', () => {
    expect(executionControllerInitialTickDelayMs).toBe(0)
    expect(executionControllerRecoveryTickDelayMs).toBe(30_000)
    expect(executionControllerAdvanceRunOptions).toEqual({ maxRetryAttempts: 0 })
    expect(executionControllerAdvanceMaximumAttempts(false)).toBe(3)
    expect(executionControllerAdvanceMaximumAttempts(true)).toBe(7)
    expect(executionControllerTickRetryPolicy).toEqual({
      maxAttempts: 3,
      onMaxAttempts: 'pause',
      initialInterval: 1_000,
      maxInterval: 10_000,
      exponentiationFactor: 2,
    })
    expect(executionControllerCommandRetryPolicy).toMatchObject({ maxAttempts: 3, onMaxAttempts: 'pause' })
    expect(executionControllerHandlerTimeouts(30_000)).toEqual({
      inactivityTimeout: 450_000,
      abortTimeout: 30_000,
    })
    expect(executionControllerDeploymentRotationBoundMs(30_000)).toBe(480_000)
    expect(executionControllerDeploymentCompletionPollIntervalMs).toBe(5_000)
    expect(executionControllerDeploymentCompletionMaximumAttempts(30_000)).toBe(85)
    expect(executionControllerDeploymentHandlerTimeouts(30_000)).toEqual({
      inactivityTimeout: 480_000,
      abortTimeout: 30_000,
    })
  })

  test('serializes null activation into one first pass and its explicit recovery deadline', async () => {
    let state: ExecutionControllerState | null = null
    const deliveries: Delivery[] = []
    const events: string[] = []
    const calls: Array<{
      readonly command: Parameters<Parameters<typeof makeBaynExecutionController>[1]['advance']>[0]
      readonly signal: AbortSignal
    }> = []
    const attempt = new AbortController()
    const projectedStates: ExecutionControllerState[] = []
    const runtime = {
      advance: async (command: (typeof calls)[number]['command'], signal: AbortSignal) => {
        calls.push({ command, signal })
        events.push('advance-completed')
        return {
          completedAt: '2026-08-13T18:00:01.000Z',
          observation: {
            result: 'SUCCESS' as const,
            observedAt: '2026-08-13T18:00:01.000Z',
            outcome: 'WINDOW_CLOSED' as const,
          },
          outcome: {
            _tag: ExecutionControllerOutcome.Blocked,
            receiptHash: 'd'.repeat(64),
            nextDelayMs: 30_000,
            nextWakeAt: '2026-08-13T18:00:31.000Z',
          },
        }
      },
      log: () => Promise.reject(new Error('telemetry unavailable')),
      prepareActivation: () => Promise.resolve(),
      projectState: async (_key: string, next: ExecutionControllerState) => {
        projectedStates.push(next)
        events.push(next.active ? 'activation-projected' : 'deactivation-projected')
      },
    }
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        events.push('state-committed')
        state = next
      },
      genericSend: (delivery: Delivery) => {
        events.push(
          delivery.delay === executionControllerInitialTickDelayMs ? 'first-pass-scheduled' : 'successor-scheduled',
        )
        deliveries.push(delivery)
      },
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      date: { toJSON: async () => '2026-08-13T18:00:00.000Z' },
      request: () => ({ id: 'invocation-1', attemptCompletedSignal: attempt.signal }),
    } as unknown as TestContext
    const object = handlers(makeBaynExecutionController(config, runtime))

    expect(await object.activate(context, activation)).toMatchObject({ active: true, epoch: 1, nextSequence: 4 })
    expect(projectedStates).toHaveLength(1)
    expect(projectedStates[0]).toMatchObject({ active: true, epoch: 1, nextSequence: 4 })
    expect(deliveries).toHaveLength(1)
    expect(events).toEqual(['activation-projected', 'state-committed', 'first-pass-scheduled'])
    expect(deliveries[0]).toMatchObject({
      delay: 0,
      idempotencyKey: executionControllerTickIdempotencyKey(1, 4, 0),
      parameter: { epoch: 1, sequence: 4, attempt: 0 },
    })

    const firstTick = deliveries.shift()
    if (firstTick === undefined) throw new Error('activation did not schedule the first tick')
    await object.tick(context, firstTick.parameter)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      command: {
        controllerKey,
        epoch: 1,
        sequence: 4,
        issuedAt: '2026-08-13T18:00:00.000Z',
        sourceRevision,
      },
      signal: attempt.signal,
    })
    expect(state).toMatchObject({
      active: true,
      epoch: 1,
      nextSequence: 5,
      lastCompletion: {
        sequence: 4,
        outcome: 'Blocked',
      },
      nextDueAt: '2026-08-13T18:00:31.000Z',
    })
    expect((state as ExecutionControllerState | null)?.lastCompletion).not.toHaveProperty('lastPass')
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      delay: 31_000,
      idempotencyKey: executionControllerTickIdempotencyKey(1, 5, 0),
      parameter: { epoch: 1, sequence: 5, attempt: 0 },
    })
    expect(events.slice(-3)).toEqual(['advance-completed', 'state-committed', 'successor-scheduled'])

    await object.tick(context, firstTick.parameter)
    expect(calls).toHaveLength(1)
    expect(deliveries).toHaveLength(1)

    await object.deactivate(context, {
      schemaVersion: 'bayn.execution-controller-deactivation.v1',
      controllerKey,
      epoch: 1,
      planHash,
      sourceRevision,
    })
    expect(state).toMatchObject({ active: false, epoch: 2 })
    expect(projectedStates).toHaveLength(2)
    expect(projectedStates[1]).toMatchObject({ active: false, epoch: 2, nextSequence: 5 })
    const pending = deliveries.shift()
    if (pending === undefined) throw new Error('completed tick did not schedule its successor')
    await object.tick(context, pending.parameter)
    expect(calls).toHaveLength(1)
    expect(deliveries).toHaveLength(0)
  })

  test('explicit reactivation deduplicates replay but can retry an exhausted revision-bound probe', async () => {
    const state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: activation.epoch,
      planHash,
      sourceRevision,
      initialSequence: activation.firstSequence,
      nextSequence: activation.firstSequence,
    }
    const deliveries: Delivery[] = []
    const normalKey = executionControllerTickIdempotencyKey(state.epoch, state.nextSequence, 0)
    const acceptedKeys = new Set([
      normalKey,
      executionControllerSourceCatchUpTickIdempotencyKey(state.epoch, state.nextSequence, 0, sourceRevision),
    ])
    let invocationId = 'source-catch-up'
    let committed = false
    const context = {
      key: controllerKey,
      get: async () => state,
      set: () => {
        committed = true
      },
      genericSend: (delivery: Delivery) => {
        if (delivery.idempotencyKey === undefined || acceptedKeys.has(delivery.idempotencyKey)) return
        acceptedKeys.add(delivery.idempotencyKey)
        deliveries.push(delivery)
      },
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      request: () => ({ id: invocationId, attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(config, {
        advance: () => Promise.reject(new Error('activation must not advance inline')),
        log: () => Promise.resolve(),
        prepareActivation: () => Promise.resolve(),
        projectState: () => Promise.resolve(),
      }),
    )

    expect(await object.activate(context, activation)).toEqual(state)
    expect(await object.activate(context, activation)).toEqual(state)
    expect(committed).toBe(false)
    expect(deliveries).toEqual([
      expect.objectContaining({
        delay: executionControllerInitialTickDelayMs,
        idempotencyKey: executionControllerRecoveryTickIdempotencyKey(
          state.epoch,
          state.nextSequence,
          0,
          sha256(invocationId),
        ),
        parameter: expect.objectContaining({
          epoch: state.epoch,
          sequence: state.nextSequence,
          attempt: 0,
          sourceCatchUpRevision: sourceRevision,
        }),
      }),
    ])
    expect(deliveries[0]?.idempotencyKey).not.toBe(normalKey)
    invocationId = 'new-explicit-recovery'
    expect(await object.activate(context, activation)).toEqual(state)
    expect(deliveries).toHaveLength(2)
    expect(deliveries[1]?.idempotencyKey).not.toBe(deliveries[0]?.idempotencyKey)
    expect(deliveries[1]?.parameter).toMatchObject({
      epoch: state.epoch,
      sequence: state.nextSequence,
      sourceCatchUpRevision: sourceRevision,
    })
  })

  test('quiesces a source catch-up routed to a different immutable worker', async () => {
    const state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 7,
      planHash,
      sourceRevision,
      initialSequence: 12,
      nextSequence: 12,
    }
    const logged: string[] = []
    let advances = 0
    const context = {
      key: controllerKey,
      get: async () => state,
      set: () => undefined,
      genericSend: () => undefined,
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      request: () => ({ id: 'foreign-catch-up', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(config, {
        advance: () => {
          advances += 1
          return Promise.reject(new Error('foreign catch-up must not advance'))
        },
        log: (_level, message) => {
          logged.push(message)
          return Promise.resolve()
        },
        prepareActivation: () => Promise.resolve(),
        projectState: () => Promise.resolve(),
      }),
    )

    await object.tick(context, {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 7,
      sequence: 12,
      sourceCatchUpRevision: 'f'.repeat(40),
    })

    expect(advances).toBe(0)
    expect(logged).toEqual(['Bayn execution controller quiesced a foreign source catch-up'])
  })

  test('fails activation closed before Restate state or scheduling when durable projection fails', async () => {
    let state: ExecutionControllerState | null = null
    let sets = 0
    const deliveries: Delivery[] = []
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        sets += 1
        state = next
      },
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      request: () => ({ id: 'activation-projection-failed', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(config, {
        advance: () => Promise.reject(new Error('must not advance')),
        log: () => Promise.resolve(),
        prepareActivation: () => Promise.resolve(),
        projectState: () => Promise.reject(new Error('postgres unavailable')),
      }),
    )

    expect(object.activate(context, activation)).rejects.toThrow('postgres unavailable')
    expect(state).toBeNull()
    expect(sets).toBe(0)
    expect(deliveries).toHaveLength(0)
  })

  test('fails closed on conflicting activation without scheduling work', async () => {
    const state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 1,
      planHash,
      sourceRevision,
      initialSequence: 0,
      nextSequence: 0,
    }
    const deliveries: Delivery[] = []
    const context = {
      key: controllerKey,
      get: async () => state,
      set: () => undefined,
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
      request: () => ({ id: 'invocation-2', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(config, {
        advance: () => Promise.reject(new Error('must not advance')),
        log: () => Promise.resolve(),
        prepareActivation: () => Promise.resolve(),
        projectState: () => Promise.resolve(),
      }),
    )

    let activationFailure: unknown
    try {
      await object.activate(context, { ...activation, firstSequence: 1 })
    } catch (cause) {
      activationFailure = cause
    }
    expect(activationFailure).toBeInstanceOf(Error)
    expect((activationFailure as Error).message).toBe(
      'execution controller activation conflicts with durable controller state',
    )
    expect(deliveries).toHaveLength(0)
  })

  test('deactivates only the exact durable owner binding', async () => {
    const previousBinding = { planHash: 'd'.repeat(64), sourceRevision: 'e'.repeat(40) }
    let state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 6,
      ...previousBinding,
      initialSequence: 3,
      nextSequence: 9,
    }
    let projections = 0
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        state = next
      },
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      request: () => ({ id: 'deactivate-previous', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(config, {
        advance: () => Promise.reject(new Error('must not advance')),
        log: () => Promise.resolve(),
        prepareActivation: () => Promise.resolve(),
        projectState: () => {
          projections += 1
          return Promise.resolve()
        },
      }),
    )

    await object.deactivate(context, {
      schemaVersion: 'bayn.execution-controller-deactivation.v1',
      controllerKey,
      epoch: 6,
      ...previousBinding,
    })
    expect(state).toMatchObject({ active: false, epoch: 7, ...previousBinding })
    expect(projections).toBe(1)

    expect(
      object.deactivate(context, {
        schemaVersion: 'bayn.execution-controller-deactivation.v1',
        controllerKey,
        epoch: 7,
        planHash: 'f'.repeat(64),
        sourceRevision: previousBinding.sourceRevision,
      }),
    ).rejects.toThrow('execution controller deactivation conflicts with durable controller state')
    expect(projections).toBe(1)
  })

  test('rejects sequence exhaustion before the durable advance step', async () => {
    const state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 3,
      planHash,
      sourceRevision,
      initialSequence: Number.MAX_SAFE_INTEGER,
      nextSequence: Number.MAX_SAFE_INTEGER,
    }
    let advances = 0
    const deliveries: Delivery[] = []
    const context = {
      key: controllerKey,
      get: async () => state,
      set: () => undefined,
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
      date: { toJSON: async () => '2026-08-13T18:00:00.000Z' },
      request: () => ({ id: 'invocation-exhausted', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(config, {
        advance: () => {
          advances += 1
          return Promise.reject(new Error('must not advance'))
        },
        log: () => Promise.resolve(),
        prepareActivation: () => Promise.resolve(),
        projectState: () => Promise.resolve(),
      }),
    )

    let failure: unknown
    try {
      await object.tick(context, {
        schemaVersion: 'bayn.execution-controller-tick.v1',
        epoch: state.epoch,
        sequence: Number.MAX_SAFE_INTEGER,
      })
    } catch (cause) {
      failure = cause
    }

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toBeInstanceOf(TerminalError)
    expect((failure as TerminalError).code).toBe(400)
    expect((failure as Error).message).toBe('execution controller sequence is exhausted before advance')
    expect(advances).toBe(0)
    expect(deliveries).toHaveLength(0)
  })

  test('quiesces a delayed tick with a foreign plan before advancing', async () => {
    const state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 3,
      planHash: 'd'.repeat(64),
      sourceRevision,
      initialSequence: 8,
      nextSequence: 8,
    }
    let advances = 0
    const context = {
      key: controllerKey,
      get: async () => state,
      set: () => undefined,
      genericSend: () => undefined,
      request: () => ({ id: 'stale-deployment', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(config, {
        advance: () => {
          advances += 1
          return Promise.reject(new Error('must not advance'))
        },
        log: () => Promise.resolve(),
        prepareActivation: () => Promise.resolve(),
        projectState: () => Promise.resolve(),
      }),
    )

    await object.tick(context, {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: state.epoch,
      sequence: state.nextSequence,
    })
    expect(advances).toBe(0)
  })

  test('quiesces a foreign durable binding until authenticated activation rotates it', async () => {
    const previousBinding = { planHash: 'd'.repeat(64), sourceRevision: 'e'.repeat(40) }
    const state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 3,
      ...previousBinding,
      initialSequence: 8,
      nextSequence: 8,
    }
    let advances = 0
    const deliveries: Delivery[] = []
    const context = {
      key: controllerKey,
      get: async () => state,
      set: () => undefined,
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
      request: () => ({ id: 'previous-binding', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(config, {
        advance: () => {
          advances += 1
          return Promise.reject(new Error('must not advance'))
        },
        log: () => Promise.resolve(),
        prepareActivation: () => Promise.resolve(),
        projectState: () => Promise.resolve(),
      }),
    )

    await object.tick(context, {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: state.epoch,
      sequence: state.nextSequence,
    })

    expect(advances).toBe(0)
    expect(deliveries).toHaveLength(0)
  })

  test('authenticates deployment activation and derives activation counters from durable state', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    const state: ExecutionControllerState = {
      schemaVersion: 1,
      active: false,
      epoch: 7,
      planHash,
      sourceRevision,
      initialSequence: 11,
      nextSequence: 17,
    }
    const completedState: ExecutionControllerState = {
      ...state,
      active: true,
      nextSequence: 19,
      lastCompletion: {
        sequence: 18,
        outcome: ExecutionControllerOutcome.Blocked,
        receiptHash: 'f'.repeat(64),
        completedAt: '2026-08-13T18:00:01.000Z',
      },
      nextDueAt: '2026-08-13T18:00:31.000Z',
    }
    let forwarded: unknown
    let genericCalls = 0
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      prepareActivation: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const start = handlers(controller).activateDeployment
    const context = {
      key: controllerKey,
      request: () => ({
        id: 'deployment-authorized',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => ({
        prepareActivation: async () => state,
        status: async () => state,
        activate: async (request: unknown) => {
          forwarded = request
          return completedState
        },
      }),
      sleep: () => Promise.reject(new Error('completed activation must not poll')),
      genericCall: (command: { service: string; method: string; key: string; parameter: unknown }) => {
        genericCalls += 1
        expect(command).toMatchObject({
          service: 'BaynBrokerObservations',
          method: 'activate',
          key: controllerKey,
          parameter: { sourceRevision },
        })
        return Promise.resolve({
          sourceRevision,
          epoch: 1,
          sequence: 1,
          captureScheduled: false,
          nextCaptureNotBeforeMs: 0,
          lastSnapshotHash: 'a'.repeat(64),
        })
      },
    } as unknown as ObjectSharedContext

    await start(context, {
      schemaVersion: 'bayn.execution-deployment-activation.v2',
      controllerKey,
      planHash,
      sourceRevision,
    })

    expect(forwarded).toEqual({
      schemaVersion: 'bayn.execution-controller-activation.v1',
      controllerKey,
      epoch: 7,
      firstSequence: 17,
      planHash,
      sourceRevision,
    })
    expect(genericCalls).toBe(1)
  })

  test('does not activate execution while the broker poll has no published cut and waiting is interrupted', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      prepareActivation: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    let activations = 0
    const context = {
      key: controllerKey,
      request: () => ({
        id: 'deployment-missing-observation',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => ({
        prepareActivation: async () => null,
        status: async () => null,
        activate: async () => {
          activations += 1
        },
      }),
      genericCall: async () => ({
        sourceRevision,
        epoch: 1,
        sequence: 1,
        captureScheduled: false,
        nextCaptureNotBeforeMs: 0,
      }),
      sleep: async () => {
        throw new Error('readiness wait interrupted')
      },
    } as unknown as ObjectSharedContext
    const failure = await handlers(controller)
      .activateDeployment(context, {
        schemaVersion: 'bayn.execution-deployment-activation.v2',
        controllerKey,
        planHash,
        sourceRevision,
      })
      .catch((cause: unknown) => cause)
    expect(String(failure)).toContain('readiness wait interrupted')
    expect(activations).toBe(0)
  })

  test('reactivation wakes a deferred controller on the same source revision', async () => {
    let state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 1,
      planHash,
      sourceRevision,
      initialSequence: 4,
      nextSequence: 10,
      lastCompletion: {
        sequence: 9,
        outcome: ExecutionControllerOutcome.Blocked,
        receiptHash: 'f'.repeat(64),
        completedAt: '2026-08-12T18:00:00.000Z',
      },
    }
    const deferred: Delivery = {
      delay: 8 * 60 * 60 * 1_000,
      idempotencyKey: executionControllerTickIdempotencyKey(1, 10, 0),
      parameter: { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 10, attempt: 0 },
    }
    const deliveries = [deferred]
    const calls: number[] = []
    const object = handlers(
      makeBaynExecutionController(config, {
        advance: async (command) => {
          calls.push(command.sequence)
          return {
            completedAt: '2026-08-13T18:00:01.000Z',
            outcome: {
              _tag: ExecutionControllerOutcome.Blocked,
              receiptHash: 'e'.repeat(64),
              nextDelayMs: 30_000,
              nextWakeAt: '2026-08-13T18:00:31.000Z',
            },
          }
        },
        log: () => Promise.resolve(),
        prepareActivation: () => Promise.resolve(),
        projectState: () => Promise.resolve(),
      }),
    )
    const controllerContext = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        state = next
      },
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      date: { toJSON: async () => '2026-08-13T18:00:00.000Z' },
      request: () => ({ id: 'fresh-recovery-controller', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const context = {
      key: controllerKey,
      request: () => ({
        id: 'fresh-recovery-deployment',
        headers: new Map([['authorization', `Bearer ${Buffer.alloc(32, 7).toString('base64url')}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => ({
        prepareActivation: async () => state,
        status: async () => state,
        activate: (request: unknown) => object.activate(controllerContext, request),
      }),
      genericCall: async () => ({
        sourceRevision,
        epoch: 1,
        sequence: 1,
        captureScheduled: false,
        nextCaptureNotBeforeMs: 0,
        lastSnapshotHash: 'a'.repeat(64),
      }),
      sleep: async () => {
        const index = deliveries.findIndex((delivery) => delivery !== deferred)
        if (index === -1) throw new Error('reactivation did not wake the deferred controller')
        const delivery = deliveries.splice(index, 1)[0]
        if (delivery === undefined) throw new Error('missing recovery delivery')
        await object.tick(controllerContext, delivery.parameter)
      },
    } as unknown as ObjectSharedContext

    expect(
      await object.activateDeployment(context, {
        schemaVersion: 'bayn.execution-deployment-activation.v2',
        controllerKey,
        planHash,
        sourceRevision,
      }),
    ).toMatchObject({
      active: true,
      epoch: 1,
      initialSequence: 4,
      sourceRevision,
      nextSequence: 11,
      lastCompletion: { sequence: 10 },
    })
    expect(calls).toEqual([10])
    expect(deliveries).toHaveLength(2)
    expect(deliveries[1]).toMatchObject({ delay: 31_000, parameter: { epoch: 1, sequence: 11 } })

    await object.tick(controllerContext, deferred.parameter)
    expect(calls).toEqual([10])
    expect(deliveries).toHaveLength(2)
  })

  test('rotates a same-plan source revision and ignores the predecessor tick', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    const previousBinding = { planHash, sourceRevision: 'e'.repeat(40) }
    const rotationConfig = config
    let state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 4,
      ...previousBinding,
      initialSequence: 7,
      nextSequence: 12,
      lastCompletion: {
        sequence: 11,
        outcome: ExecutionControllerOutcome.Waiting,
        receiptHash: 'e'.repeat(64),
        completedAt: '2026-08-13T17:59:30.000Z',
      },
    }
    const events: string[] = []
    const deliveries: Delivery[] = []
    const calls: Array<Parameters<Parameters<typeof makeBaynExecutionController>[1]['advance']>[0]> = []
    const projectedStates: ExecutionControllerState[] = []
    let genericCalls = 0
    let sleeps = 0
    const attempt = new AbortController()
    const controller = makeBaynExecutionController(rotationConfig, {
      advance: async (command) => {
        calls.push(command)
        events.push('advance-completed')
        return {
          completedAt: '2026-08-13T18:00:01.000Z',
          outcome: {
            _tag: ExecutionControllerOutcome.Blocked,
            receiptHash: 'f'.repeat(64),
            nextDelayMs: 30_000,
            nextWakeAt: '2026-08-13T18:00:31.000Z',
          },
        }
      },
      log: () => Promise.resolve(),
      prepareActivation: () => Promise.resolve(),
      projectState: async (_key, next) => {
        projectedStates.push(next)
        events.push(next.active ? 'activation-projected' : 'deactivation-projected')
      },
    })
    const object = handlers(controller)
    const controllerContext = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        state = next
        events.push('state-committed')
      },
      genericSend: (delivery: Delivery) => {
        deliveries.push(delivery)
        events.push(
          delivery.delay === executionControllerInitialTickDelayMs ? 'first-pass-scheduled' : 'successor-scheduled',
        )
      },
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      date: { toJSON: async () => '2026-08-13T18:00:00.000Z' },
      request: () => ({ id: 'rotation-controller', attemptCompletedSignal: attempt.signal }),
    } as unknown as TestContext
    const start = handlers(controller).activateDeployment
    const context = {
      key: controllerKey,
      request: () => ({
        id: 'deployment-native-rotation',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => ({
        prepareActivation: async () => state,
        status: async () => state,
        rotate: (request: unknown) => object.rotate(controllerContext, request),
        activate: (request: unknown) => object.activate(controllerContext, request),
      }),
      sleep: async () => {
        sleeps += 1
        const firstTick = deliveries.shift()
        if (firstTick === undefined) throw new Error('rotation did not schedule the new binding first pass')
        await object.tick(controllerContext, firstTick.parameter)
      },
      genericCall: (command: { service: string; method: string; key: string; parameter: unknown }) => {
        genericCalls += 1
        expect(command).toMatchObject({
          service: 'BaynBrokerObservations',
          method: 'activate',
          key: controllerKey,
          parameter: { sourceRevision },
        })
        return Promise.resolve({
          sourceRevision,
          epoch: 1,
          sequence: 1,
          captureScheduled: false,
          nextCaptureNotBeforeMs: 0,
          lastSnapshotHash: 'a'.repeat(64),
        })
      },
    } as unknown as ObjectSharedContext
    const request = {
      schemaVersion: 'bayn.execution-deployment-activation.v2' as const,
      controllerKey,
      planHash,
      sourceRevision,
    }

    expect(await start(context, request)).toMatchObject({
      active: true,
      epoch: 5,
      planHash,
      sourceRevision,
      lastCompletion: { sequence: 12, outcome: ExecutionControllerOutcome.Blocked },
      nextSequence: 13,
    })
    expect(projectedStates).toHaveLength(1)
    expect(projectedStates[0]).toMatchObject({ active: true, epoch: 5, planHash, sourceRevision, nextSequence: 12 })
    expect(events).toEqual([
      'activation-projected',
      'state-committed',
      'first-pass-scheduled',
      'advance-completed',
      'state-committed',
      'successor-scheduled',
    ])
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      delay: 31_000,
      idempotencyKey: executionControllerTickIdempotencyKey(5, 13, 0),
      parameter: { epoch: 5, sequence: 13, attempt: 0 },
    })
    expect(sleeps).toBe(1)
    expect(genericCalls).toBe(1)

    await object.tick(controllerContext, {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 4,
      sequence: 12,
      attempt: 0,
    })
    expect(calls).toHaveLength(1)
    expect(deliveries).toHaveLength(1)
    expect(calls).toEqual(
      [12].map((sequence) => ({
        controllerKey,
        epoch: 5,
        sequence,
        issuedAt: '2026-08-13T18:00:00.000Z',
        sourceRevision,
      })),
    )
    expect(state).toMatchObject({
      active: true,
      epoch: 5,
      nextSequence: 13,
      lastCompletion: { sequence: 12, outcome: 'Blocked' },
      nextDueAt: '2026-08-13T18:00:31.000Z',
    })
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      delay: 31_000,
      idempotencyKey: executionControllerTickIdempotencyKey(5, 13, 0),
      parameter: { epoch: 5, sequence: 13, attempt: 0 },
    })
    expect(events.at(-1)).toBe('successor-scheduled')
  })

  test('a pinned stale coordinator cannot deactivate the latest durable owner', async () => {
    const oldSourceRevision = 'e'.repeat(40)
    let reads = 0
    let deactivations = 0
    let brokerCalls = 0
    const runtime = {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      prepareActivation: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    }
    const latest = handlers(makeBaynExecutionController(config, runtime))
    const pinned = handlers(makeBaynExecutionController({ ...config, sourceRevision: oldSourceRevision }, runtime))
    const latestContext = {
      key: controllerKey,
      get: async () => {
        reads += 1
        return null
      },
    } as unknown as ObjectSharedContext
    const pinnedContext = {
      key: controllerKey,
      request: () => ({ headers: new Map([['authorization', `Bearer ${Buffer.alloc(32, 7).toString('base64url')}`]]) }),
      objectClient: () => ({
        prepareActivation: (candidate: unknown) => latest.prepareActivation(latestContext, candidate),
        deactivate: () => {
          deactivations += 1
          throw new Error('must not stop latest owner')
        },
      }),
      genericCall: () => {
        brokerCalls += 1
        throw new Error('must not rotate broker owner')
      },
    } as unknown as ObjectSharedContext
    const failure = await pinned
      .activateDeployment(pinnedContext, {
        schemaVersion: 'bayn.execution-deployment-activation.v2',
        controllerKey,
        planHash,
        sourceRevision: oldSourceRevision,
      })
      .catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(TerminalError)
    if (!(failure instanceof Error)) throw new Error('Expected a stale coordinator rejection')
    expect(failure.message).toBe('execution controller deployment activation does not match this immutable deployment')
    expect(reads).toBe(0)
    expect(deactivations).toBe(0)
    expect(brokerCalls).toBe(0)
  })

  test('rejects retired activation requests before accessing the native owner', async () => {
    let calls = 0
    const object = handlers(
      makeBaynExecutionController(config, {
        advance: () => Promise.reject(new Error('must not advance')),
        log: () => Promise.resolve(),
        prepareActivation: () => Promise.resolve(),
        projectState: () => Promise.resolve(),
      }),
    )
    const context = {
      key: controllerKey,
      request: () => ({
        id: 'retired-deployment',
        headers: new Map([['authorization', `Bearer ${Buffer.alloc(32, 7).toString('base64url')}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => {
        calls += 1
        throw new Error('must not access owner')
      },
    } as unknown as ObjectSharedContext
    for (const candidate of [
      { schemaVersion: 'bayn.execution-deployment-activation.v1', controllerKey, planHash, sourceRevision },
      {
        schemaVersion: 'bayn.execution-deployment-activation.v2',
        controllerKey,
        planHash,
        sourceRevision,
        previousBinding: { planHash, sourceRevision },
      },
    ]) {
      const failure = await object.activateDeployment(context, candidate).catch((cause: unknown) => cause)
      expect(failure).toBeInstanceOf(TerminalError)
      if (!(failure instanceof Error)) throw new Error('Expected a retired activation rejection')
      expect(failure.message).toBe('execution controller deployment activation failed validation')
    }
    expect(calls).toBe(0)
  })

  test.each(['authority mismatch', 'authority read unavailable', 'authority preflight timed out'])(
    'keeps the predecessor and broker owner untouched when successor preflight fails: %s',
    async (message) => {
      const failure = new Error(message)
      const signal = new AbortController().signal
      let reads = 0
      let deactivations = 0
      let brokerCalls = 0
      let preflights = 0
      const object = handlers(
        makeBaynExecutionController(config, {
          prepareActivation: async (received) => {
            expect(received).toBe(signal)
            preflights += 1
            throw failure
          },
          advance: async () => {
            throw new Error('must not advance')
          },
          log: async () => undefined,
          projectState: async () => {
            throw new Error('must not project')
          },
        }),
      )
      const target = {
        key: controllerKey,
        get: async () => {
          reads += 1
          throw new Error('must not read predecessor')
        },
        run: async (_name: string, action: () => Promise<unknown>, options: unknown) => {
          expect(options).toEqual({ maxRetryAttempts: 0 })
          return action()
        },
        request: () => ({ attemptCompletedSignal: signal }),
      } as unknown as ObjectSharedContext
      const coordinator = {
        key: controllerKey,
        request: () => ({
          headers: new Map([['authorization', `Bearer ${Buffer.alloc(32, 7).toString('base64url')}`]]),
        }),
        objectClient: () => ({
          prepareActivation: (candidate: unknown) => object.prepareActivation(target, candidate),
          deactivate: () => {
            deactivations += 1
            throw new Error('must not deactivate')
          },
        }),
        genericCall: () => {
          brokerCalls += 1
          throw new Error('must not rotate broker owner')
        },
      } as unknown as ObjectSharedContext
      const rejected = await object
        .activateDeployment(coordinator, {
          schemaVersion: 'bayn.execution-deployment-activation.v2',
          controllerKey,
          planHash,
          sourceRevision,
        })
        .catch((cause: unknown) => cause)
      expect(rejected).toBe(failure)
      expect({ preflights, reads, deactivations, brokerCalls }).toEqual({
        preflights: 1,
        reads: 0,
        deactivations: 0,
        brokerCalls: 0,
      })
    },
  )

  test('successful successor preflight precedes reading the predecessor', async () => {
    const events: string[] = []
    const object = handlers(
      makeBaynExecutionController(config, {
        prepareActivation: async () => {
          events.push('preflight')
        },
        advance: async () => {
          throw new Error('must not advance')
        },
        log: async () => undefined,
        projectState: async () => {
          throw new Error('must not project')
        },
      }),
    )
    const context = {
      key: controllerKey,
      get: async () => {
        events.push('read predecessor')
        return null
      },
      run: async (_name: string, action: () => Promise<unknown>) => action(),
      request: () => ({ attemptCompletedSignal: new AbortController().signal }),
    } as unknown as ObjectSharedContext
    expect(
      await object.prepareActivation(context, {
        schemaVersion: 'bayn.execution-deployment-activation.v2',
        controllerKey,
        planHash,
        sourceRevision,
      }),
    ).toBeNull()
    expect(events).toEqual(['preflight', 'read predecessor'])
  })

  test('activates null native state without calling any legacy service', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    const events: string[] = []
    let genericCalls = 0
    let forwarded: unknown
    let statusReads = 0
    const successorState: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 1,
      planHash,
      sourceRevision,
      initialSequence: 0,
      nextSequence: 2,
      lastCompletion: {
        sequence: 1,
        outcome: ExecutionControllerOutcome.Blocked,
        receiptHash: 'e'.repeat(64),
        completedAt: '2026-08-13T18:00:31.000Z',
      },
      nextDueAt: '2026-08-13T18:01:01.000Z',
    }
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      prepareActivation: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const start = handlers(controller).activateDeployment
    const context = {
      key: controllerKey,
      request: () => ({
        id: 'deployment-null-native-state',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      genericCall: (command: { service: string; method: string; key: string; parameter: unknown }) => {
        genericCalls += 1
        expect(command).toMatchObject({
          service: 'BaynBrokerObservations',
          method: 'activate',
          key: controllerKey,
          parameter: { sourceRevision },
        })
        return Promise.resolve({
          sourceRevision,
          epoch: 1,
          sequence: 1,
          captureScheduled: false,
          nextCaptureNotBeforeMs: 0,
          lastSnapshotHash: 'a'.repeat(64),
        })
      },
      objectClient: () => ({
        prepareActivation: async () => {
          events.push('native-prepare')
          statusReads += 1
          return null
        },
        status: async () => {
          events.push('native-status')
          statusReads += 1
          return successorState
        },
        activate: async (request: unknown) => {
          events.push('native-activate')
          forwarded = request
          return {
            schemaVersion: 1,
            active: true,
            epoch: 1,
            planHash,
            sourceRevision,
            initialSequence: 0,
            nextSequence: 1,
            lastCompletion: {
              sequence: 0,
              outcome: ExecutionControllerOutcome.Blocked,
              receiptHash: 'd'.repeat(64),
              completedAt: '2026-08-13T18:00:01.000Z',
            },
            nextDueAt: '2026-08-13T18:00:31.000Z',
          }
        },
      }),
      sleep: async () => {
        events.push('native-sleep')
      },
    } as unknown as ObjectSharedContext

    await start(context, {
      schemaVersion: 'bayn.execution-deployment-activation.v2',
      controllerKey,
      planHash,
      sourceRevision,
    })

    expect(events).toEqual(['native-prepare', 'native-activate'])
    expect(forwarded).toMatchObject({ epoch: 1, firstSequence: 0, planHash, sourceRevision })
    expect(genericCalls).toBe(1)
  })

  test('waits for durable successor evidence and fails deployment when it never arrives', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    const pending: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 1,
      planHash,
      sourceRevision,
      initialSequence: 0,
      nextSequence: 0,
    }
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      prepareActivation: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const start = handlers(controller).activateDeployment
    let sleeps = 0
    let statusReads = 0
    const context = {
      key: controllerKey,
      request: () => ({
        id: 'deployment-first-pass-timeout',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      genericCall: async () => ({
        sourceRevision,
        epoch: 1,
        sequence: 1,
        captureScheduled: false,
        nextCaptureNotBeforeMs: 0,
        lastSnapshotHash: 'a'.repeat(64),
      }),
      objectClient: () => ({
        prepareActivation: async () => {
          statusReads += 1
          return pending
        },
        status: async () => {
          statusReads += 1
          return pending
        },
        activate: async () => pending,
      }),
      sleep: async () => {
        sleeps += 1
      },
    } as unknown as ObjectSharedContext

    let failure: unknown
    try {
      await start(context, {
        schemaVersion: 'bayn.execution-deployment-activation.v2',
        controllerKey,
        planHash,
        sourceRevision,
      })
    } catch (cause) {
      failure = cause
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(
      'execution controller deployment activation did not observe a completed durable successor pass',
    )
    expect(sleeps).toBe(executionControllerDeploymentCompletionMaximumAttempts(config.operationTimeoutMs) - 1)
    expect(statusReads).toBe(executionControllerDeploymentCompletionMaximumAttempts(config.operationTimeoutMs))
    expect(executionControllerSuccessorPassCompleted(pending, activation)).toBe(false)
  })

  test('rejects unauthenticated deployment activation and caller-selected activation counters', async () => {
    let objectCalls = 0
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      prepareActivation: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const start = handlers(controller).activateDeployment
    const context = {
      key: controllerKey,
      request: () => ({
        id: 'deployment-rejected',
        headers: new Map<string, string>(),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => {
        objectCalls += 1
        return {
          status: () => Promise.resolve(null),
          activate: () => Promise.reject(new Error('must not activate')),
        }
      },
    } as unknown as ObjectSharedContext
    const deployment = {
      schemaVersion: 'bayn.execution-deployment-activation.v2',
      controllerKey,
      planHash,
      sourceRevision,
    }

    expect(start(context, deployment)).rejects.toThrow(
      'execution controller deployment activation authorization failed',
    )
    expect(start(context, { ...deployment, epoch: 19, firstSequence: 41 })).rejects.toThrow(
      'execution controller deployment activation failed validation',
    )
    expect(objectCalls).toBe(0)
  })

  test('rejects a plan-drifted deployment before touching the native controller', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    let controllerCalls = 0
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      prepareActivation: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const start = handlers(controller).activateDeployment
    const context = {
      key: controllerKey,
      request: () => ({
        id: 'deployment-plan-drift',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => {
        controllerCalls += 1
        return { status: () => Promise.reject(new Error('must not read')) }
      },
    } as unknown as ObjectSharedContext

    expect(
      start(context, {
        schemaVersion: 'bayn.execution-deployment-activation.v2',
        controllerKey,
        planHash: 'f'.repeat(64),
        sourceRevision,
      }),
    ).rejects.toThrow('execution controller deployment activation does not match this immutable deployment')
    expect(controllerCalls).toBe(0)
  })

  test('rejects a different object key before touching either owner', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    let ownerCalls = 0
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      prepareActivation: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const context = {
      key: 'd'.repeat(64),
      request: () => ({
        id: 'deployment-wrong-object-key',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => {
        ownerCalls += 1
      },
      genericCall: () => {
        ownerCalls += 1
      },
    } as unknown as ObjectSharedContext

    expect(
      handlers(controller).activateDeployment(context, {
        schemaVersion: 'bayn.execution-deployment-activation.v2',
        controllerKey,
        planHash,
        sourceRevision,
      }),
    ).rejects.toThrow('execution controller deployment activation does not match this immutable deployment')
    expect(ownerCalls).toBe(0)
  })

  test('retries the same command identity durably and starts a diagnosed recovery window after exhaustion', async () => {
    const state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 7,
      planHash,
      sourceRevision,
      initialSequence: 12,
      nextSequence: 12,
      lastCompletion: {
        sequence: 11,
        outcome: ExecutionControllerOutcome.Blocked,
        receiptHash: 'e'.repeat(64),
        completedAt: '2026-08-13T17:59:30.000Z',
      },
    }
    const commands: Array<Parameters<Parameters<typeof makeBaynExecutionController>[1]['advance']>[0]> = []
    const deliveries: Delivery[] = []
    const loggedLevels: string[] = []
    const loggedAnnotations: Array<Readonly<Record<string, string | number | boolean>>> = []
    const failure = new TransientExecutionFailure({
      operation: 'advance',
      message: 'execution advance did not complete within its bounded interpreter',
      cause: new CycleRunnerError({
        operation: 'read-authority-slot',
        failure: 'database',
        message: 'cycle runner could not read the authority slot',
        cause: new Error('database-secret-must-not-be-logged'),
      }),
    })
    let invocation = 0
    const context = {
      key: controllerKey,
      get: async () => state,
      set: () => undefined,
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      date: { toJSON: async () => `2026-08-13T18:00:0${invocation}.000Z` },
      request: () => ({
        id: `invocation-${invocation++}`,
        attemptCompletedSignal: new AbortController().signal,
      }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(
        {
          ...config,
        },
        {
          advance: (command) => {
            commands.push(command)
            return Promise.reject(failure)
          },
          log: (level, _message, annotations) => {
            loggedLevels.push(level)
            loggedAnnotations.push(annotations)
            return Promise.reject(new Error('telemetry unavailable'))
          },
          prepareActivation: () => Promise.resolve(),
          projectState: () => Promise.resolve(),
        },
      ),
    )
    let tick: unknown = {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 7,
      sequence: 12,
      attempt: 0,
    }

    const maximumAttempts = executionControllerAdvanceMaximumAttempts(false)
    for (let attempt = 0; attempt < maximumAttempts - 1; attempt += 1) {
      await object.tick(context, tick)
      const retry = deliveries.shift()
      if (retry === undefined) throw new Error('transient failure did not schedule its durable retry')
      expect(retry).toMatchObject({
        parameter: {
          epoch: 7,
          sequence: 12,
          attempt: attempt + 1,
          issuedAt: '2026-08-13T18:00:00.000Z',
        },
      })
      tick = retry.parameter
    }

    await object.tick(context, tick)
    const recovery = deliveries.shift()
    if (recovery === undefined) throw new Error('retry exhaustion did not schedule a recovery window')
    expect(recovery.delay).toBe(executionControllerRecoveryTickDelayMs)
    const recoveryTick = recovery.parameter as { readonly retryWindowHash: string }
    expect(recovery.parameter).toMatchObject({
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 7,
      sequence: 12,
      attempt: 0,
      issuedAt: '2026-08-13T18:00:00.000Z',
      recoveryWindow: 1,
    })
    expect(recoveryTick.retryWindowHash).toMatch(/^[0-9a-f]{64}$/)
    expect(recovery.idempotencyKey).toBe(
      executionControllerRecoveryTickIdempotencyKey(7, 12, 0, recoveryTick.retryWindowHash),
    )
    expect(commands).toHaveLength(maximumAttempts)
    expect(new Set(commands.map(({ issuedAt }) => issuedAt))).toEqual(new Set(['2026-08-13T18:00:00.000Z']))
    expect(deliveries).toHaveLength(0)
    expect(loggedLevels).toEqual(['warning', 'warning', 'error', 'warning'])
    expect(loggedAnnotations[2]).toMatchObject({
      failureCauseCategory: 'database',
      failureCauseOperation: 'read-authority-slot',
      failureCauseTag: 'CycleRunnerError',
      failureMessage: 'execution advance did not complete within its bounded interpreter',
      failureOperation: 'advance',
      failureTag: 'TransientExecutionFailure',
    })
    expect(loggedAnnotations[2]?.['failureFingerprint']).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(loggedAnnotations)).not.toContain('database-secret-must-not-be-logged')
  })

  test.each([
    {
      failure: new TransientExecutionFailure({
        operation: 'advance',
        message: 'execution advance did not complete within its bounded interpreter',
        cause: new CycleRunnerError({
          operation: 'read-authority-slot',
          failure: 'database',
          message: 'cycle runner could not read the authority slot',
          cause: new Error('database-secret-must-not-be-logged'),
        }),
      }),
      expected: {
        failureTag: 'TransientExecutionFailure',
        failureOperation: 'advance',
        failureCauseTag: 'CycleRunnerError',
        failureCauseOperation: 'read-authority-slot',
        failureCauseCategory: 'database',
      },
    },
    {
      failure: new OperationalError({
        component: 'strategy',
        operation: 'capital-activation',
        message: 'research capital pre-activation reconciliation was not exact',
        retryable: false,
        cause: { _tag: 'CapitalActivationPreparationRejected' },
      }),
      expected: {
        failureTag: 'OperationalError',
        failureOperation: 'capital-activation',
        failureCauseTag: 'CapitalActivationPreparationRejected',
      },
    },
    {
      failure: new Error('database-secret-must-not-be-logged'),
      expected: { failureTag: 'Error', failureOperation: 'unclassified' },
    },
    {
      failure: new TerminalError('database-secret-must-not-be-logged', { errorCode: 409 }),
      expected: { failureTag: 'TerminalError', failureOperation: 'unclassified' },
    },
  ])(
    'retains $expected.failureTag diagnostics and first receipt time across the durable run boundary and replay',
    async ({ failure, expected }) => {
      const state: ExecutionControllerState = {
        schemaVersion: 1,
        active: true,
        epoch: 7,
        planHash,
        sourceRevision,
        initialSequence: 12,
        nextSequence: 12,
      }
      const deliveries: Delivery[] = []
      const logged: Array<Readonly<Record<string, string | number | boolean>>> = []
      let advances = 0
      let now = Date.parse('2026-08-13T18:00:00.000Z')
      let recorded: { message: string; code: number; metadata: Record<string, string> } | undefined
      const context = {
        key: controllerKey,
        get: async () => state,
        set: () => undefined,
        genericSend: (delivery: Delivery) => deliveries.push(delivery),
        run: async <A>(_name: string, action: () => Promise<A>): Promise<A> => {
          if (recorded === undefined) {
            try {
              return await action()
            } catch (cause) {
              // Restate retains message, code and string metadata, not the original error's prototype or fields.
              recorded = JSON.parse(
                JSON.stringify(
                  cause instanceof TerminalError
                    ? { message: cause.message, code: cause.code, metadata: cause.metadata ?? {} }
                    : { message: 'run attempts exhausted', code: 500, metadata: {} },
                ),
              ) as typeof recorded
            }
          }
          if (recorded === undefined) throw new Error('missing retained failure')
          throw new TerminalError(recorded.message, { errorCode: recorded.code, metadata: recorded.metadata })
        },
        date: { toJSON: async () => '2026-08-13T18:00:00.000Z' },
        request: () => ({ id: 'diagnostic-replay', attemptCompletedSignal: new AbortController().signal }),
      } as unknown as TestContext
      const object = handlers(
        makeBaynExecutionController(
          config,
          {
            advance: () => {
              advances += 1
              return Promise.reject(failure)
            },
            log: (_level, _message, annotations) => {
              logged.push(annotations)
              return Promise.resolve()
            },
            prepareActivation: () => Promise.resolve(),
            projectState: () => Promise.resolve(),
          },
          [],
          { currentTimeMillisUnsafe: () => now },
        ),
      )
      const tick = { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 7, sequence: 12 }
      await object.tick(context, tick)
      now += 60_000
      await object.tick(context, tick)
      expect(advances).toBe(1)
      expect(deliveries).toHaveLength(2)
      expect(deliveries[0]).toMatchObject({ parameter: { issuedAt: '2026-08-13T18:00:00.000Z' } })
      expect(deliveries[1]).toEqual(deliveries[0])
      expect(recorded?.code).toBe(failure instanceof TerminalError ? failure.code : 500)
      expect(logged).toHaveLength(2)
      for (const annotations of logged) {
        expect(annotations).toMatchObject(expected)
        expect(annotations['failureFingerprint']).toMatch(/^[0-9a-f]{64}$/)
      }
      expect(logged[0]?.['failureFingerprint']).toBe(logged[1]?.['failureFingerprint'])
      expect(JSON.stringify({ recorded, logged })).not.toContain('database-secret-must-not-be-logged')
    },
  )

  test.each(['not-json', '{"failureTag":"OperationalError","failureFingerprint":"invalid"}'])(
    'ignores malformed durable diagnostics without exposing the original error (%s)',
    async (metadata) => {
      const state: ExecutionControllerState = {
        schemaVersion: 1,
        active: true,
        epoch: 7,
        planHash,
        sourceRevision,
        initialSequence: 12,
        nextSequence: 12,
      }
      const logged: Array<Readonly<Record<string, string | number | boolean>>> = []
      const deliveries: Delivery[] = []
      const context = {
        key: controllerKey,
        get: async () => state,
        genericSend: (delivery: Delivery) => deliveries.push(delivery),
        run: async <A>(_name: string, action: () => Promise<A>) => action(),
        date: { toJSON: async () => '2026-08-13T18:00:00.000Z' },
        request: () => ({ id: 'invalid-diagnostic', attemptCompletedSignal: new AbortController().signal }),
      } as unknown as TestContext
      const object = handlers(
        makeBaynExecutionController(config, {
          advance: () =>
            Promise.reject(
              new TerminalError('provider-secret-must-not-be-logged', {
                errorCode: 500,
                metadata: { 'bayn.execution-advance-failure.v1': metadata },
              }),
            ),
          log: (_level, _message, annotations) => {
            logged.push(annotations)
            return Promise.resolve()
          },
          prepareActivation: () => Promise.resolve(),
          projectState: () => Promise.resolve(),
        }),
      )
      await object.tick(context, { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 7, sequence: 12 })
      expect(deliveries).toHaveLength(1)
      expect(logged).toHaveLength(1)
      expect(logged[0]).toMatchObject({ failureTag: 'TerminalError', failureOperation: 'unclassified' })
      expect(JSON.stringify(logged)).not.toContain('provider-secret-must-not-be-logged')
    },
  )

  test('a queued wake marker preserves recovery timers through a long outage on the unchanged owned sequence', async () => {
    let state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 7,
      planHash,
      sourceRevision,
      initialSequence: 11,
      nextSequence: 12,
      lastCompletion: {
        sequence: 11,
        outcome: ExecutionControllerOutcome.Blocked,
        receiptHash: 'e'.repeat(64),
        completedAt: '2026-08-13T17:59:30.000Z',
      },
    }
    const deliveries: Delivery[] = []
    let invocation = 0
    let healthy = false
    let transportNow = Date.parse('2026-08-13T18:00:00.000Z')
    const issuedAt: string[] = []
    const failure = new TransientExecutionFailure({
      operation: 'advance',
      message: 'execution advance did not complete within its bounded interpreter',
      cause: new Error('persistent database outage'),
    })
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        state = next
      },
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      date: { now: async () => transportNow, toJSON: async () => '2026-08-13T18:00:00.000Z' },
      request: () => ({
        id: `recovery-budget-${invocation}`,
        attemptCompletedSignal: new AbortController().signal,
      }),
    } as unknown as TestContext
    const restart = () =>
      handlers(
        makeBaynExecutionController(config, {
          advance: (command) => {
            issuedAt.push(command.issuedAt)
            return healthy
              ? Promise.resolve({
                  completedAt: '2026-08-13T18:10:00.000Z',
                  outcome: {
                    _tag: ExecutionControllerOutcome.Completed,
                    receiptHash: 'e'.repeat(64),
                    nextDelayMs: 30_000,
                    nextWakeAt: '2026-08-13T18:00:31.000Z',
                  },
                })
              : Promise.reject(failure)
          },
          log: () => Promise.resolve(),
          prepareActivation: () => Promise.resolve(),
          projectState: () => Promise.resolve(),
        }),
      )
    let object = restart()
    await object.wake(context, marketChange(1))
    expect(deliveries.shift()?.idempotencyKey).toBe('bayn-execution-wake-7-12')
    expect(state.wakeScheduledSequence).toBe(12)
    expect(state.wakeAcceptedAt).toBe('2026-08-13T18:00:00.000Z')
    let tick: unknown = {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 7,
      sequence: 12,
      attempt: executionControllerAdvanceMaximumAttempts(false) - 1,
    }

    const keys = new Set<string | undefined>()
    for (let recoveryWindow = 1; recoveryWindow <= executionControllerMaximumRecoveryWindow + 3; recoveryWindow += 1) {
      await object.tick(context, tick)
      const recovery = deliveries.shift()
      if (recovery === undefined) throw new Error(`recovery window ${recoveryWindow} was not scheduled`)
      expect(recovery.delay).toBe(executionControllerRecoveryTickDelayMs)
      await object.tick(context, tick)
      const replayed = deliveries.shift()
      expect(replayed?.idempotencyKey).toBe(recovery.idempotencyKey)
      expect(replayed?.parameter).toEqual(recovery.parameter)
      expect(recovery.parameter).toMatchObject({
        recoveryWindow: Math.min(recoveryWindow, executionControllerMaximumRecoveryWindow),
        epoch: 7,
        sequence: 12,
        attempt: 0,
        issuedAt: '2026-08-13T18:00:00.000Z',
      })
      expect(keys.has(recovery.idempotencyKey)).toBe(false)
      keys.add(recovery.idempotencyKey)
      expect(state.nextSequence).toBe(12)
      transportNow += 120_000
      object = restart()
      await object.wake(context, marketChange(recoveryWindow + 1))
      expect(deliveries).toHaveLength(0)
      expect(state.wakeScheduledSequence).toBe(12)
      expect(state.wakeAcceptedAt).toBe('2026-08-13T18:00:00.000Z')
      tick = {
        ...(recovery.parameter as object),
        attempt: executionControllerAdvanceMaximumAttempts(false) - 1,
      }
      invocation += 1
    }

    healthy = true
    await object.tick(context, tick)
    expect(state.nextSequence).toBe(13)
    expect(state.epoch).toBe(7)
    expect(state.sourceRevision).toBe(sourceRevision)
    expect(state.wakeScheduledSequence).toBeUndefined()
    expect(state.wakeAcceptedAt).toBeUndefined()
    expect(new Set(issuedAt)).toEqual(new Set(['2026-08-13T18:00:00.000Z']))
    const successor = deliveries.shift()
    expect(successor?.parameter).toMatchObject({ epoch: 7, sequence: 13, attempt: 0 })
    const completedAdvances = issuedAt.length
    await object.tick(context, tick)
    expect(issuedAt).toHaveLength(completedAdvances)
    expect(deliveries).toHaveLength(0)
  })

  test('quiesces a foreign source before advancing and keeps the established owner free', async () => {
    const establishedSourceRevision = 'd'.repeat(40)
    let state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 7,
      planHash,
      sourceRevision: establishedSourceRevision,
      initialSequence: 12,
      nextSequence: 12,
      wakeScheduledSequence: 12,
      wakeAcceptedAt: '2026-08-13T17:59:31.000Z',
      lastCompletion: {
        sequence: 11,
        outcome: ExecutionControllerOutcome.Blocked,
        receiptHash: 'e'.repeat(64),
        completedAt: '2026-08-13T17:59:30.000Z',
      },
    }
    const deliveries: Delivery[] = []
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        state = next
      },
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      date: { toJSON: async () => '2026-08-13T18:00:00.000Z' },
      request: () => ({ id: 'catch-up-failure', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    let replacementAdvances = 0
    const replacement = handlers(
      makeBaynExecutionController(
        {
          ...config,
        },
        {
          advance: () => {
            replacementAdvances += 1
            return Promise.reject(new Error('foreign source must not advance'))
          },
          log: () => Promise.resolve(),
          prepareActivation: () => Promise.resolve(),
          projectState: () => Promise.resolve(),
        },
      ),
    )
    const established = handlers(
      makeBaynExecutionController(
        { ...config, sourceRevision: establishedSourceRevision },
        {
          advance: () =>
            Promise.resolve({
              completedAt: '2026-08-13T18:00:01.000Z',
              outcome: {
                _tag: ExecutionControllerOutcome.Blocked,
                receiptHash: 'f'.repeat(64),
                nextDelayMs: 30_000,
                nextWakeAt: '2026-08-13T18:00:31.000Z',
              },
            }),
          log: () => Promise.resolve(),
          prepareActivation: () => Promise.resolve(),
          projectState: () => Promise.resolve(),
        },
      ),
    )
    const catchUp = {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 7,
      sequence: 12,
      attempt: 0,
      sourceCatchUpRevision: sourceRevision,
    }

    await replacement.tick(context, catchUp)
    expect(replacementAdvances).toBe(0)
    expect(state.nextSequence).toBe(12)
    expect(state.wakeAcceptedAt).toBe('2026-08-13T17:59:31.000Z')
    expect(state.wakeScheduledSequence).toBe(12)
    expect(deliveries).toHaveLength(0)

    await established.tick(context, {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 7,
      sequence: 12,
      attempt: 0,
    })

    expect(state).toMatchObject({
      sourceRevision: establishedSourceRevision,
      nextSequence: 13,
      lastCompletion: { sequence: 12, receiptHash: 'f'.repeat(64) },
    })
    expect(state.wakeAcceptedAt).toBeUndefined()
    expect(state.wakeScheduledSequence).toBeUndefined()
    expect(deliveries).toEqual([
      expect.objectContaining({
        delay: 31_000,
        parameter: expect.objectContaining({ sequence: 13, attempt: 0 }),
      }),
    ])
  })

  test('keeps a replacement tick retryable across the predecessor termination grace period', async () => {
    let state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 7,
      planHash,
      sourceRevision,
      initialSequence: 12,
      nextSequence: 12,
    }
    const deliveries: Delivery[] = []
    let advances = 0
    let invocation = 0
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        state = next
      },
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      date: { toJSON: async () => '2026-08-13T18:00:00.000Z' },
      request: () => ({
        id: `rotation-${invocation++}`,
        attemptCompletedSignal: new AbortController().signal,
      }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(
        {
          ...config,
        },
        {
          advance: () => {
            advances += 1
            return advances <= 6
              ? Promise.reject(new Error('predecessor still owns the writer fence'))
              : Promise.resolve({
                  completedAt: '2026-08-13T18:00:16.000Z',
                  outcome: {
                    _tag: ExecutionControllerOutcome.Blocked,
                    receiptHash: 'f'.repeat(64),
                    nextDelayMs: 30_000,
                    nextWakeAt: '2026-08-13T18:00:31.000Z',
                  },
                })
          },
          log: () => Promise.resolve(),
          prepareActivation: () => Promise.resolve(),
          projectState: () => Promise.resolve(),
        },
      ),
    )
    let tick: unknown = {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 7,
      sequence: 12,
      attempt: 0,
    }

    const handoffDelays: number[] = []
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await object.tick(context, tick)
      const retry = deliveries.shift()
      if (retry === undefined) throw new Error('replacement handoff did not schedule its durable retry')
      if (retry.delay === undefined) throw new Error('replacement handoff retry did not include a delay')
      handoffDelays.push(retry.delay)
      tick = retry.parameter
    }
    await object.tick(context, tick)

    expect(handoffDelays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000])
    expect(handoffDelays.reduce((total, delay) => total + delay, 0)).toBeGreaterThan(60_000)
    expect(advances).toBe(7)
    expect(state).toMatchObject({
      nextSequence: 13,
      lastCompletion: { sequence: 12, receiptHash: 'f'.repeat(64) },
    })
    expect(deliveries).toEqual([
      expect.objectContaining({
        delay: 31_000,
        parameter: expect.objectContaining({ sequence: 13, attempt: 0 }),
      }),
    ])
  })
})
