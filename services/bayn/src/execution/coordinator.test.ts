import { describe, expect, test } from 'bun:test'

import { Effect, Exit, Option } from 'effect'
import { TestClock } from 'effect/testing'

import {
  BrokerMutation,
  BrokerMutationError,
  MutationFailure,
  MutationOperation,
  cancelRequestHash,
  orderRequestBody,
  type BrokerMutationShape,
  type MutationEvidence,
} from '../broker/alpaca-mutations'
import {
  AssetClass,
  BrokerRead,
  BrokerReadError,
  BrokerReadErrorKind,
  OrderClass,
  OrderSide as BrokerSide,
  OrderStatus,
  OrderType as BrokerOrderType,
  TimeInForce as BrokerTimeInForce,
  type BrokerReadShape,
  type Order,
} from '../broker/alpaca'
import { canonicalHashV1 } from '../hash'
import { IntentState, MutationOutcome, OrderSide, OrderType, TerminalOutcome, TimeInForce, type Intent } from '../paper'
import { cancel, ExecutionError, ExecutionFailure, recover, submit } from './coordinator'
import { IntentStore, type IntentStoreService, type StoredIntent } from './intents'
import { MutationEventType, MutationStore, mutationId, type MutationEvent, type MutationStoreShape } from './mutations'
import { WriterFence, WriterFenceError } from './writer-fence'

const intentId = 'a'.repeat(64)
const orderId = '61e69015-8549-4bfd-b9c3-01e75843f47d'
const accountId = 'e6fe16f3-64a4-4921-8928-cadf02f92f98'
const initialTime = '1969-12-31T23:59:59.000Z'

const intent: Intent = {
  schemaVersion: 'bayn.paper-intent.v2',
  intentId,
  riskDecisionId: 'b'.repeat(64),
  strategyName: 'risk-balanced-trend',
  cycleId: 'c'.repeat(64),
  decisionHash: 'd'.repeat(64),
  policyHash: 'e'.repeat(64),
  accountId,
  clientOrderId: `b1_${'A'.repeat(43)}`,
  symbol: 'AMD',
  side: OrderSide.Buy,
  orderType: OrderType.Market,
  timeInForce: TimeInForce.Day,
  quantityMicros: '1250000',
  notionalLimitMicros: '200000000',
  state: IntentState.Approved,
  createdAt: initialTime,
}

const brokerOrder = (status = OrderStatus.Accepted, observedAt = '1970-01-01T00:00:01.000Z'): Order => ({
  accountId,
  brokerOrderId: orderId,
  clientOrderId: intent.clientOrderId,
  createdAt: observedAt,
  updatedAt: observedAt,
  submittedAt: observedAt,
  assetId: 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415',
  symbol: intent.symbol,
  assetClass: AssetClass.UsEquity,
  quantityMicros: intent.quantityMicros,
  filledQuantityMicros: status === OrderStatus.Filled ? intent.quantityMicros : '0',
  orderClass: OrderClass.Simple,
  orderType: BrokerOrderType.Market,
  side: BrokerSide.Buy,
  timeInForce: BrokerTimeInForce.Day,
  status,
  extendedHours: false,
  observedAt,
})

const evidence = (status: number, observedAt: string): MutationEvidence => ({
  requestId: `request-${status}`,
  status,
  contentHash: canonicalHashV1({ status, observedAt }),
  observedAt,
})

const completeEvidence = (response: Partial<MutationEvidence> | undefined): MutationEvidence | undefined =>
  response?.requestId !== undefined &&
  response.status !== undefined &&
  response.contentHash !== undefined &&
  response.observedAt !== undefined
    ? {
        requestId: response.requestId,
        status: response.status,
        contentHash: response.contentHash,
        observedAt: response.observedAt,
      }
    : undefined

interface HarnessOptions {
  readonly crashAfterSubmit?: boolean
  readonly lostFence?: boolean
  readonly notFoundOnce?: boolean
  readonly unknownSubmit?: boolean
}

