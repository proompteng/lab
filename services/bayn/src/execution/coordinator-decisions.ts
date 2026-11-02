import { verifyProtectionGroup } from '../broker/alpaca/protection-group'
import { Option, Result, Schema } from 'effect'

import {
  type BrokerMutationError,
  MutationEvidenceSchema,
  MutationFailure,
  MutationOperation,
  type MutationEvidence,
} from '../broker/alpaca-mutations/model'
import {
  type OrderRequestBody,
  prepareCancel,
  recordedOrderRequestBody,
  orderPriceBoundaryMicros,
  orderRequestBody,
} from '../broker/alpaca-mutations/decisions'
import { legacySubmitDryRunSchemaVersion } from './legacy-wire'
import { type BrokerReadError, BrokerReadErrorKind } from '../broker/alpaca/failures'
import { OrderStatus, type Order, type ReadEvidence, type ReadResult } from '../broker/alpaca/model'
import { canonicalHashV1Result } from '../hash'
import type {
  InterruptedStartDecision,
  RecoveryPersistenceDecision,
  RecoverySelection,
} from '../cycle/runner/execution-recovery-model'
import { IntentState, MutationOutcome, RiskOutcome, TerminalOutcome, type Intent } from './contracts'
import { UtcInstantSchema } from '../schemas'
import { utcInstantFromEpochMillisResult } from '../time'
import type { StoredIntent } from './intents/domain'
import { MutationEventType, type MutationEvent } from './mutations/model'

import { submissionDenialReason, type SubmissionDenialReason } from './submission-denial'

// Pure decisions for the effectful coordinator interpreter.
export type ExecutionDecisionFailure =
  | {
      readonly _tag: 'IntentMissing'
      readonly operation: MutationOperation
      readonly intentId: string
    }
  | {
      readonly _tag: 'InvalidRiskDecision'
      readonly operationLabel: string
    }
  | {
      readonly _tag: 'ExpiredRiskDecision'
      readonly operationLabel: string
      readonly expiresAt: string
    }
  | {
      readonly _tag: 'OrderCanonicalizationFailed'
      readonly operation: MutationOperation
      readonly message: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CancellationOrderMissing'
    }
  | {
      readonly _tag: 'MutationMissing'
      readonly operation: MutationOperation
    }
  | {
      readonly _tag: 'SubmitRecoveryBlockedByCancellation'
    }
  | {
      readonly _tag: 'InvalidRecovery'
      readonly operation: MutationOperation
    }
  | {
      readonly _tag: 'RecoveryTooEarly'
      readonly operation: MutationOperation
      readonly eligibleAt: string
    }
  | {
      readonly _tag: 'InvalidInstant'
      readonly operation: MutationOperation
      readonly field: 'stored-updated-at' | 'occurred-at' | 'risk-expires-at' | 'current-time'
      readonly value: string | number
    }

export interface EncodedOrder {
  readonly request: OrderRequestBody
  readonly requestHash: string
}

export interface DryRunSubmitDecision extends EncodedOrder {
  readonly schemaVersion: typeof legacySubmitDryRunSchemaVersion
  readonly intentId: string
  readonly clientOrderId: string
}

export type SubmitPersistenceDecision =
  | {
      readonly _tag: 'SubmitAccepted'
      readonly brokerOrderId: string
      readonly evidence: MutationEvidence
      readonly terminalOutcome?: TerminalOutcome
    }
  | {
      readonly _tag: 'SubmitRejected'
      readonly evidence: MutationEvidence
    }
  | {
      readonly _tag: 'SubmitDenied'
      readonly denialReason: SubmissionDenialReason
    }
  | {
      readonly _tag: 'SubmitUnknown'
      readonly brokerOrderId?: string
      readonly evidence?: MutationEvidence
    }

export type CancelPersistenceDecision =
  | {
      readonly _tag: 'CancelAccepted'
      readonly evidence: MutationEvidence
    }
  | {
      readonly _tag: 'CancelUnknown'
      readonly evidence?: MutationEvidence
    }

export type {
  InterruptedStartDecision,
  RecoveryPersistenceDecision,
  RecoverySelection,
} from '../cycle/runner/execution-recovery-model'

interface SubmitReceipt {
  readonly requestHash: string
  readonly order: Order
  readonly evidence: MutationEvidence
}

