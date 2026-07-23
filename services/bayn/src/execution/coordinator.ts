import { Clock, Data, Effect, Option, Schema } from 'effect'

import {
  BrokerMutation,
  MutationEvidenceSchema,
  MutationFailure,
  MutationOperation,
  cancelRequestHash,
  orderRequestBody,
  type MutationEvidence,
} from '../broker/alpaca-mutations'
import {
  BrokerRead,
  BrokerReadError,
  BrokerReadErrorKind,
  OrderStatus,
  type Order,
  type ReadEvidence,
} from '../broker/alpaca'
import { canonicalHashV1 } from '../hash'
import { IntentState, RiskOutcome, TerminalOutcome, type Intent } from '../paper'
import { IntentStore, type IntentStoreError, type StoredIntent } from './intents'
import { MutationEventType, MutationStore, type MutationEvent } from './mutations'
import { WriterFence } from './writer-fence'

export enum ExecutionFailure {
  IntentNotFound = 'INTENT_NOT_FOUND',
  InvalidState = 'INVALID_STATE',
  RecoveryTooEarly = 'RECOVERY_TOO_EARLY',
}

export class ExecutionError extends Data.TaggedError('ExecutionError')<{
  readonly operation: MutationOperation
  readonly failure: ExecutionFailure
  readonly message: string
  readonly eligibleAt?: string
  readonly cause?: unknown
}> {}

export interface DryRunSubmit {
  readonly schemaVersion: 'bayn.paper-submit-dry-run.v1'
  readonly intentId: string
  readonly clientOrderId: string
  readonly requestHash: string
  readonly request: ReturnType<typeof orderRequestBody>
}

const now = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()))

const readIntent = (operation: MutationOperation, intentId: string) =>
  Effect.gen(function* () {
    const store = yield* IntentStore
    const stored = yield* store.read(intentId)
    if (Option.isNone(stored)) {
      return yield* Effect.fail(
        new ExecutionError({
          operation,
          failure: ExecutionFailure.IntentNotFound,
          message: `intent ${intentId} does not exist`,
        }),
      )
    }
    return stored.value
  })

const nextInstant = (instant: string, current: string): string =>
  new Date(Math.max(Date.parse(current), Date.parse(instant) + 1)).toISOString()

const requestHash = (operation: MutationOperation, intent: Intent) =>
  Effect.try({
    try: () => canonicalHashV1(orderRequestBody(intent)),
    catch: (cause) =>
      new ExecutionError({
        operation,
        failure: ExecutionFailure.InvalidState,
        message: 'intent cannot be represented as an Alpaca paper order',
        cause,
      }),
  })

const terminalOutcome = (status: OrderStatus): TerminalOutcome | undefined => {
  switch (status) {
    case OrderStatus.Filled:
      return TerminalOutcome.Filled
    case OrderStatus.Canceled:
      return TerminalOutcome.Canceled
    case OrderStatus.Expired:
      return TerminalOutcome.Expired
    case OrderStatus.Rejected:
      return TerminalOutcome.Rejected
    default:
      return undefined
  }
}

const exactOrder = (intent: Intent, order: Order): boolean => {
  const body = orderRequestBody(intent)
  return (
    order.accountId === intent.accountId &&
    order.clientOrderId === intent.clientOrderId &&
    order.symbol === intent.symbol &&
    order.side === body.side &&
    order.orderType === body.type &&
    order.timeInForce === body.time_in_force &&
    order.quantityMicros === intent.quantityMicros &&
    (order.status !== OrderStatus.Filled || order.filledQuantityMicros === intent.quantityMicros) &&
    order.extendedHours === false
  )
}

const isCompleteEvidence = (value: unknown): value is MutationEvidence => Schema.is(MutationEvidenceSchema)(value)

const mutationEvidence = (evidence: ReadEvidence): MutationEvidence => ({
  requestId: evidence.requestId,
  status: evidence.status,
  contentHash: evidence.contentHash,
  observedAt: evidence.observedAt,
})