const makeHarness = (options: HarnessOptions = {}) => {
  let stored: StoredIntent = { intent, stateVersion: 3, updatedAt: initialTime }
  const latest = new Map<MutationOperation, MutationEvent>()
  let submitCalls = 0
  let cancelCalls = 0
  let lookupCalls = 0

  const event = (
    operation: MutationOperation,
    eventType: MutationEventType,
    requestHash: string,
    consistencyDelayMs: number,
    occurredAt: string,
    brokerOrderId?: string,
    response?: MutationEvidence,
  ): MutationEvent => {
    const previous = latest.get(operation)
    const sequence = (previous?.sequence ?? 0) + 1
    const value: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: canonicalHashV1({ operation, sequence, eventType, occurredAt }),
      mutationId: mutationId(intentId, operation),
      intentId,
      sequence,
      operation,
      eventType,
      requestHash,
      consistencyDelayMs,
      ...((brokerOrderId ?? previous?.brokerOrderId)
        ? { brokerOrderId: brokerOrderId ?? previous?.brokerOrderId }
        : {}),
      ...(response === undefined
        ? {}
        : {
            requestId: response.requestId,
            responseStatus: response.status,
            responseContentHash: response.contentHash,
          }),
      occurredAt,
    }
    latest.set(operation, value)
    return value
  }

  const setState = (state: IntentState, updatedAt: string, terminalOutcome?: TerminalOutcome) => {
    stored = {
      ...stored,
      intent: { ...stored.intent, state, ...(terminalOutcome === undefined ? {} : { terminalOutcome }) },
      stateVersion: stored.stateVersion + 1,
      updatedAt,
    }
  }

  const intentStore: IntentStoreService = {
    commit: () => Effect.die(new Error('unexpected commit')),
    markIoStarted: () => Effect.die(new Error('unexpected markIoStarted')),
    read: (id) => Effect.succeed(id === intentId ? Option.some(stored) : Option.none()),
  }

  const mutationStore: MutationStoreShape = {
    beginSubmit: (_intentId, requestHash, consistencyDelayMs, occurredAt) => {
      const existing = latest.get(MutationOperation.Submit)
      if (existing !== undefined) return Effect.succeed({ event: existing, started: false })
      const started = event(
        MutationOperation.Submit,
        MutationEventType.SubmitStarted,
        requestHash,
        consistencyDelayMs,
        occurredAt,
      )
      setState(IntentState.IoStarted, occurredAt)
      return Effect.succeed({ event: started, started: true })
    },
    submitAccepted: (_intentId, requestHash, brokerOrderId, response, terminal) => {
      const accepted = event(
        MutationOperation.Submit,
        MutationEventType.SubmitAccepted,
        requestHash,
        latest.get(MutationOperation.Submit)?.consistencyDelayMs ?? 1,
        response.observedAt,
        brokerOrderId,
        response,
      )
      setState(terminal === undefined ? IntentState.Acknowledged : IntentState.Terminal, response.observedAt, terminal)
      return Effect.succeed(accepted)
    },
    submitRejected: (_intentId, requestHash, response) => {
      const rejected = event(
        MutationOperation.Submit,
        MutationEventType.SubmitRejected,
        requestHash,
        latest.get(MutationOperation.Submit)?.consistencyDelayMs ?? 1,
        response.observedAt,
        undefined,
        response,
      )
      setState(IntentState.Terminal, response.observedAt, TerminalOutcome.Rejected)
      return Effect.succeed(rejected)
    },
    submitUnknown: (_intentId, requestHash, occurredAt, response) => {
      const unknown = event(
        MutationOperation.Submit,
        MutationEventType.SubmitUnknown,
        requestHash,
        latest.get(MutationOperation.Submit)?.consistencyDelayMs ?? 1,
        occurredAt,
        undefined,
        completeEvidence(response),
      )
      setState(IntentState.Unknown, occurredAt)
      return Effect.succeed(unknown)
    },
    beginCancel: (_intentId, requestHash, brokerOrderId, consistencyDelayMs, occurredAt) => {
      const existing = latest.get(MutationOperation.Cancel)
      if (existing !== undefined) return Effect.succeed({ event: existing, started: false })
      return Effect.succeed({
        event: event(
          MutationOperation.Cancel,
          MutationEventType.CancelStarted,
          requestHash,
          consistencyDelayMs,
          occurredAt,
          brokerOrderId,
        ),
        started: true,
      })
    },
    cancelAccepted: (_intentId, requestHash, brokerOrderId, response) =>
      Effect.succeed(
        event(
          MutationOperation.Cancel,
          MutationEventType.CancelAccepted,
          requestHash,
          latest.get(MutationOperation.Cancel)?.consistencyDelayMs ?? 1,
          response.observedAt,
          brokerOrderId,
          response,
        ),
      ),
    cancelUnknown: (_intentId, requestHash, brokerOrderId, occurredAt, response) =>
      Effect.succeed(
        event(
          MutationOperation.Cancel,
          MutationEventType.CancelUnknown,
          requestHash,
          latest.get(MutationOperation.Cancel)?.consistencyDelayMs ?? 1,
          occurredAt,
          brokerOrderId,
          completeEvidence(response),
        ),
      ),
    recoveryFound: (_intentId, operation, requestHash, brokerOrderId, response, terminal) => {
      const found = event(
        operation,
        MutationEventType.RecoveryFound,
        requestHash,
        latest.get(operation)?.consistencyDelayMs ?? 1,
        response.observedAt,
        brokerOrderId,
        response,
      )
      if (operation === MutationOperation.Submit) {
        setState(
          terminal === undefined ? IntentState.Acknowledged : IntentState.Terminal,
          response.observedAt,
          terminal,
        )
      } else if (terminal !== undefined) {
        setState(IntentState.Terminal, response.observedAt, terminal)
      }
      return Effect.succeed(found)
    },
    recoveryNotFound: (_intentId, operation, requestHash, response) =>
      Effect.succeed(
        event(
          operation,
          MutationEventType.RecoveryNotFound,
          requestHash,
          latest.get(operation)?.consistencyDelayMs ?? 1,
          response.observedAt,
          undefined,
          response,
        ),
      ),
    recoveryUnknown: (_intentId, operation, requestHash, occurredAt, response) =>
      Effect.succeed(
        event(
          operation,
          MutationEventType.RecoveryUnknown,
          requestHash,
          latest.get(operation)?.consistencyDelayMs ?? 1,
          occurredAt,
          undefined,
          completeEvidence(response),
        ),
      ),
    latest: (_intentId, operation) => Effect.succeed(latest.get(operation)),
  }

  const mutation: BrokerMutationShape = {
    submit: (submitted) => {
      submitCalls += 1
      if (latest.get(MutationOperation.Submit)?.eventType !== MutationEventType.SubmitStarted) {
        return Effect.die(new Error('submit happened before SUBMIT_STARTED was durable'))
      }
      if (options.crashAfterSubmit) return Effect.die(new Error('injected crash after send'))
      const hash = canonicalHashV1(orderRequestBody(submitted))
      if (options.unknownSubmit) {
        return Effect.fail(
          new BrokerMutationError({
            operation: MutationOperation.Submit,
            failure: MutationFailure.Unknown,
            outcome: MutationOutcome.Unknown,
            message: 'injected timeout',
            requestHash: hash,
          }),
        )
      }
      const response = evidence(200, '1970-01-01T00:00:00.100Z')
      return Effect.succeed({ requestHash: hash, order: brokerOrder(), evidence: response })
    },
    cancel: (brokerOrderId) => {
      cancelCalls += 1
      const response = evidence(204, '1970-01-01T00:00:01.100Z')
      return Effect.succeed({ requestHash: cancelRequestHash(brokerOrderId), brokerOrderId, evidence: response })
    },
  }

  const read: BrokerReadShape = {
    account: Effect.die(new Error('unexpected account read')),
    positions: Effect.die(new Error('unexpected positions read')),
    orders: () => Effect.die(new Error('unexpected orders read')),
    orderById: () => Effect.die(new Error('unexpected order-by-id read')),
    orderByClientId: () => {
      lookupCalls += 1
      if (options.notFoundOnce && lookupCalls === 1) {
        return Effect.fail(
          new BrokerReadError({
            operation: 'order-by-client-id',
            kind: BrokerReadErrorKind.NotFound,
            message: 'injected delayed visibility',
            retryable: false,
            status: 404,
            requestId: 'lookup-not-found',
            contentHash: canonicalHashV1({ code: 404, message: 'order not found' }),
            observedAt: '1970-01-01T00:00:01.000Z',
          }),
        )
      }
      const value =
        latest.get(MutationOperation.Cancel) === undefined
          ? brokerOrder(OrderStatus.Accepted)
          : brokerOrder(OrderStatus.Canceled)
      return Effect.succeed({ value, evidence: evidence(200, '1970-01-01T00:00:02.000Z') })
    },
    fillActivities: () => Effect.die(new Error('unexpected fill read')),
  }

  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(IntentStore, intentStore),
      Effect.provideService(MutationStore, mutationStore),
      Effect.provideService(BrokerMutation, mutation),
      Effect.provideService(BrokerRead, read),
      Effect.provideService(WriterFence, {
        backendPid: 1,
        check: options.lostFence
          ? Effect.fail(
              new WriterFenceError({
                failure: 'unavailable',
                operation: 'check',
                message: 'injected writer-fence loss',
              }),
            )
          : Effect.void,
      }),
      Effect.provide(TestClock.layer()),
    )

  return {
    provide,
    calls: () => ({ submit: submitCalls, cancel: cancelCalls, lookup: lookupCalls }),
    state: () => stored.intent.state,
  }
}