interface CancelReceipt {
  readonly requestHash: string
  readonly brokerOrderId: string
  readonly evidence: MutationEvidence
}

const completeMutationEvidence = Schema.is(MutationEvidenceSchema)
const isUtcInstant = Schema.is(UtcInstantSchema)

export const selectStoredIntent = (
  operation: MutationOperation,
  intentId: string,
  stored: Option.Option<StoredIntent>,
): Result.Result<StoredIntent, ExecutionDecisionFailure> =>
  Option.match(stored, {
    onNone: () => Result.fail({ _tag: 'IntentMissing', operation, intentId }),
    onSome: Result.succeed,
  })

const parseInstant = (
  operation: MutationOperation,
  field: Extract<ExecutionDecisionFailure, { readonly _tag: 'InvalidInstant' }>['field'],
  value: string,
): Result.Result<number, ExecutionDecisionFailure> => {
  const epochMillis = Date.parse(value)
  return Number.isFinite(epochMillis)
    ? Result.succeed(epochMillis)
    : Result.fail({ _tag: 'InvalidInstant', operation, field, value })
}

const formatInstant = (
  operation: MutationOperation,
  field: Extract<ExecutionDecisionFailure, { readonly _tag: 'InvalidInstant' }>['field'],
  epochMillis: number,
): Result.Result<string, ExecutionDecisionFailure> =>
  Result.flatMap(
    Result.mapError(
      utcInstantFromEpochMillisResult(epochMillis),
      (): ExecutionDecisionFailure => ({ _tag: 'InvalidInstant', operation, field, value: epochMillis }),
    ),
    (instant) =>
      isUtcInstant(instant)
        ? Result.succeed(instant)
        : Result.fail({ _tag: 'InvalidInstant', operation, field, value: epochMillis }),
  )

const validateCurrentTime = (
  operation: MutationOperation,
  currentTimeMillis: number,
): Result.Result<number, ExecutionDecisionFailure> =>
  Result.map(formatInstant(operation, 'current-time', currentTimeMillis), () => currentTimeMillis)

export const nextInstant = (
  operation: MutationOperation,
  instant: string,
  current: string,
): Result.Result<string, ExecutionDecisionFailure> =>
  Result.flatMap(parseInstant(operation, 'stored-updated-at', instant), (instantMillis) =>
    Result.flatMap(parseInstant(operation, 'occurred-at', current), (currentMillis) =>
      currentMillis >= instantMillis + 1
        ? formatInstant(operation, 'occurred-at', currentMillis)
        : formatInstant(operation, 'stored-updated-at', instantMillis + 1),
    ),
  )

export const encodeOrder = (
  operation: MutationOperation,
  intent: Intent,
  message = 'intent cannot be represented as an Alpaca order',
): Result.Result<EncodedOrder, ExecutionDecisionFailure> =>
  orderRequestBody(intent).pipe(
    Result.mapError(
      (cause): ExecutionDecisionFailure => ({ _tag: 'OrderCanonicalizationFailed', operation, message, cause }),
    ),
    Result.flatMap((request) =>
      canonicalHashV1Result(request).pipe(
        Result.map((requestHash) => ({ request, requestHash })),
        Result.mapError(
          (cause): ExecutionDecisionFailure => ({
            _tag: 'OrderCanonicalizationFailed',
            operation,
            message,
            cause,
          }),
        ),
      ),
    ),
  )

const validateSubmitRiskDecision = (
  stored: StoredIntent,
  currentTimeMillis: number,
  operationLabel: string,
  expectedState: IntentState,
): Result.Result<StoredIntent, ExecutionDecisionFailure> => {
  const decision = stored.decision
  if (
    stored.intent.state !== expectedState ||
    decision?.outcome !== RiskOutcome.Approved ||
    stored.intent.riskDecisionId !== decision.decisionId
  ) {
    return Result.fail({ _tag: 'InvalidRiskDecision', operationLabel })
  }
  return Result.flatMap(validateCurrentTime(MutationOperation.Submit, currentTimeMillis), (currentMillis) =>
    Result.flatMap(parseInstant(MutationOperation.Submit, 'risk-expires-at', decision.expiresAt), (expiresAt) =>
      currentMillis >= expiresAt
        ? Result.fail({ _tag: 'ExpiredRiskDecision', operationLabel, expiresAt: decision.expiresAt })
        : Result.succeed(stored),
    ),
  )
}

