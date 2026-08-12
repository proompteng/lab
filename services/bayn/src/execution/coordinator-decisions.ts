import { Option, Result, Schema } from 'effect'

import {
  type BrokerMutationError,
  type CompatibleOrderRequestBody,
  MutationEvidenceSchema,
  MutationFailure,
  MutationOperation,
  cancelRequestHash,
  compatibleOrderRequestBody,
  orderPriceBoundaryMicros,
  orderRequestBody,
  type MutationEvidence,
  type OrderRequestBody,
} from '../broker/alpaca-mutations'
import {
  type BrokerReadError,
  BrokerReadErrorKind,
  OrderStatus,
  type Order,
  type ReadEvidence,
  type ReadResult,
} from '../broker/alpaca'
import { canonicalHashV1Result } from '../hash'
import type {
  InterruptedStartDecision,
  RecoveryPersistenceDecision,
  RecoverySelection,
} from '../cycle-runner/execution-recovery-model'
import { IntentState, MutationOutcome, RiskOutcome, TerminalOutcome, type Intent } from './contracts'
import { UtcInstantSchema } from '../schemas'
import { utcInstantFromEpochMillisResult } from '../time'
import type { StoredIntent } from './intents/domain'
import { MutationEventType, type MutationEvent } from './mutations'
import { Pipeable } from '../pipeable'

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
  readonly schemaVersion: 'bayn.paper-submit-dry-run.v1'
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
} from '../cycle-runner/execution-recovery-model'

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

const selectStoredIntentDataFirst = (
  operation: MutationOperation,
  intentId: string,
  stored: Option.Option<StoredIntent>,
): Result.Result<StoredIntent, ExecutionDecisionFailure> =>
  Option.match(stored, {
    onNone: () => Result.fail({ _tag: 'IntentMissing', operation, intentId }),
    onSome: Result.succeed,
  })

export const selectStoredIntent = Pipeable.dual(3, selectStoredIntentDataFirst)

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

