import { describe, expect, test } from 'bun:test'

import { Cause, Clock, Duration, Effect, Exit, Fiber, Option } from 'effect'
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
import { unusedAssetBySymbol, unusedMarketCalendar } from '../broker/alpaca-test-support'
import { canonicalHashV1 } from '../hash'
import {
  IntentState,
  MutationOutcome,
  OrderSide,
  OrderType,
  RiskOutcome,
  TerminalOutcome,
  TimeInForce,
  type Intent,
  type RiskDecision,
} from '../paper'
import { cancel, dryRunSubmit, ExecutionError, ExecutionFailure, recover, submit } from './coordinator'
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

const riskDecision: RiskDecision = {
  schemaVersion: 'bayn.paper-risk-decision.v1',
  decisionId: 'b'.repeat(64),
  inputHash: 'f'.repeat(64),
  intentId,
  policyHash: intent.policyHash,
  outcome: RiskOutcome.Approved,
  reasonCodes: [],
  decidedAt: initialTime,
  expiresAt: '1970-01-01T00:10:00.000Z',
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
  readonly lostFenceAfterSubmit?: boolean
  readonly lookupFailureOnceAfterMs?: number
  readonly notFoundOnce?: boolean
  readonly unknownSubmit?: boolean
  readonly submitError?: BrokerMutationError
  readonly submittedOrder?: Order
  readonly lookupOrder?: Order
  readonly lookupOrders?: readonly Order[]
}

const makeHarness = (options: HarnessOptions = {}) => {
  let stored: StoredIntent = { intent, decision: riskDecision, stateVersion: 3, updatedAt: initialTime }
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
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash || existing.consistencyDelayMs !== consistencyDelayMs) {
          return Effect.die(new Error('mutation identity was reused with different request content'))
        }
        return Effect.succeed({ event: existing, started: false })
      }
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
    submitUnknown: (_intentId, requestHash, occurredAt, response, brokerOrderId) => {
      const unknown = event(
        MutationOperation.Submit,
        MutationEventType.SubmitUnknown,
        requestHash,
        latest.get(MutationOperation.Submit)?.consistencyDelayMs ?? 1,
        occurredAt,
        brokerOrderId,
        completeEvidence(response),
      )
      setState(IntentState.Unknown, occurredAt)
      return Effect.succeed(unknown)
    },
    beginCancel: (_intentId, requestHash, brokerOrderId, consistencyDelayMs, occurredAt) => {
      const existing = latest.get(MutationOperation.Cancel)
      if (existing !== undefined) {
        if (
          existing.requestHash !== requestHash ||
          existing.consistencyDelayMs !== consistencyDelayMs ||
          existing.brokerOrderId !== brokerOrderId
        ) {
          return Effect.die(new Error('mutation identity was reused with different request content'))
        }
        return Effect.succeed({ event: existing, started: false })
      }
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
      if (options.submitError !== undefined) return Effect.fail(options.submitError)
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
      return Effect.succeed({ requestHash: hash, order: options.submittedOrder ?? brokerOrder(), evidence: response })
    },
    cancel: (brokerOrderId) => {
      cancelCalls += 1
      const response = evidence(204, '1970-01-01T00:00:01.100Z')
      return Effect.succeed({ requestHash: cancelRequestHash(brokerOrderId), brokerOrderId, evidence: response })
    },
  }

  const read: BrokerReadShape = {
    account: Effect.die(new Error('unexpected account read')),
    accountConfiguration: Effect.die(new Error('unexpected account configuration read')),
    assetBySymbol: unusedAssetBySymbol,
    positions: Effect.die(new Error('unexpected positions read')),
    orders: () => Effect.die(new Error('unexpected orders read')),
    orderById: () => Effect.die(new Error('unexpected order-by-id read')),
    orderByClientId: () =>
      Effect.gen(function* () {
        lookupCalls += 1
        if (options.lookupFailureOnceAfterMs !== undefined && lookupCalls === 1) {
          yield* Effect.sleep(Duration.millis(options.lookupFailureOnceAfterMs))
          return yield* Effect.fail(
            new BrokerReadError({
              operation: 'order-by-client-id',
              kind: BrokerReadErrorKind.Timeout,
              message: 'injected delayed lookup timeout',
              retryable: false,
            }),
          )
        }
        const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
        if (options.notFoundOnce && lookupCalls === 1) {
          return yield* Effect.fail(
            new BrokerReadError({
              operation: 'order-by-client-id',
              kind: BrokerReadErrorKind.NotFound,
              message: 'injected delayed visibility',
              retryable: false,
              status: 404,
              requestId: 'lookup-not-found',
              contentHash: canonicalHashV1({ code: 404, message: 'order not found' }),
              observedAt,
            }),
          )
        }
        const selected =
          options.lookupOrders?.[Math.min(lookupCalls - 1, options.lookupOrders.length - 1)] ??
          options.lookupOrder ??
          (latest.get(MutationOperation.Cancel) === undefined
            ? brokerOrder(OrderStatus.Accepted)
            : brokerOrder(OrderStatus.Canceled))
        const value = { ...selected, observedAt }
        return { value, evidence: evidence(200, observedAt) }
      }),
    fillActivities: () => Effect.die(new Error('unexpected fill read')),
    marketCalendar: unusedMarketCalendar,
  }

  const fenceCheck = Effect.suspend(() => {
    if (!options.lostFence && !(options.lostFenceAfterSubmit && latest.has(MutationOperation.Submit))) {
      return Effect.void
    }
    return Effect.fail(
      new WriterFenceError({
        failure: 'unavailable',
        operation: 'check',
        message: 'injected writer-fence loss',
      }),
    )
  })

  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(IntentStore, intentStore),
      Effect.provideService(MutationStore, mutationStore),
      Effect.provideService(BrokerMutation, mutation),
      Effect.provideService(BrokerRead, read),
      Effect.provideService(WriterFence, {
        backendPid: 1,
        check: fenceCheck,
        transaction: (effect) => effect,
      }),
      Effect.provide(TestClock.layer()),
    )
  const provideIntentRead = <A, E>(effect: Effect.Effect<A, E, IntentStore>) =>
    effect.pipe(Effect.provideService(IntentStore, intentStore), Effect.provide(TestClock.layer()))

  return {
    provide,
    provideIntentRead,
    calls: () => ({ submit: submitCalls, cancel: cancelCalls, lookup: lookupCalls }),
    intent: () => stored.intent,
    state: () => stored.intent.state,
  }
}