export const validateActiveSubmitRiskDecision = (
  stored: StoredIntent,
  currentTimeMillis: number,
  operationLabel = 'submission',
): Result.Result<StoredIntent, ExecutionDecisionFailure> =>
  validateSubmitRiskDecision(stored, currentTimeMillis, operationLabel, IntentState.Approved)

export const validateStartedSubmitRiskDecision = (
  stored: StoredIntent,
  currentTimeMillis: number,
): Result.Result<StoredIntent, ExecutionDecisionFailure> =>
  validateSubmitRiskDecision(stored, currentTimeMillis, 'final submission', IntentState.IoStarted)

export const makeDryRunSubmit = (
  stored: StoredIntent,
  currentTimeMillis: number,
): Result.Result<DryRunSubmitDecision, ExecutionDecisionFailure> =>
  validateActiveSubmitRiskDecision(stored, currentTimeMillis, 'dry-run submission').pipe(
    Result.flatMap(({ intent }) =>
      encodeOrder(MutationOperation.Submit, intent, 'approved intent cannot be represented as an Alpaca order').pipe(
        Result.map(({ request, requestHash }) => ({
          schemaVersion: legacySubmitDryRunSchemaVersion,
          intentId: intent.intentId,
          clientOrderId: intent.clientOrderId,
          requestHash,
          request,
        })),
      ),
    ),
  )