const nextInstantDataFirst = (
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

export const nextInstant = Pipeable.dual(3, nextInstantDataFirst)

const encodeOrderDataFirst = (
  operation: MutationOperation,
  intent: Intent,
  message = 'intent cannot be represented as an Alpaca paper order',
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

export const encodeOrder = Pipeable.by<
  (intent: Intent, message?: string) => (operation: MutationOperation) => ReturnType<typeof encodeOrderDataFirst>,
  typeof encodeOrderDataFirst
>((arguments_) => typeof arguments_[0] === 'string', encodeOrderDataFirst)

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

const validateActiveSubmitRiskDecisionDataFirst = (
  stored: StoredIntent,
  currentTimeMillis: number,
  operationLabel = 'submission',
): Result.Result<StoredIntent, ExecutionDecisionFailure> =>
  validateSubmitRiskDecision(stored, currentTimeMillis, operationLabel, IntentState.Approved)

export const validateActiveSubmitRiskDecision = Pipeable.by<
  (
    currentTimeMillis: number,
    operationLabel?: string,
  ) => (stored: StoredIntent) => ReturnType<typeof validateActiveSubmitRiskDecisionDataFirst>,
  typeof validateActiveSubmitRiskDecisionDataFirst
>(
  (arguments_) => typeof arguments_[0] === 'object' && arguments_[0] !== null,
  validateActiveSubmitRiskDecisionDataFirst,
)

const validateStartedSubmitRiskDecisionDataFirst = (
  stored: StoredIntent,
  currentTimeMillis: number,
): Result.Result<StoredIntent, ExecutionDecisionFailure> =>
  validateSubmitRiskDecision(stored, currentTimeMillis, 'final submission', IntentState.IoStarted)

export const validateStartedSubmitRiskDecision = Pipeable.dual(2, validateStartedSubmitRiskDecisionDataFirst)

const makeDryRunSubmitDataFirst = (
  stored: StoredIntent,
  currentTimeMillis: number,
): Result.Result<DryRunSubmitDecision, ExecutionDecisionFailure> =>
  validateActiveSubmitRiskDecision(stored, currentTimeMillis, 'dry-run submission').pipe(
    Result.flatMap(({ intent }) =>
      encodeOrder(
        MutationOperation.Submit,
        intent,
        'approved intent cannot be represented as an Alpaca paper order',
      ).pipe(
        Result.map(({ request, requestHash }) => ({
          schemaVersion: 'bayn.paper-submit-dry-run.v1' as const,
          intentId: intent.intentId,
          clientOrderId: intent.clientOrderId,
          requestHash,
          request,
        })),
      ),
    ),
  )

export const makeDryRunSubmit = Pipeable.dual(2, makeDryRunSubmitDataFirst)

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

const exactOrderDataFirst = (intent: Intent, request: CompatibleOrderRequestBody, order: Order): boolean => {
  const limitPrice = 'limit_price' in request ? orderPriceBoundaryMicros(intent) : Result.succeed(undefined)
  if (Result.isFailure(limitPrice)) return false
  const representationMatches =
    'notional' in request
      ? order.notionalMicros === intent.notionalLimitMicros && order.quantityMicros === undefined
      : order.quantityMicros === intent.quantityMicros && order.notionalMicros === undefined
  return (
    order.accountId === intent.accountId &&
    order.clientOrderId === intent.clientOrderId &&
    order.symbol === intent.symbol &&
    order.side === request.side &&
    order.orderType === request.type &&
    order.timeInForce === request.time_in_force &&
    representationMatches &&
    order.limitPriceMicros === (limitPrice.success === undefined ? undefined : limitPrice.success.toString()) &&
    order.extendedHours === false
  )
}

export const exactOrder = Pipeable.dual(3, exactOrderDataFirst)

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

const decideSubmitFailureDataFirst = (
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
      ? { _tag: 'SubmitDenied' }
      : {
          _tag: 'SubmitUnknown',
          ...(error.brokerOrderId === undefined ? {} : { brokerOrderId: error.brokerOrderId }),
          ...(evidence === undefined ? {} : { evidence }),
        }
}

export const decideSubmitFailure = Pipeable.dual(2, decideSubmitFailureDataFirst)

const decideSubmitSuccessDataFirst = (
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

export const decideSubmitSuccess = Pipeable.dual(3, decideSubmitSuccessDataFirst)

export const cancellationIdentity = (
  submitEvent: MutationEvent | undefined,
): Result.Result<{ readonly brokerOrderId: string; readonly requestHash: string }, ExecutionDecisionFailure> =>
  submitEvent?.brokerOrderId === undefined
    ? Result.fail({ _tag: 'CancellationOrderMissing' })
    : Result.succeed({
        brokerOrderId: submitEvent.brokerOrderId,
        requestHash: cancelRequestHash(submitEvent.brokerOrderId),
      })

export const decideCancelFailure = (error: BrokerMutationError): CancelPersistenceDecision => {
  const evidence = completeEvidence(error.evidence)
  return {
    _tag: 'CancelUnknown',
    ...(evidence === undefined ? {} : { evidence }),
  }
}

const decideCancelSuccessDataFirst = (
  brokerOrderId: string,
  requestHash: string,
  receipt: CancelReceipt,
): CancelPersistenceDecision =>
  receipt.requestHash === requestHash && receipt.brokerOrderId === brokerOrderId
    ? { _tag: 'CancelAccepted', evidence: receipt.evidence }
    : { _tag: 'CancelUnknown', evidence: receipt.evidence }

export const decideCancelSuccess = Pipeable.dual(3, decideCancelSuccessDataFirst)

const submitResolved = (intent: Intent, event: MutationEvent): boolean =>
  intent.state === IntentState.Terminal &&
  (event.eventType === MutationEventType.SubmitAccepted ||
    event.eventType === MutationEventType.SubmitRejected ||
    event.eventType === MutationEventType.SubmitDenied ||
    event.eventType === MutationEventType.RecoveryFound)

const selectRecoveryDataFirst = (
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

export const selectRecovery = Pipeable.dual(3, selectRecoveryDataFirst)

const recoveryRequestHash = (
  intent: Intent,
  event: MutationEvent,
): Result.Result<string | undefined, ExecutionDecisionFailure> =>
  event.operation === MutationOperation.Submit
    ? compatibleOrderRequestBody(intent, event.requestHash).pipe(
        Result.map(() => event.requestHash),
        Result.mapError(
          (cause): ExecutionDecisionFailure => ({
            _tag: 'OrderCanonicalizationFailed',
            operation: event.operation,
            message: 'durable submit request cannot be represented by a compatible Alpaca paper order',
            cause,
          }),
        ),
      )
    : Result.succeed(event.brokerOrderId === undefined ? undefined : cancelRequestHash(event.brokerOrderId))

const validateRecoveryDataFirst = (
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

export const validateRecovery = Pipeable.dual(3, validateRecoveryDataFirst)

const ensureRecoveryDelayDataFirst = (
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

export const ensureRecoveryDelay = Pipeable.dual(3, ensureRecoveryDelayDataFirst)

const decideInterruptedStartDataFirst = (event: MutationEvent, occurredAt: string): InterruptedStartDecision => {
  if (event.eventType === MutationEventType.SubmitStarted) {
    return { _tag: 'MarkSubmitUnknown', event, occurredAt }
  }
  return event.eventType === MutationEventType.CancelStarted && event.brokerOrderId !== undefined
    ? { _tag: 'MarkCancelUnknown', event, brokerOrderId: event.brokerOrderId, occurredAt }
    : { _tag: 'KeepMutation', event }
}

export const decideInterruptedStart = Pipeable.dual(2, decideInterruptedStartDataFirst)

export const decideRecoveryFailure = (error: BrokerReadError): RecoveryPersistenceDecision => {
  const evidence = readErrorEvidence(error)
  return error.kind === BrokerReadErrorKind.NotFound && evidence !== undefined
    ? { _tag: 'RecoveryNotFound', evidence }
    : {
        _tag: 'RecoveryUnknown',
        ...(evidence === undefined ? {} : { evidence }),
      }
}

const decideRecoverySuccessDataFirst = (
  intent: Intent,
  operation: MutationOperation,
  interrupted: MutationEvent,
  result: ReadResult<Order>,
): RecoveryPersistenceDecision => {
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
  const request =
    operation === MutationOperation.Submit
      ? compatibleOrderRequestBody(intent, interrupted.requestHash)
      : orderRequestBody(intent)
  const matchesIntent = Result.isSuccess(request) && exactOrder(intent, request.success, result.value)

  return (!exactBrokerOrderId || !matchesIntent) && !neutralizedMismatchedOrder
    ? { _tag: 'RecoveryUnknown', evidence }
    : {
        _tag: 'RecoveryFound',
        brokerOrderId: result.value.brokerOrderId,
        evidence,
        ...(outcome === undefined ? {} : { terminalOutcome: outcome }),
      }
}

export const decideRecoverySuccess = Pipeable.dual(4, decideRecoverySuccessDataFirst)

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