const readErrorEvidence = (error: BrokerReadError): MutationEvidence | undefined => {
  const candidate = {
    requestId: error.requestId,
    status: error.status,
    contentHash: error.contentHash,
    observedAt: error.observedAt,
  }
  return isCompleteEvidence(candidate) ? candidate : undefined
}

const isSubmitResolved = (intent: Intent, event: MutationEvent): boolean =>
  intent.state === IntentState.Terminal &&
  (event.eventType === MutationEventType.SubmitAccepted ||
    event.eventType === MutationEventType.SubmitRejected ||
    event.eventType === MutationEventType.RecoveryFound)

const requireActiveSubmitRiskDecision = (stored: StoredIntent, operationLabel = 'submission') =>
  Effect.gen(function* () {
    const decision = stored.decision
    if (
      stored.intent.state !== IntentState.Approved ||
      decision?.outcome !== RiskOutcome.Approved ||
      stored.intent.riskDecisionId !== decision.decisionId
    ) {
      return yield* Effect.fail(
        new ExecutionError({
          operation: MutationOperation.Submit,
          failure: ExecutionFailure.InvalidState,
          message: `${operationLabel} requires one committed approved intent and matching risk decision`,
        }),
      )
    }
    const currentTime = yield* Clock.currentTimeMillis
    if (currentTime >= Date.parse(decision.expiresAt)) {
      return yield* Effect.fail(
        new ExecutionError({
          operation: MutationOperation.Submit,
          failure: ExecutionFailure.InvalidState,
          message: `${operationLabel} risk decision expired at ${decision.expiresAt}`,
        }),
      )
    }
    return stored
  })

export const dryRunSubmit = (
  intentId: string,
): Effect.Effect<DryRunSubmit, ExecutionError | IntentStoreError, IntentStore> =>
  readIntent(MutationOperation.Submit, intentId).pipe(
    Effect.flatMap((stored) =>
      Effect.gen(function* () {
        yield* requireActiveSubmitRiskDecision(stored, 'dry-run submission')
        return yield* Effect.try({
          try: (): DryRunSubmit => {
            const request = orderRequestBody(stored.intent)
            return {
              schemaVersion: 'bayn.paper-submit-dry-run.v1',
              intentId: stored.intent.intentId,
              clientOrderId: stored.intent.clientOrderId,
              requestHash: canonicalHashV1(request),
              request,
            }
          },
          catch: (cause) =>
            new ExecutionError({
              operation: MutationOperation.Submit,
              failure: ExecutionFailure.InvalidState,
              message: 'approved intent cannot be represented as an Alpaca paper order',
              cause,
            }),
        })
      }),
    ),
  )

const validateRecovery = (stored: Intent, event: MutationEvent) =>
  Effect.gen(function* () {
    const expectedHash =
      event.operation === MutationOperation.Submit
        ? yield* requestHash(event.operation, stored)
        : event.brokerOrderId === undefined
          ? undefined
          : cancelRequestHash(event.brokerOrderId)
    const validState =
      event.operation === MutationOperation.Submit
        ? stored.state === IntentState.IoStarted ||
          stored.state === IntentState.Unknown ||
          stored.state === IntentState.Acknowledged
        : stored.state === IntentState.Acknowledged ||
          (stored.state === IntentState.Unknown && event.brokerOrderId !== undefined)
    if (expectedHash === event.requestHash && validState) return
    return yield* Effect.fail(
      new ExecutionError({
        operation: event.operation,
        failure: ExecutionFailure.InvalidState,
        message: 'durable mutation identity or intent state does not permit broker recovery',
      }),
    )
  })