describe('paper execution coordinator', () => {
  test('records before submission and never calls the broker again for a replayed intent', async () => {
    const harness = makeHarness()
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          const accepted = yield* submit(intentId, 1_000)
          const replay = yield* submit(intentId, 1_000)
          return { accepted, replay }
        }),
      ),
    )

    expect(result.accepted.eventType).toBe(MutationEventType.SubmitAccepted)
    expect(result.replay.eventId).toBe(result.accepted.eventId)
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 0 })
    expect(harness.state()).toBe(IntentState.Acknowledged)
  })

  test('makes no broker call when the writer fence is lost after recording I/O start', async () => {
    const harness = makeHarness({ lostFence: true })
    const failure = await Effect.runPromise(harness.provide(Effect.flip(submit(intentId, 1_000))))

    expect(failure).toBeInstanceOf(WriterFenceError)
    expect(harness.calls()).toEqual({ submit: 0, cancel: 0, lookup: 0 })
    expect(harness.state()).toBe(IntentState.IoStarted)
  })

  test('persists UNKNOWN and refuses lookup until the committed consistency delay elapses', async () => {
    const harness = makeHarness({ notFoundOnce: true, unknownSubmit: true })
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          const unknown = yield* submit(intentId, 1_000)
          const tooEarly = yield* Effect.flip(recover(intentId, MutationOperation.Submit))
          yield* TestClock.adjust(1_000)
          const notFound = yield* recover(intentId, MutationOperation.Submit)
          yield* TestClock.adjust(1_000)
          const found = yield* recover(intentId, MutationOperation.Submit)
          return { found, notFound, tooEarly, unknown }
        }),
      ),
    )

    expect(result.unknown.eventType).toBe(MutationEventType.SubmitUnknown)
    expect(result.tooEarly).toBeInstanceOf(ExecutionError)
    expect(result.tooEarly).toMatchObject({ failure: ExecutionFailure.RecoveryTooEarly })
    expect(result.notFound.eventType).toBe(MutationEventType.RecoveryNotFound)
    expect(result.found.eventType).toBe(MutationEventType.RecoveryFound)
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 2 })
    expect(harness.state()).toBe(IntentState.Acknowledged)
  })

  test('recovers an injected post-send crash by lookup without resubmitting', async () => {
    const harness = makeHarness({ crashAfterSubmit: true })
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          const crashed = yield* Effect.exit(submit(intentId, 1_000))
          yield* TestClock.adjust(1_000)
          const found = yield* recover(intentId, MutationOperation.Submit)
          return { crashed, found }
        }),
      ),
    )

    expect(Exit.isFailure(result.crashed)).toBe(true)
    expect(result.found.eventType).toBe(MutationEventType.RecoveryFound)
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 1 })
    expect(harness.state()).toBe(IntentState.Acknowledged)
  })

  test('cancels only the identified order and resolves terminal state through lookup', async () => {
    const harness = makeHarness()
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          const accepted = yield* cancel(intentId, 1_000)
          yield* TestClock.adjust(3_000)
          const found = yield* recover(intentId, MutationOperation.Cancel)
          return { accepted, found }
        }),
      ),
    )

    expect(result.accepted.eventType).toBe(MutationEventType.CancelAccepted)
    expect(result.found.eventType).toBe(MutationEventType.RecoveryFound)
    expect(harness.calls()).toEqual({ submit: 1, cancel: 1, lookup: 1 })
    expect(harness.state()).toBe(IntentState.Terminal)
  })
})