export const terminalOutcome = (status: OrderStatus): TerminalOutcome | undefined => {
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

export const exactOrder = (intent: Intent, request: OrderRequestBody, order: Order): boolean => {
  const limitPrice = 'limit_price' in request ? orderPriceBoundaryMicros(intent) : Result.succeed(undefined)
  if (Result.isFailure(limitPrice)) return false
  const representationMatches = order.quantityAtoms === intent.quantityAtoms && order.notionalMicros === undefined
  return (
    order.accountId === intent.accountId &&
    order.clientOrderId === intent.clientOrderId &&
    order.symbol === intent.symbol &&
    order.side === request.side &&
    order.orderType === request.type &&
    order.timeInForce === request.time_in_force &&
    representationMatches &&
    order.limitPriceMicros === (limitPrice.success === undefined ? undefined : limitPrice.success.toString()) &&
    order.extendedHours === request.extended_hours &&
    order.orderClass === (request.order_class ?? 'simple') &&
    order.stopPriceMicros ===
      (intent.protection?._tag === 'StopLimit' ? intent.protection.stopPriceMicros : undefined) &&
    (intent.protection === undefined ||
      intent.protection._tag === 'StopLimit' ||
      Result.isSuccess(
        verifyProtectionGroup(order, {
          symbol: intent.symbol,
          quantityAtoms: intent.quantityAtoms,
          protection: intent.protection,
        }),
      ))
  )
}

export const completeEvidence = (value: unknown): MutationEvidence | undefined =>
  completeMutationEvidence(value) ? value : undefined

export const mutationEvidence = (evidence: ReadEvidence): MutationEvidence => ({
  requestId: evidence.requestId,
  status: evidence.status,
  contentHash: evidence.contentHash,
  observedAt: evidence.observedAt,
})

export const readErrorEvidence = (error: BrokerReadError): MutationEvidence | undefined =>
  completeEvidence({
    requestId: error.requestId,
    status: error.status,
    contentHash: error.contentHash,
    observedAt: error.observedAt,
  })

export const decideSubmitFailure = (
  expectedRequestHash: string,
  error: BrokerMutationError,
): SubmitPersistenceDecision => {
  const evidence = completeEvidence(error.evidence)
  return error.failure === MutationFailure.Rejected &&
    error.requestHash === expectedRequestHash &&
    evidence !== undefined
    ? { _tag: 'SubmitRejected', evidence }
    : error.failure === MutationFailure.InvalidRequest &&
        error.outcome === MutationOutcome.Known &&
        error.brokerOrderId === undefined &&
        evidence === undefined
      ? { _tag: 'SubmitDenied', denialReason: error.denialReason ?? submissionDenialReason(error.cause) }
      : {
          _tag: 'SubmitUnknown',
          ...(error.brokerOrderId === undefined ? {} : { brokerOrderId: error.brokerOrderId }),
          ...(evidence === undefined ? {} : { evidence }),
        }
}

export const decideSubmitSuccess = (
  intent: Intent,
  encoded: EncodedOrder,
  receipt: SubmitReceipt,
): SubmitPersistenceDecision => {
  if (receipt.requestHash !== encoded.requestHash || !exactOrder(intent, encoded.request, receipt.order)) {
    return {
      _tag: 'SubmitUnknown',
      brokerOrderId: receipt.order.brokerOrderId,
      evidence: receipt.evidence,
    }
  }
  const outcome = terminalOutcome(receipt.order.status)
  return {
    _tag: 'SubmitAccepted',
    brokerOrderId: receipt.order.brokerOrderId,
    evidence: receipt.evidence,
    ...(outcome === undefined ? {} : { terminalOutcome: outcome }),
  }
}

export const cancellationIdentity = (
  submitEvent: MutationEvent | undefined,
): Result.Result<{ readonly brokerOrderId: string; readonly requestHash: string }, ExecutionDecisionFailure> =>
  submitEvent?.brokerOrderId === undefined
    ? Result.fail({ _tag: 'CancellationOrderMissing' })
    : Result.mapError(
        prepareCancel(submitEvent.brokerOrderId),
        (cause): ExecutionDecisionFailure => ({
          _tag: 'OrderCanonicalizationFailed',
          operation: MutationOperation.Cancel,
          message: 'cancellation order cannot be represented by a current Alpaca request',
          cause,
        }),
      )

export const decideCancelFailure = (error: BrokerMutationError): CancelPersistenceDecision => {
  const evidence = completeEvidence(error.evidence)
  return {
    _tag: 'CancelUnknown',
    ...(evidence === undefined ? {} : { evidence }),
  }
}

export const decideCancelSuccess = (
  brokerOrderId: string,
  requestHash: string,
  receipt: CancelReceipt,
): CancelPersistenceDecision =>
  receipt.requestHash === requestHash && receipt.brokerOrderId === brokerOrderId
    ? { _tag: 'CancelAccepted', evidence: receipt.evidence }
    : { _tag: 'CancelUnknown', evidence: receipt.evidence }

const submitResolved = (intent: Intent, event: MutationEvent): boolean =>
  intent.state === IntentState.Terminal &&
  (event.eventType === MutationEventType.SubmitAccepted ||
    event.eventType === MutationEventType.SubmitRejected ||
    event.eventType === MutationEventType.SubmitDenied ||
    event.eventType === MutationEventType.RecoveryFound)

export const selectRecovery = (
  operation: MutationOperation,
  intent: Intent,
  event: MutationEvent | undefined,
): Result.Result<RecoverySelection, ExecutionDecisionFailure> => {
  if (event === undefined) return Result.fail({ _tag: 'MutationMissing', operation })
  const complete =
    (operation === MutationOperation.Submit && submitResolved(intent, event)) ||
    (operation === MutationOperation.Cancel &&
      intent.state === IntentState.Terminal &&
      event.eventType === MutationEventType.RecoveryFound)
  return Result.succeed(complete ? { _tag: 'RecoveryComplete', event } : { _tag: 'RecoveryRequired', event })
}

const recoveryRequestHash = (
  intent: Intent,
  event: MutationEvent,
): Result.Result<string | undefined, ExecutionDecisionFailure> =>
  event.operation === MutationOperation.Submit
    ? recordedOrderRequestBody(intent, event.requestHash).pipe(
        Result.map(() => event.requestHash),
        Result.mapError(
          (cause): ExecutionDecisionFailure => ({
            _tag: 'OrderCanonicalizationFailed',
            operation: event.operation,
            message: 'durable submit request cannot be represented by a current Alpaca order',
            cause,
          }),
        ),
      )
    : event.brokerOrderId === undefined
      ? Result.succeed(undefined)
      : Result.map(cancellationIdentity(event), ({ requestHash }) => requestHash)

export const validateRecovery = (
  intent: Intent,
  event: MutationEvent,
  cancellation: MutationEvent | undefined,
): Result.Result<MutationEvent, ExecutionDecisionFailure> => {
  if (event.operation === MutationOperation.Submit && cancellation !== undefined) {
    return Result.fail({ _tag: 'SubmitRecoveryBlockedByCancellation' })
  }
  return recoveryRequestHash(intent, event).pipe(
    Result.flatMap((expectedHash) => {
      const validState =
        event.operation === MutationOperation.Submit
          ? intent.state === IntentState.IoStarted ||
            intent.state === IntentState.Unknown ||
            intent.state === IntentState.Acknowledged
          : intent.state === IntentState.Acknowledged ||
            (intent.state === IntentState.Unknown && event.brokerOrderId !== undefined)
      if (expectedHash === event.requestHash && validState) return Result.succeed(event)
      const failure: ExecutionDecisionFailure = { _tag: 'InvalidRecovery', operation: event.operation }
      return Result.fail(failure)
    }),
  )
}

export const ensureRecoveryDelay = (
  operation: MutationOperation,
  event: MutationEvent,
  currentMillis: number,
): Result.Result<MutationEvent, ExecutionDecisionFailure> =>
  Result.flatMap(parseInstant(operation, 'occurred-at', event.occurredAt), (occurredAt) =>
    Result.flatMap(validateCurrentTime(operation, currentMillis), (now) => {
      const eligibleMillis = occurredAt + event.consistencyDelayMs
      return now >= eligibleMillis
        ? Result.succeed(event)
        : Result.flatMap(formatInstant(operation, 'occurred-at', eligibleMillis), (eligibleAt) =>
            Result.fail({
              _tag: 'RecoveryTooEarly',
              operation,
              eligibleAt,
            }),
          )
    }),
  )

export const decideInterruptedStart = (event: MutationEvent, occurredAt: string): InterruptedStartDecision => {
  if (event.eventType === MutationEventType.SubmitStarted) {
    return { _tag: 'MarkSubmitUnknown', event, occurredAt }
  }
  return event.eventType === MutationEventType.CancelStarted && event.brokerOrderId !== undefined
    ? { _tag: 'MarkCancelUnknown', event, brokerOrderId: event.brokerOrderId, occurredAt }
    : { _tag: 'KeepMutation', event }
}

export const decideRecoveryFailure = (error: BrokerReadError): RecoveryPersistenceDecision => {
  const evidence = readErrorEvidence(error)
  return error.kind === BrokerReadErrorKind.NotFound && evidence !== undefined
    ? { _tag: 'RecoveryNotFound', evidence }
    : {
        _tag: 'RecoveryUnknown',
        ...(evidence === undefined ? {} : { evidence }),
      }
}

export const decideRecoverySuccess = (
  intent: Intent,
  operation: MutationOperation,
  interrupted: MutationEvent,
  result: ReadResult<Order>,
  submitted: MutationEvent | undefined,
): RecoveryPersistenceDecision => {
  const evidence = mutationEvidence(result.evidence)
  const outcome = terminalOutcome(result.value.status)
  const neutralizedMismatchedOrder =
    operation === MutationOperation.Cancel &&
    interrupted.brokerOrderId === result.value.brokerOrderId &&
    result.value.filledQuantityAtoms === '0' &&
    outcome !== undefined &&
    outcome !== TerminalOutcome.Filled
  const exactBrokerOrderId =
    interrupted.brokerOrderId === undefined || interrupted.brokerOrderId === result.value.brokerOrderId
  const requestHash = operation === MutationOperation.Submit ? interrupted.requestHash : submitted?.requestHash
  const request = requestHash === undefined ? undefined : recordedOrderRequestBody(intent, requestHash)
  const matchesIntent =
    request !== undefined && Result.isSuccess(request) && exactOrder(intent, request.success, result.value)

  return (!exactBrokerOrderId || !matchesIntent) && !neutralizedMismatchedOrder
    ? { _tag: 'RecoveryUnknown', evidence }
    : {
        _tag: 'RecoveryFound',
        brokerOrderId: result.value.brokerOrderId,
        evidence,
        ...(outcome === undefined ? {} : { terminalOutcome: outcome }),
      }
}

export const recoveryObservationRequiresPersistence = (
  current: MutationEvent,
  decision: RecoveryPersistenceDecision,
): boolean =>
  !(
    current.eventType === MutationEventType.RecoveryFound &&
    decision._tag === 'RecoveryFound' &&
    decision.terminalOutcome === undefined &&
    current.brokerOrderId === decision.brokerOrderId &&
    current.responseStatus === decision.evidence.status &&
    current.responseContentHash === decision.evidence.contentHash
  )