export const submit = (intentId: string, consistencyDelayMs: number) =>
  Effect.gen(function* () {
    const mutations = yield* MutationStore
    const broker = yield* BrokerMutation
    const fence = yield* WriterFence
    const existing = yield* mutations.latest(intentId, MutationOperation.Submit)
    const before = yield* readIntent(MutationOperation.Submit, intentId)
    const hash = yield* requestHash(MutationOperation.Submit, before.intent)
    if (existing !== undefined) {
      const replay = yield* mutations.beginSubmit(intentId, hash, consistencyDelayMs, existing.occurredAt)
      return replay.event
    }
    yield* fence.check
    yield* requireActiveSubmitRiskDecision(before)
    const current = yield* now
    const started = yield* mutations.beginSubmit(
      intentId,
      hash,
      consistencyDelayMs,
      nextInstant(before.updatedAt, current),
    )
    if (!started.started) return started.event

    const submittedIntent: Intent = { ...before.intent, state: IntentState.IoStarted }

    return yield* broker.submit(submittedIntent).pipe(
      Effect.matchEffect({
        onFailure: (error) => {
          if (
            error.failure === MutationFailure.Rejected &&
            error.requestHash === hash &&
            isCompleteEvidence(error.evidence)
          ) {
            return mutations.submitRejected(intentId, hash, error.evidence)
          }
          return isCompleteEvidence(error.evidence)
            ? mutations.submitUnknown(intentId, hash, error.evidence.observedAt, error.evidence, error.brokerOrderId)
            : now.pipe(
                Effect.flatMap((occurredAt) =>
                  mutations.submitUnknown(intentId, hash, occurredAt, undefined, error.brokerOrderId),
                ),
              )
        },
        onSuccess: (receipt) => {
          if (receipt.requestHash !== hash || !exactOrder(submittedIntent, receipt.order)) {
            return mutations.submitUnknown(
              intentId,
              hash,
              receipt.evidence.observedAt,
              receipt.evidence,
              receipt.order.brokerOrderId,
            )
          }
          return mutations.submitAccepted(
            intentId,
            hash,
            receipt.order.brokerOrderId,
            receipt.evidence,
            terminalOutcome(receipt.order.status),
          )
        },
      }),
    )
  })

export const cancel = (intentId: string, consistencyDelayMs: number) =>
  Effect.gen(function* () {
    const mutations = yield* MutationStore
    const broker = yield* BrokerMutation
    const fence = yield* WriterFence
    const existing = yield* mutations.latest(intentId, MutationOperation.Cancel)
    const submitEvent = yield* mutations.latest(intentId, MutationOperation.Submit)
    const orderId = submitEvent?.brokerOrderId
    if (orderId === undefined) {
      return yield* Effect.fail(
        new ExecutionError({
          operation: MutationOperation.Cancel,
          failure: ExecutionFailure.InvalidState,
          message: 'cancellation requires a positively identified broker order',
        }),
      )
    }
    const hash = cancelRequestHash(orderId)
    if (existing !== undefined) {
      const replay = yield* mutations.beginCancel(intentId, hash, orderId, consistencyDelayMs, existing.occurredAt)
      return replay.event
    }
    const intent = yield* readIntent(MutationOperation.Cancel, intentId)
    yield* fence.check
    const current = yield* now
    const started = yield* mutations.beginCancel(
      intentId,
      hash,
      orderId,
      consistencyDelayMs,
      nextInstant(intent.updatedAt, current),
    )
    if (!started.started) return started.event

    return yield* broker.cancel(orderId).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          isCompleteEvidence(error.evidence)
            ? mutations.cancelUnknown(intentId, hash, orderId, error.evidence.observedAt, error.evidence)
            : now.pipe(Effect.flatMap((occurredAt) => mutations.cancelUnknown(intentId, hash, orderId, occurredAt))),
        onSuccess: (receipt) => {
          if (receipt.requestHash !== hash || receipt.brokerOrderId !== orderId) {
            return mutations.cancelUnknown(intentId, hash, orderId, receipt.evidence.observedAt, receipt.evidence)
          }
          return mutations.cancelAccepted(intentId, hash, orderId, receipt.evidence)
        },
      }),
    )
  })