const mismatchedSubmissionError = () =>
  new BrokerMutationError({
    operation: MutationOperation.Submit,
    failure: MutationFailure.Unknown,
    outcome: MutationOutcome.Unknown,
    message: 'accepted order differs from durable intent',
    requestHash: canonicalHashV1(orderRequestBody(intent)),
    evidence: evidence(200, '1970-01-01T00:00:00.100Z'),
    brokerOrderId: orderId,
  })

describe('paper execution coordinator', () => {
  test('renders the exact committed request without touching the broker or mutation store', async () => {
    const harness = makeHarness()
    const result = await Effect.runPromise(harness.provideIntentRead(dryRunSubmit(intentId)))

    expect(result).toEqual({
      schemaVersion: 'bayn.paper-submit-dry-run.v1',
      intentId,
      clientOrderId: intent.clientOrderId,
      requestHash: canonicalHashV1(orderRequestBody(intent)),
      request: orderRequestBody(intent),
    })
    expect(harness.calls()).toEqual({ submit: 0, cancel: 0, lookup: 0 })
    expect(harness.state()).toBe(IntentState.Approved)
  })

  test('rejects a dry-run request when its approved risk decision has expired', async () => {
    const harness = makeHarness()
    const failure = await Effect.runPromise(
      harness.provideIntentRead(
        Effect.gen(function* () {
          yield* TestClock.adjust(600_000)
          return yield* Effect.flip(dryRunSubmit(intentId))
        }),
      ),
    )

    expect(failure).toBeInstanceOf(ExecutionError)
    expect(failure).toMatchObject({
      failure: ExecutionFailure.InvalidState,
      message: `dry-run submission risk decision expired at ${riskDecision.expiresAt}`,
    })
    expect(harness.calls()).toEqual({ submit: 0, cancel: 0, lookup: 0 })
    expect(harness.state()).toBe(IntentState.Approved)
  })

  test('makes zero POST calls when the risk decision expires exactly at submission', async () => {
    const harness = makeHarness()
    const failure = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* TestClock.adjust(600_000)
          return yield* Effect.flip(submit(intentId, 1_000))
        }),
      ),
    )

    expect(failure).toBeInstanceOf(ExecutionError)
    expect(failure).toMatchObject({
      failure: ExecutionFailure.InvalidState,
      message: `submission risk decision expired at ${riskDecision.expiresAt}`,
    })
    expect(harness.calls()).toEqual({ submit: 0, cancel: 0, lookup: 0 })
    expect(harness.state()).toBe(IntentState.Approved)
  })

  test('records before submission and never calls the broker again for a replayed intent', async () => {
    const harness = makeHarness()
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          const accepted = yield* submit(intentId, 1_000)
          yield* TestClock.adjust(600_000)
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

  test('recovers an accepted order to terminal at the exact delay without another POST', async () => {
    const harness = makeHarness({ lookupOrder: brokerOrder(OrderStatus.Filled) })
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          const accepted = yield* submit(intentId, 1_000)
          yield* TestClock.adjust(1_099)
          const tooEarly = yield* Effect.flip(recover(intentId, MutationOperation.Submit))
          yield* TestClock.adjust(1)
          const terminal = yield* recover(intentId, MutationOperation.Submit)
          const replay = yield* recover(intentId, MutationOperation.Submit)
          return { accepted, replay, terminal, tooEarly }
        }),
      ),
    )

    expect(result.accepted.eventType).toBe(MutationEventType.SubmitAccepted)
    expect(result.tooEarly).toMatchObject({
      failure: ExecutionFailure.RecoveryTooEarly,
      eligibleAt: '1970-01-01T00:00:01.100Z',
    })
    expect(result.terminal.eventType).toBe(MutationEventType.RecoveryFound)
    expect(result.replay.eventId).toBe(result.terminal.eventId)
    expect(harness.intent()).toMatchObject({
      state: IntentState.Terminal,
      terminalOutcome: TerminalOutcome.Filled,
    })
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 1 })
  })

  test('retains an accepted open order and allows a later terminal recovery after the next delay', async () => {
    const harness = makeHarness({
      lookupOrders: [brokerOrder(OrderStatus.Accepted), brokerOrder(OrderStatus.Filled)],
    })
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          yield* TestClock.adjust(1_100)
          const open = yield* recover(intentId, MutationOperation.Submit)
          const tooEarly = yield* Effect.flip(recover(intentId, MutationOperation.Submit))
          yield* TestClock.adjust(1_000)
          const terminal = yield* recover(intentId, MutationOperation.Submit)
          return { open, terminal, tooEarly }
        }),
      ),
    )

    expect(result.open.eventType).toBe(MutationEventType.RecoveryFound)
    expect(result.tooEarly).toMatchObject({
      failure: ExecutionFailure.RecoveryTooEarly,
      eligibleAt: '1970-01-01T00:00:02.100Z',
    })
    expect(result.terminal.eventType).toBe(MutationEventType.RecoveryFound)
    expect(harness.intent()).toMatchObject({
      state: IntentState.Terminal,
      terminalOutcome: TerminalOutcome.Filled,
    })
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 2 })
  })

  test('timestamps evidence-less recovery failure after lookup I/O and enforces the next full delay', async () => {
    const harness = makeHarness({
      lookupFailureOnceAfterMs: 400,
      lookupOrder: brokerOrder(OrderStatus.Filled),
    })
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          yield* TestClock.adjust(1_100)
          const recovery = yield* recover(intentId, MutationOperation.Submit).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* TestClock.adjust(400)
          const unknown = yield* Fiber.join(recovery)
          yield* TestClock.adjust(999)
          const tooEarly = yield* Effect.flip(recover(intentId, MutationOperation.Submit))
          const callsBeforeFullDelay = harness.calls()
          yield* TestClock.adjust(1)
          const terminal = yield* recover(intentId, MutationOperation.Submit)
          return { callsBeforeFullDelay, terminal, tooEarly, unknown }
        }),
      ),
    )

    expect(result.unknown).toMatchObject({
      eventType: MutationEventType.RecoveryUnknown,
      occurredAt: '1970-01-01T00:00:01.500Z',
    })
    expect(result.tooEarly).toMatchObject({
      failure: ExecutionFailure.RecoveryTooEarly,
      eligibleAt: '1970-01-01T00:00:02.500Z',
    })
    expect(result.callsBeforeFullDelay).toEqual({ submit: 1, cancel: 0, lookup: 1 })
    expect(result.terminal.eventType).toBe(MutationEventType.RecoveryFound)
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 2 })
    expect(harness.intent()).toMatchObject({
      state: IntentState.Terminal,
      terminalOutcome: TerminalOutcome.Filled,
    })
  })

  test('retains an accepted broker order identity after a 404 and allows later terminal recovery', async () => {
    const harness = makeHarness({
      notFoundOnce: true,
      lookupOrder: brokerOrder(OrderStatus.Filled),
    })
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          yield* TestClock.adjust(1_100)
          const notFound = yield* recover(intentId, MutationOperation.Submit)
          const afterNotFound = harness.intent()
          yield* TestClock.adjust(1_000)
          const terminal = yield* recover(intentId, MutationOperation.Submit)
          return { afterNotFound, notFound, terminal }
        }),
      ),
    )

    expect(result.notFound).toMatchObject({
      eventType: MutationEventType.RecoveryNotFound,
      brokerOrderId: orderId,
    })
    expect(result.afterNotFound).toMatchObject({ state: IntentState.Acknowledged })
    expect(result.terminal).toMatchObject({
      eventType: MutationEventType.RecoveryFound,
      brokerOrderId: orderId,
    })
    expect(harness.intent()).toMatchObject({
      state: IntentState.Terminal,
      terminalOutcome: TerminalOutcome.Filled,
    })
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 2 })
  })

  test('recovers a durable cancellation before allowing submit history to resolve', async () => {
    const harness = makeHarness()
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          yield* cancel(intentId, 1_000)
          yield* TestClock.adjust(1_100)
          const blockedSubmit = yield* Effect.flip(recover(intentId, MutationOperation.Submit))
          yield* TestClock.adjust(1_000)
          const canceled = yield* recover(intentId, MutationOperation.Cancel)
          const submitReplay = yield* recover(intentId, MutationOperation.Submit)
          return { blockedSubmit, canceled, submitReplay }
        }),
      ),
    )

    expect(result.blockedSubmit).toMatchObject({
      failure: ExecutionFailure.InvalidState,
      message: 'submit recovery requires the durable cancellation to recover first',
    })
    expect(result.canceled).toMatchObject({
      eventType: MutationEventType.RecoveryFound,
      brokerOrderId: orderId,
    })
    expect(result.submitReplay.eventType).toBe(MutationEventType.SubmitAccepted)
    expect(harness.intent()).toMatchObject({
      state: IntentState.Terminal,
      terminalOutcome: TerminalOutcome.Canceled,
    })
    expect(harness.calls()).toEqual({ submit: 1, cancel: 1, lookup: 1 })
  })

  test('keeps an accepted intent acknowledged when lookup returns a different broker order', async () => {
    const otherOrderId = 'f93d3f58-0e70-4cd2-a9e1-2fcb89d76f74'
    const harness = makeHarness({
      lookupOrder: { ...brokerOrder(OrderStatus.Filled), brokerOrderId: otherOrderId },
    })
    const observed = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          yield* TestClock.adjust(1_100)
          return yield* recover(intentId, MutationOperation.Submit)
        }),
      ),
    )

    expect(observed).toMatchObject({
      eventType: MutationEventType.RecoveryUnknown,
      brokerOrderId: orderId,
    })
    expect(harness.intent()).toMatchObject({ state: IntentState.Acknowledged })
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 1 })
  })

  test('rejects a submit replay whose committed consistency delay changes', async () => {
    const harness = makeHarness()
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          return yield* Effect.exit(submit(intentId, 1_001))
        }),
      ),
    )

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).toContain('mutation identity was reused with different request content')
    }
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 0 })
  })

  test('keeps a partial broker fill UNKNOWN instead of recording a false terminal fill', async () => {
    const harness = makeHarness({
      submittedOrder: { ...brokerOrder(OrderStatus.Filled), filledQuantityMicros: '500000' },
    })

    const result = await Effect.runPromise(harness.provide(submit(intentId, 1_000)))

    expect(result).toMatchObject({
      eventType: MutationEventType.SubmitUnknown,
      brokerOrderId: orderId,
    })
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 0 })
    expect(harness.state()).toBe(IntentState.Unknown)
  })

  test('cancels and closes a zero-fill mismatched accepted order by its broker ID', async () => {
    const harness = makeHarness({
      lookupOrder: { ...brokerOrder(OrderStatus.Canceled), symbol: 'NVDA' },
      submitError: mismatchedSubmissionError(),
    })

    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          const unknown = yield* submit(intentId, 1_000)
          const canceled = yield* cancel(intentId, 1_000)
          yield* TestClock.adjust(3_000)
          const found = yield* recover(intentId, MutationOperation.Cancel)
          return { unknown, canceled, found }
        }),
      ),
    )

    expect(result.unknown).toMatchObject({
      eventType: MutationEventType.SubmitUnknown,
      brokerOrderId: orderId,
    })
    expect(result.canceled.eventType).toBe(MutationEventType.CancelAccepted)
    expect(result.found.eventType).toBe(MutationEventType.RecoveryFound)
    expect(harness.calls()).toEqual({ submit: 1, cancel: 1, lookup: 1 })
    expect(harness.state()).toBe(IntentState.Terminal)
  })

  test('keeps a partially filled mismatched order UNKNOWN after cancellation', async () => {
    const harness = makeHarness({
      lookupOrder: {
        ...brokerOrder(OrderStatus.Canceled),
        symbol: 'NVDA',
        filledQuantityMicros: '1',
      },
      submitError: mismatchedSubmissionError(),
    })

    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          yield* cancel(intentId, 1_000)
          yield* TestClock.adjust(3_000)
          return yield* recover(intentId, MutationOperation.Cancel)
        }),
      ),
    )

    expect(result.eventType).toBe(MutationEventType.RecoveryUnknown)
    expect(harness.calls()).toEqual({ submit: 1, cancel: 1, lookup: 1 })
    expect(harness.state()).toBe(IntentState.Unknown)
  })

  test('makes no broker call or durable start when the writer fence is already lost', async () => {
    const harness = makeHarness({ lostFence: true })
    const failure = await Effect.runPromise(harness.provide(Effect.flip(submit(intentId, 1_000))))

    expect(failure).toBeInstanceOf(WriterFenceError)
    expect(harness.calls()).toEqual({ submit: 0, cancel: 0, lookup: 0 })
    expect(harness.state()).toBe(IntentState.Approved)
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

  test('rejects a cancel replay whose committed consistency delay changes', async () => {
    const harness = makeHarness()
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          yield* cancel(intentId, 1_000)
          return yield* Effect.exit(cancel(intentId, 1_001))
        }),
      ),
    )

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).toContain('mutation identity was reused with different request content')
    }
    expect(harness.calls()).toEqual({ submit: 1, cancel: 1, lookup: 0 })
  })

  test('cancels the exact identified order after its new-exposure risk decision expires', async () => {
    const harness = makeHarness()
    const result = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          yield* TestClock.adjust(600_000)
          return yield* cancel(intentId, 1_000)
        }),
      ),
    )

    expect(result).toMatchObject({
      eventType: MutationEventType.CancelAccepted,
      brokerOrderId: orderId,
    })
    expect(harness.calls()).toEqual({ submit: 1, cancel: 1, lookup: 0 })
    expect(harness.state()).toBe(IntentState.Acknowledged)
  })

  test('makes no DELETE call when the writer fence is lost after the durable submit', async () => {
    const harness = makeHarness({ lostFenceAfterSubmit: true })
    const failure = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          return yield* Effect.flip(cancel(intentId, 1_000))
        }),
      ),
    )

    expect(failure).toBeInstanceOf(WriterFenceError)
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 0 })
    expect(harness.state()).toBe(IntentState.Acknowledged)
  })

  test('rejects cancellation when no durable submitted order exists', async () => {
    const harness = makeHarness()
    const failure = await Effect.runPromise(harness.provide(Effect.flip(cancel(intentId, 1_000))))

    expect(failure).toBeInstanceOf(ExecutionError)
    expect(failure).toMatchObject({
      failure: ExecutionFailure.InvalidState,
      message: 'cancellation requires a positively identified broker order',
    })
    expect(harness.calls()).toEqual({ submit: 0, cancel: 0, lookup: 0 })
    expect(harness.state()).toBe(IntentState.Approved)
  })

  test('rejects cancellation when the durable submit belongs to a different intent identity', async () => {
    const harness = makeHarness()
    const otherIntentId = '0'.repeat(64)
    const failure = await Effect.runPromise(
      harness.provide(
        Effect.gen(function* () {
          yield* submit(intentId, 1_000)
          return yield* Effect.flip(cancel(otherIntentId, 1_000))
        }),
      ),
    )

    expect(failure).toBeInstanceOf(ExecutionError)
    expect(failure).toMatchObject({
      failure: ExecutionFailure.IntentNotFound,
      message: `intent ${otherIntentId} does not exist`,
    })
    expect(harness.calls()).toEqual({ submit: 1, cancel: 0, lookup: 0 })
  })
})