const ensureRecoveryDelay = (operation: MutationOperation, event: MutationEvent, currentMillis: number) => {
  const eligibleMillis = Date.parse(event.occurredAt) + event.consistencyDelayMs
  if (currentMillis >= eligibleMillis) return Effect.void
  const eligibleAt = new Date(eligibleMillis).toISOString()
  return Effect.fail(
    new ExecutionError({
      operation,
      failure: ExecutionFailure.RecoveryTooEarly,
      message: `broker lookup is not allowed before ${eligibleAt}`,
      eligibleAt,
    }),
  )
}

const markInterruptedStart = (event: MutationEvent, occurredAt: string) =>
  Effect.flatMap(MutationStore, (store) => {
    if (event.eventType === MutationEventType.SubmitStarted) {
      return store.submitUnknown(event.intentId, event.requestHash, occurredAt)
    }
    if (event.eventType === MutationEventType.CancelStarted && event.brokerOrderId !== undefined) {
      return store.cancelUnknown(event.intentId, event.requestHash, event.brokerOrderId, occurredAt)
    }
    return Effect.succeed(event)
  })

export const recover = (intentId: string, operation: MutationOperation) =>
  Effect.gen(function* () {
    const mutations = yield* MutationStore
    const broker = yield* BrokerRead
    const stored = yield* readIntent(operation, intentId)
    const latest = yield* mutations.latest(intentId, operation)
    if (latest === undefined) {
      return yield* Effect.fail(
        new ExecutionError({
          operation,
          failure: ExecutionFailure.InvalidState,
          message: 'mutation does not exist',
        }),
      )
    }
    if (operation === MutationOperation.Submit && isSubmitResolved(stored.intent, latest)) return latest
    if (
      operation === MutationOperation.Cancel &&
      stored.intent.state === IntentState.Terminal &&
      latest.eventType === MutationEventType.RecoveryFound
    ) {
      return latest
    }
    yield* validateRecovery(stored.intent, latest)

    const currentMillis = yield* Clock.currentTimeMillis
    yield* ensureRecoveryDelay(operation, latest, currentMillis)
    const interrupted = yield* markInterruptedStart(latest, new Date(currentMillis).toISOString())

    return yield* broker.orderByClientId(stored.intent.clientOrderId).pipe(
      Effect.matchEffect({
        onFailure: (error) => {
          const evidence = readErrorEvidence(error)
          if (error.kind === BrokerReadErrorKind.NotFound && evidence !== undefined) {
            return mutations.recoveryNotFound(intentId, operation, interrupted.requestHash, evidence)
          }
          const occurredAt = evidence?.observedAt ?? new Date(currentMillis).toISOString()
          return mutations.recoveryUnknown(intentId, operation, interrupted.requestHash, occurredAt, evidence)
        },
        onSuccess: (result) => {
          const evidence = mutationEvidence(result.evidence)
          const outcome = terminalOutcome(result.value.status)
          const neutralizedMismatchedOrder =
            operation === MutationOperation.Cancel &&
            interrupted.brokerOrderId === result.value.brokerOrderId &&
            result.value.filledQuantityMicros === '0' &&
            outcome !== undefined &&
            outcome !== TerminalOutcome.Filled
          const exactBrokerOrderId =
            interrupted.brokerOrderId === undefined || interrupted.brokerOrderId === result.value.brokerOrderId
          if ((!exactBrokerOrderId || !exactOrder(stored.intent, result.value)) && !neutralizedMismatchedOrder) {
            return mutations.recoveryUnknown(
              intentId,
              operation,
              interrupted.requestHash,
              evidence.observedAt,
              evidence,
            )
          }
          return mutations.recoveryFound(
            intentId,
            operation,
            interrupted.requestHash,
            result.value.brokerOrderId,
            evidence,
            outcome,
          )
        },
      }),
    )
  })
