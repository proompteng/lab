import { PgClient } from '@effect/sql-pg'
import { Context, Data, Effect, Layer, Result, Schema } from 'effect'

import { canonicalHashV1 } from '../hash'
import { Authority, IntentState, KillState, TerminalOutcome } from '../paper'
import {
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  UtcInstantSchema as UtcInstant,
  strictParseOptions,
} from '../schemas'
import { MutationEvidenceSchema, MutationOperation, type MutationEvidence } from '../broker/alpaca-mutations'
import { WriterFence, WriterFenceError } from './writer-fence'

export enum MutationEventType {
  SubmitStarted = 'SUBMIT_STARTED',
  SubmitAccepted = 'SUBMIT_ACCEPTED',
  SubmitRejected = 'SUBMIT_REJECTED',
  SubmitUnknown = 'SUBMIT_UNKNOWN',
  RecoveryFound = 'RECOVERY_FOUND',
  RecoveryNotFound = 'RECOVERY_NOT_FOUND',
  RecoveryUnknown = 'RECOVERY_UNKNOWN',
  CancelStarted = 'CANCEL_STARTED',
  CancelAccepted = 'CANCEL_ACCEPTED',
  CancelUnknown = 'CANCEL_UNKNOWN',
}

const Sequence = Schema.Int.check(Schema.isGreaterThan(0))
const HttpStatus = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))
const ConsistencyDelay = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 300_000 }))
const BrokerOrderId = NonEmptyString.check(Schema.isMaxLength(256))
const MutationEventSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-mutation-event.v1'),
  eventId: Sha256,
  mutationId: Sha256,
  intentId: Sha256,
  sequence: Sequence,
  operation: Schema.Enum(MutationOperation),
  eventType: Schema.Enum(MutationEventType),
  requestHash: Sha256,
  consistencyDelayMs: ConsistencyDelay,
  brokerOrderId: Schema.optionalKey(NonEmptyString),
  requestId: Schema.optionalKey(NonEmptyString),
  responseStatus: Schema.optionalKey(HttpStatus),
  responseContentHash: Schema.optionalKey(Sha256),
  occurredAt: UtcInstant,
})
export type MutationEvent = typeof MutationEventSchema.Type

const StoredEventRow = Schema.Struct({
  schema_version: Schema.Literal('bayn.paper-mutation-event.v1'),
  event_id: Sha256,
  mutation_id: Sha256,
  intent_id: Sha256,
  sequence: Sequence,
  operation: Schema.Enum(MutationOperation),
  event_type: Schema.Enum(MutationEventType),
  request_hash: Sha256,
  consistency_delay_ms: ConsistencyDelay,
  broker_order_id: Schema.NullOr(NonEmptyString),
  request_id: Schema.NullOr(NonEmptyString),
  response_status: Schema.NullOr(HttpStatus),
  response_content_hash: Schema.NullOr(Sha256),
  occurred_at: UtcInstant,
})
const decodeRowsResult = Schema.decodeUnknownResult(Schema.Array(StoredEventRow), strictParseOptions)
const decodeIntentIdResult = Schema.decodeUnknownResult(Sha256)
const StartInputSchema = Schema.Struct({
  intentId: Sha256,
  requestHash: Sha256,
  consistencyDelayMs: ConsistencyDelay,
  occurredAt: UtcInstant,
  brokerOrderId: Schema.optionalKey(BrokerOrderId),
})
const OutcomeInputSchema = Schema.Struct({
  intentId: Sha256,
  requestHash: Sha256,
  occurredAt: UtcInstant,
  brokerOrderId: Schema.optionalKey(BrokerOrderId),
  evidence: Schema.optionalKey(MutationEvidenceSchema),
})
const decodeStartInputResult = Schema.decodeUnknownResult(StartInputSchema, strictParseOptions)
const decodeOutcomeInputResult = Schema.decodeUnknownResult(OutcomeInputSchema, strictParseOptions)
const hasCompleteEvidence = (evidence: Partial<MutationEvidence>): evidence is MutationEvidence =>
  evidence.requestId !== undefined &&
  evidence.status !== undefined &&
  evidence.contentHash !== undefined &&
  evidence.observedAt !== undefined

type MutationEvidenceDecision =
  | { readonly _tag: 'OmitIncompleteEvidence' }
  | { readonly _tag: 'RetainCompleteEvidence'; readonly evidence: Partial<MutationEvidence> }

const decideMutationEvidence = (evidence: Partial<MutationEvidence> | undefined): MutationEvidenceDecision =>
  evidence !== undefined && hasCompleteEvidence(evidence)
    ? { _tag: 'RetainCompleteEvidence', evidence }
    : { _tag: 'OmitIncompleteEvidence' }

const eventIdentity = (event: Omit<MutationEvent, 'eventId'>) => ({
  schemaVersion: event.schemaVersion,
  mutationId: event.mutationId,
  intentId: event.intentId,
  sequence: event.sequence,
  operation: event.operation,
  eventType: event.eventType,
  requestHash: event.requestHash,
  consistencyDelayMs: event.consistencyDelayMs,
  ...(event.brokerOrderId === undefined ? {} : { brokerOrderId: event.brokerOrderId }),
  ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
  ...(event.responseStatus === undefined ? {} : { responseStatus: event.responseStatus }),
  ...(event.responseContentHash === undefined ? {} : { responseContentHash: event.responseContentHash }),
  occurredAt: event.occurredAt,
})

type MutationCanonicalizationFact =
  | {
      readonly _tag: 'MutationIdentity'
      readonly intentId: string
      readonly operation: MutationOperation
    }
  | {
      readonly _tag: 'MutationEventIdentity'
      readonly intentId: string
      readonly operation: MutationOperation
      readonly sequence: number
      readonly eventType: MutationEventType
    }

interface MutationCanonicalizationFailure {
  readonly _tag: 'MutationCanonicalizationFailure'
  readonly fact: MutationCanonicalizationFact
  readonly cause: unknown
}

const canonicalHashResult = (
  fact: MutationCanonicalizationFact,
  value: unknown,
): Result.Result<string, MutationCanonicalizationFailure> =>
  Result.try({
    try: () => canonicalHashV1(value),
    catch: (cause): MutationCanonicalizationFailure => ({
      _tag: 'MutationCanonicalizationFailure',
      fact,
      cause,
    }),
  })

export const mutationIdResult = (
  intentId: string,
  operation: MutationOperation,
): Result.Result<string, MutationCanonicalizationFailure> =>
  canonicalHashResult(
    { _tag: 'MutationIdentity', intentId, operation },
    { schemaVersion: 'bayn.paper-mutation.v1', intentId, operation },
  )

const mutationEventResult = (
  event: Omit<MutationEvent, 'eventId' | 'schemaVersion'>,
): Result.Result<MutationEvent, MutationCanonicalizationFailure> => {
  const content = { schemaVersion: 'bayn.paper-mutation-event.v1' as const, ...event }
  return Result.map(
    canonicalHashResult(
      {
        _tag: 'MutationEventIdentity',
        intentId: event.intentId,
        operation: event.operation,
        sequence: event.sequence,
        eventType: event.eventType,
      },
      eventIdentity(content),
    ),
    (eventId) => ({ ...content, eventId }),
  )
}

const toEvent = (row: typeof StoredEventRow.Type): MutationEvent => ({
  schemaVersion: row.schema_version,
  eventId: row.event_id,
  mutationId: row.mutation_id,
  intentId: row.intent_id,
  sequence: row.sequence,
  operation: row.operation,
  eventType: row.event_type,
  requestHash: row.request_hash,
  consistencyDelayMs: row.consistency_delay_ms,
  ...(row.broker_order_id === null ? {} : { brokerOrderId: row.broker_order_id }),
  ...(row.request_id === null ? {} : { requestId: row.request_id }),
  ...(row.response_status === null ? {} : { responseStatus: row.response_status }),
  ...(row.response_content_hash === null ? {} : { responseContentHash: row.response_content_hash }),
  occurredAt: row.occurred_at,
})

const AuthorityRows = Schema.Array(
  Schema.Struct({
    effective: Schema.Enum(Authority),
    generation_hash: Sha256,
    generation_account_id: Schema.NullOr(NonEmptyString),
    generation_maximum: Schema.NullOr(Schema.Enum(Authority)),
    kill_state: Schema.Enum(KillState),
    maximum: Schema.Enum(Authority),
  }),
)
const IntentRows = Schema.Array(
  Schema.Struct({
    account_id: NonEmptyString,
    authority_generation_hash: Sha256,
    generation_account_id: Schema.NullOr(NonEmptyString),
    generation_maximum: Schema.NullOr(Schema.Enum(Authority)),
    generation_risk_policy_hash: Schema.NullOr(Sha256),
    generation_strategy_name: Schema.NullOr(NonEmptyString),
    policy_hash: Sha256,
    state: Schema.Enum(IntentState),
    strategy_name: NonEmptyString,
    updated_at: UtcInstant,
  }),
)
const UnresolvedRows = Schema.Array(Schema.Struct({ unresolved: Schema.Boolean }))
const EventIdRows = Schema.Array(Schema.Struct({ event_id: Sha256 }))
const IntentIdRows = Schema.Array(Schema.Struct({ intent_id: Sha256 }))
const OutcomeIntentRows = Schema.Array(
  Schema.Struct({
    state: Schema.Enum(IntentState),
    terminal_outcome: Schema.NullOr(Schema.Enum(TerminalOutcome)),
  }),
)
const AcknowledgedRows = Schema.Array(Schema.Struct({ acknowledged: Schema.Boolean }))

const decodeAuthorityRowsResult = Schema.decodeUnknownResult(AuthorityRows, strictParseOptions)
const decodeIntentRowsResult = Schema.decodeUnknownResult(IntentRows, strictParseOptions)
const decodeUnresolvedRowsResult = Schema.decodeUnknownResult(UnresolvedRows, strictParseOptions)
const decodeEventIdRowsResult = Schema.decodeUnknownResult(EventIdRows, strictParseOptions)
const decodeIntentIdRowsResult = Schema.decodeUnknownResult(IntentIdRows, strictParseOptions)
const decodeOutcomeIntentRowsResult = Schema.decodeUnknownResult(OutcomeIntentRows, strictParseOptions)
const decodeAcknowledgedRowsResult = Schema.decodeUnknownResult(AcknowledgedRows, strictParseOptions)

export class MutationStoreError extends Data.TaggedError('MutationStoreError')<{
  readonly operation: 'begin-submit' | 'record-submit' | 'begin-cancel' | 'record-cancel' | 'record-recovery' | 'read'
  readonly failure: 'authority' | 'conflict' | 'decode' | 'invariant' | 'query'
  readonly message: string
  readonly cause?: unknown
  readonly canonicalizationFailure?: MutationCanonicalizationFailure
}> {}

type StartStoreOperation = Extract<MutationStoreError['operation'], 'begin-submit' | 'begin-cancel'>
type OutcomeStoreOperation = Extract<
  MutationStoreError['operation'],
  'record-submit' | 'record-cancel' | 'record-recovery'
>

export interface StartReceipt {
  readonly event: MutationEvent
  readonly started: boolean
}

export interface MutationStoreShape {
  readonly beginSubmit: (
    intentId: string,
    requestHash: string,
    consistencyDelayMs: number,
    occurredAt: string,
  ) => Effect.Effect<StartReceipt, MutationStoreError | WriterFenceError>
  readonly submitAccepted: (
    intentId: string,
    requestHash: string,
    brokerOrderId: string,
    evidence: MutationEvidence,
    terminalOutcome?: TerminalOutcome,
  ) => Effect.Effect<MutationEvent, MutationStoreError | WriterFenceError>
  readonly submitRejected: (
    intentId: string,
    requestHash: string,
    evidence: MutationEvidence,
  ) => Effect.Effect<MutationEvent, MutationStoreError | WriterFenceError>
  readonly submitUnknown: (
    intentId: string,
    requestHash: string,
    occurredAt: string,
    evidence?: Partial<MutationEvidence>,
    brokerOrderId?: string,
  ) => Effect.Effect<MutationEvent, MutationStoreError | WriterFenceError>
  readonly beginCancel: (
    intentId: string,
    requestHash: string,
    brokerOrderId: string,
    consistencyDelayMs: number,
    occurredAt: string,
  ) => Effect.Effect<StartReceipt, MutationStoreError | WriterFenceError>
  readonly cancelAccepted: (
    intentId: string,
    requestHash: string,
    brokerOrderId: string,
    evidence: MutationEvidence,
  ) => Effect.Effect<MutationEvent, MutationStoreError | WriterFenceError>
  readonly cancelUnknown: (
    intentId: string,
    requestHash: string,
    brokerOrderId: string,
    occurredAt: string,
    evidence?: Partial<MutationEvidence>,
  ) => Effect.Effect<MutationEvent, MutationStoreError | WriterFenceError>
  readonly recoveryFound: (
    intentId: string,
    operation: MutationOperation,
    requestHash: string,
    brokerOrderId: string,
    evidence: MutationEvidence,
    terminalOutcome?: TerminalOutcome,
  ) => Effect.Effect<MutationEvent, MutationStoreError | WriterFenceError>
  readonly recoveryNotFound: (
    intentId: string,
    operation: MutationOperation,
    requestHash: string,
    evidence: MutationEvidence,
  ) => Effect.Effect<MutationEvent, MutationStoreError | WriterFenceError>
  readonly recoveryUnknown: (
    intentId: string,
    operation: MutationOperation,
    requestHash: string,
    occurredAt: string,
    evidence?: Partial<MutationEvidence>,
  ) => Effect.Effect<MutationEvent, MutationStoreError | WriterFenceError>
  readonly latest: (
    intentId: string,
    operation: MutationOperation,
  ) => Effect.Effect<MutationEvent | undefined, MutationStoreError>
}

export class MutationStore extends Context.Service<MutationStore, MutationStoreShape>()('bayn/MutationStore') {}

export type MutationStartInput = typeof StartInputSchema.Type
export type MutationOutcomeInput = typeof OutcomeInputSchema.Type

export interface MutationAuthoritySnapshot {
  readonly maximum: Authority
  readonly effective: Authority
  readonly killState: KillState
  readonly generationHash: string
  readonly generationMaximum: Authority | null
  readonly generationAccountId: string | null
}

export interface MutationAuthorityBinding {
  readonly accountId: string
  readonly generationHash: string
}

export interface MutationIntentSnapshot {
  readonly accountId: string
  readonly authorityGenerationHash: string
  readonly policyHash: string
  readonly state: IntentState
  readonly strategyName: string
  readonly updatedAt: string
  readonly generationAccountId: string | null
  readonly generationMaximum: Authority | null
  readonly generationRiskPolicyHash: string | null
  readonly generationStrategyName: string | null
}

export type MutationStartReplayDecision =
  | { readonly _tag: 'BeginMutation' }
  | { readonly _tag: 'ReplayMutation'; readonly receipt: StartReceipt }

export type MutationStartDecision = {
  readonly event: MutationEvent
  readonly intentTransition: 'KeepIntentState' | 'ApprovedToIoStarted'
}

export type MutationIntentTransition =
  | { readonly _tag: 'KeepIntentState' }
  | {
      readonly _tag: 'TransitionFromIoStarted'
      readonly nextState: IntentState
      readonly terminalOutcome?: TerminalOutcome
    }
  | {
      readonly _tag: 'RecoverSubmit'
      readonly nextState: IntentState.Acknowledged | IntentState.Terminal
      readonly terminalOutcome?: TerminalOutcome
    }
  | {
      readonly _tag: 'RecoverCancelTerminal'
      readonly nextState: IntentState.Terminal
      readonly terminalOutcome: TerminalOutcome
    }

type MutationCancelFirstDecision =
  | { readonly _tag: 'SkipCancelFirstRead' }
  | { readonly _tag: 'RequireNoDurableCancellation' }

export type MutationOutcomeDefinition =
  | { readonly _tag: 'SubmitAccepted'; readonly terminalOutcome?: TerminalOutcome }
  | { readonly _tag: 'SubmitRejected' }
  | { readonly _tag: 'SubmitUnknown' }
  | { readonly _tag: 'CancelAccepted' }
  | { readonly _tag: 'CancelUnknown' }
  | {
      readonly _tag: 'RecoveryFound'
      readonly operation: MutationOperation
      readonly terminalOutcome?: TerminalOutcome
    }
  | { readonly _tag: 'RecoveryNotFound'; readonly operation: MutationOperation }
  | { readonly _tag: 'RecoveryUnknown'; readonly operation: MutationOperation }

interface MutationOutcomeFacts {
  readonly operation: MutationOperation
  readonly eventType: MutationEventType
  readonly transition: MutationIntentTransition
  readonly replayIntent?: MutationReplayIntentExpectation
  readonly cancelFirst: MutationCancelFirstDecision
}

export interface MutationReplayIntentSnapshot {
  readonly state: IntentState
  readonly terminalOutcome: TerminalOutcome | null
}

type MutationReplayIntentExpectation =
  | {
      readonly _tag: 'ExactReplayIntent'
      readonly snapshot: MutationReplayIntentSnapshot
    }
  | { readonly _tag: 'NonTerminalReplayIntent' }

export type MutationOutcomeDecision =
  | { readonly _tag: 'ReplayMutation'; readonly event: MutationEvent }
  | {
      readonly _tag: 'AppendMutation'
      readonly event: MutationEvent
      readonly transition: MutationIntentTransition
      readonly cancelFirst: MutationCancelFirstDecision
    }

type SubmitRecoveryWriteDecision =
  | { readonly _tag: 'TransitionRecoveredIntent' }
  | { readonly _tag: 'TransitionAcknowledgedTerminalIntent' }
  | { readonly _tag: 'VerifyAcknowledgedIntent' }

const intentStateForIdentifiedSubmit = (
  event: MutationEvent | undefined,
  intentId: string,
  expectedMutationId: string,
  brokerOrderId: string,
): IntentState | undefined => {
  if (
    event?.operation !== MutationOperation.Submit ||
    event.intentId !== intentId ||
    event.mutationId !== expectedMutationId ||
    event.brokerOrderId !== brokerOrderId
  ) {
    return undefined
  }
  switch (event.eventType) {
    case MutationEventType.SubmitAccepted:
    case MutationEventType.RecoveryFound:
      return IntentState.Acknowledged
    case MutationEventType.SubmitUnknown:
    case MutationEventType.RecoveryNotFound:
    case MutationEventType.RecoveryUnknown:
      return IntentState.Unknown
    default:
      return undefined
  }
}

const storeError = (
  operation: MutationStoreError['operation'],
  failure: MutationStoreError['failure'],
  message: string,
  cause?: unknown,
) => new MutationStoreError({ operation, failure, message, cause })

const startStoreOperationFor = (operation: MutationOperation): StartStoreOperation =>
  operation === MutationOperation.Submit ? 'begin-submit' : 'begin-cancel'

const canonicalizationStoreError = (
  operation: MutationStoreError['operation'],
  failure: MutationCanonicalizationFailure,
): MutationStoreError =>
  new MutationStoreError({
    operation,
    failure: 'invariant',
    message:
      failure.fact._tag === 'MutationIdentity'
        ? 'mutation identity canonicalization failed'
        : 'mutation event canonicalization failed',
    cause: failure.cause,
    canonicalizationFailure: failure,
  })

const canonicalMutationId = (
  storeOperation: MutationStoreError['operation'],
  intentId: string,
  operation: MutationOperation,
): Result.Result<string, MutationStoreError> =>
  Result.mapError(mutationIdResult(intentId, operation), (failure) =>
    canonicalizationStoreError(storeOperation, failure),
  )

const makeEventResult = (
  storeOperation: MutationStoreError['operation'],
  event: Omit<MutationEvent, 'eventId' | 'schemaVersion'>,
): Result.Result<MutationEvent, MutationStoreError> =>
  Result.mapError(mutationEventResult(event), (failure) => canonicalizationStoreError(storeOperation, failure))

export const decideMutationStartReplay = (
  operation: MutationOperation,
  input: MutationStartInput,
  existing: MutationEvent | undefined,
): Result.Result<MutationStartReplayDecision, MutationStoreError> => {
  if (existing === undefined) return Result.succeed({ _tag: 'BeginMutation' })
  const storeOperation = startStoreOperationFor(operation)
  const expectedMutationId = canonicalMutationId(storeOperation, input.intentId, operation)
  if (Result.isFailure(expectedMutationId)) return Result.fail(expectedMutationId.failure)
  if (
    existing.requestHash !== input.requestHash ||
    existing.consistencyDelayMs !== input.consistencyDelayMs ||
    (operation === MutationOperation.Cancel && existing.brokerOrderId !== input.brokerOrderId) ||
    existing.mutationId !== expectedMutationId.success
  ) {
    return Result.fail(
      storeError(storeOperation, 'conflict', 'mutation identity was reused with different request content'),
    )
  }
  return Result.succeed({
    _tag: 'ReplayMutation',
    receipt: { event: existing, started: false },
  })
}

export const decideMutationAuthority = (
  operation: MutationOperation,
  authority: MutationAuthoritySnapshot | undefined,
): Result.Result<MutationAuthorityBinding, MutationStoreError> => {
  const storeOperation = startStoreOperationFor(operation)
  if (authority === undefined) {
    return Result.fail(storeError(storeOperation, 'authority', 'paper authority is not initialized'))
  }
  if (authority.maximum !== Authority.Paper) {
    return Result.fail(storeError(storeOperation, 'authority', 'GitOps maximum authority is not PAPER'))
  }
  if (
    operation === MutationOperation.Submit &&
    (authority.effective !== Authority.Paper || authority.killState !== KillState.Clear)
  ) {
    return Result.fail(storeError('begin-submit', 'authority', 'effective authority is not PAPER and clear'))
  }
  if (
    operation === MutationOperation.Cancel &&
    authority.killState === KillState.Clear &&
    authority.effective !== Authority.Paper
  ) {
    return Result.fail(
      storeError('begin-cancel', 'authority', 'cancellation requires PAPER authority or an active kill'),
    )
  }
  if (authority.generationMaximum !== Authority.Paper || authority.generationAccountId === null) {
    return Result.fail(
      storeError(storeOperation, 'authority', 'active PAPER authority lacks its immutable account binding'),
    )
  }
  return Result.succeed({
    accountId: authority.generationAccountId,
    generationHash: authority.generationHash,
  })
}

const decideMutationContainment = (unresolved: boolean | undefined): Result.Result<void, MutationStoreError> =>
  unresolved === false
    ? Result.succeed(undefined)
    : Result.fail(storeError('begin-submit', 'invariant', 'another broker mutation has an unresolved outcome'))

export const decideMutationStart = (
  operation: MutationOperation,
  input: MutationStartInput,
  authority: MutationAuthorityBinding,
  intent: MutationIntentSnapshot | undefined,
  submitted: MutationEvent | undefined,
): Result.Result<MutationStartDecision, MutationStoreError> => {
  const storeOperation = startStoreOperationFor(operation)
  if (intent === undefined) {
    return Result.fail(storeError(storeOperation, 'invariant', 'intent does not exist'))
  }
  if (
    intent.generationMaximum !== Authority.Paper ||
    intent.generationAccountId === null ||
    intent.generationAccountId !== intent.accountId ||
    intent.generationRiskPolicyHash !== intent.policyHash ||
    intent.generationStrategyName !== intent.strategyName
  ) {
    return Result.fail(
      storeError(
        storeOperation,
        'authority',
        'intent does not match its immutable PAPER authority-generation bindings',
      ),
    )
  }
  if (intent.accountId !== authority.accountId) {
    return Result.fail(
      storeError(storeOperation, 'authority', 'intent account does not match the active PAPER authority generation'),
    )
  }
  if (operation === MutationOperation.Submit && intent.authorityGenerationHash !== authority.generationHash) {
    return Result.fail(
      storeError('begin-submit', 'authority', 'intent authority generation is not the active PAPER generation'),
    )
  }

  const expectedMutationId = canonicalMutationId(storeOperation, input.intentId, operation)
  if (Result.isFailure(expectedMutationId)) return Result.fail(expectedMutationId.failure)
  const expectedSubmittedMutationId =
    operation === MutationOperation.Cancel
      ? canonicalMutationId(storeOperation, input.intentId, MutationOperation.Submit)
      : undefined
  if (expectedSubmittedMutationId !== undefined && Result.isFailure(expectedSubmittedMutationId)) {
    return Result.fail(expectedSubmittedMutationId.failure)
  }
  const requiredState =
    operation === MutationOperation.Submit
      ? IntentState.Approved
      : input.brokerOrderId === undefined || expectedSubmittedMutationId === undefined
        ? undefined
        : intentStateForIdentifiedSubmit(
            submitted,
            input.intentId,
            expectedSubmittedMutationId.success,
            input.brokerOrderId,
          )
  if (requiredState === undefined) {
    return Result.fail(
      storeError('begin-cancel', 'invariant', 'cancel requires the exact durable submitted order identity'),
    )
  }
  if (intent.state !== requiredState) {
    return Result.fail(
      storeError(storeOperation, 'invariant', `${operation.toLowerCase()} requires an ${requiredState} intent`),
    )
  }
  if (input.occurredAt <= intent.updatedAt) {
    return Result.fail(storeError(storeOperation, 'invariant', 'mutation time must follow the intent state'))
  }

  return Result.map(
    makeEventResult(storeOperation, {
      mutationId: expectedMutationId.success,
      intentId: input.intentId,
      sequence: 1,
      operation,
      eventType:
        operation === MutationOperation.Submit ? MutationEventType.SubmitStarted : MutationEventType.CancelStarted,
      requestHash: input.requestHash,
      consistencyDelayMs: input.consistencyDelayMs,
      ...(input.brokerOrderId === undefined ? {} : { brokerOrderId: input.brokerOrderId }),
      occurredAt: input.occurredAt,
    }),
    (event): MutationStartDecision => ({
      event,
      intentTransition: operation === MutationOperation.Submit ? 'ApprovedToIoStarted' : 'KeepIntentState',
    }),
  )
}

const decideMutationOutcomeDefinition = (definition: MutationOutcomeDefinition): MutationOutcomeFacts => {
  switch (definition._tag) {
    case 'SubmitAccepted':
      return {
        operation: MutationOperation.Submit,
        eventType: MutationEventType.SubmitAccepted,
        transition: {
          _tag: 'TransitionFromIoStarted',
          nextState: definition.terminalOutcome === undefined ? IntentState.Acknowledged : IntentState.Terminal,
          ...(definition.terminalOutcome === undefined ? {} : { terminalOutcome: definition.terminalOutcome }),
        },
        replayIntent: {
          _tag: 'ExactReplayIntent',
          snapshot: {
            state: definition.terminalOutcome === undefined ? IntentState.Acknowledged : IntentState.Terminal,
            terminalOutcome: definition.terminalOutcome ?? null,
          },
        },
        cancelFirst: { _tag: 'SkipCancelFirstRead' },
      }
    case 'SubmitRejected':
      return {
        operation: MutationOperation.Submit,
        eventType: MutationEventType.SubmitRejected,
        transition: {
          _tag: 'TransitionFromIoStarted',
          nextState: IntentState.Terminal,
          terminalOutcome: TerminalOutcome.Rejected,
        },
        replayIntent: {
          _tag: 'ExactReplayIntent',
          snapshot: {
            state: IntentState.Terminal,
            terminalOutcome: TerminalOutcome.Rejected,
          },
        },
        cancelFirst: { _tag: 'SkipCancelFirstRead' },
      }
    case 'SubmitUnknown':
      return {
        operation: MutationOperation.Submit,
        eventType: MutationEventType.SubmitUnknown,
        transition: { _tag: 'TransitionFromIoStarted', nextState: IntentState.Unknown },
        replayIntent: {
          _tag: 'ExactReplayIntent',
          snapshot: {
            state: IntentState.Unknown,
            terminalOutcome: null,
          },
        },
        cancelFirst: { _tag: 'SkipCancelFirstRead' },
      }
    case 'CancelAccepted':
      return {
        operation: MutationOperation.Cancel,
        eventType: MutationEventType.CancelAccepted,
        transition: { _tag: 'KeepIntentState' },
        cancelFirst: { _tag: 'SkipCancelFirstRead' },
      }
    case 'CancelUnknown':
      return {
        operation: MutationOperation.Cancel,
        eventType: MutationEventType.CancelUnknown,
        transition: { _tag: 'KeepIntentState' },
        cancelFirst: { _tag: 'SkipCancelFirstRead' },
      }
    case 'RecoveryFound':
      return {
        operation: definition.operation,
        eventType: MutationEventType.RecoveryFound,
        transition:
          definition.operation === MutationOperation.Submit
            ? {
                _tag: 'RecoverSubmit',
                nextState: definition.terminalOutcome === undefined ? IntentState.Acknowledged : IntentState.Terminal,
                ...(definition.terminalOutcome === undefined ? {} : { terminalOutcome: definition.terminalOutcome }),
              }
            : definition.terminalOutcome === undefined
              ? { _tag: 'KeepIntentState' }
              : {
                  _tag: 'RecoverCancelTerminal',
                  nextState: IntentState.Terminal,
                  terminalOutcome: definition.terminalOutcome,
                },
        ...(definition.operation === MutationOperation.Submit
          ? {
              replayIntent: {
                _tag: 'ExactReplayIntent',
                snapshot: {
                  state: definition.terminalOutcome === undefined ? IntentState.Acknowledged : IntentState.Terminal,
                  terminalOutcome: definition.terminalOutcome ?? null,
                },
              },
            }
          : definition.terminalOutcome === undefined
            ? { replayIntent: { _tag: 'NonTerminalReplayIntent' } }
            : {
                replayIntent: {
                  _tag: 'ExactReplayIntent',
                  snapshot: {
                    state: IntentState.Terminal,
                    terminalOutcome: definition.terminalOutcome,
                  },
                },
              }),
        cancelFirst:
          definition.operation === MutationOperation.Submit && definition.terminalOutcome !== undefined
            ? { _tag: 'RequireNoDurableCancellation' }
            : { _tag: 'SkipCancelFirstRead' },
      }
    case 'RecoveryNotFound':
      return {
        operation: definition.operation,
        eventType: MutationEventType.RecoveryNotFound,
        transition: { _tag: 'KeepIntentState' },
        cancelFirst: { _tag: 'SkipCancelFirstRead' },
      }
    case 'RecoveryUnknown':
      return {
        operation: definition.operation,
        eventType: MutationEventType.RecoveryUnknown,
        transition: { _tag: 'KeepIntentState' },
        cancelFirst: { _tag: 'SkipCancelFirstRead' },
      }
  }
}

const outcomeStoreOperation = (definition: MutationOutcomeDefinition): OutcomeStoreOperation => {
  switch (definition._tag) {
    case 'SubmitAccepted':
    case 'SubmitRejected':
    case 'SubmitUnknown':
      return 'record-submit'
    case 'CancelAccepted':
    case 'CancelUnknown':
      return 'record-cancel'
    case 'RecoveryFound':
    case 'RecoveryNotFound':
    case 'RecoveryUnknown':
      return 'record-recovery'
  }
}

const isRecoveryEventType = (eventType: MutationEventType): boolean =>
  eventType === MutationEventType.RecoveryFound ||
  eventType === MutationEventType.RecoveryNotFound ||
  eventType === MutationEventType.RecoveryUnknown

const allowsOutcomeEvent = (previous: MutationEventType, next: MutationEventType): boolean => {
  switch (previous) {
    case MutationEventType.SubmitStarted:
      return (
        next === MutationEventType.SubmitAccepted ||
        next === MutationEventType.SubmitRejected ||
        next === MutationEventType.SubmitUnknown
      )
    case MutationEventType.CancelStarted:
      return next === MutationEventType.CancelAccepted || next === MutationEventType.CancelUnknown
    case MutationEventType.SubmitAccepted:
    case MutationEventType.SubmitUnknown:
    case MutationEventType.CancelAccepted:
    case MutationEventType.CancelUnknown:
    case MutationEventType.RecoveryFound:
    case MutationEventType.RecoveryNotFound:
    case MutationEventType.RecoveryUnknown:
      return isRecoveryEventType(next)
    case MutationEventType.SubmitRejected:
      return false
  }
}

const sameOutcome = (previous: MutationEvent, event: MutationEvent): boolean =>
  previous.eventType === event.eventType &&
  previous.requestId === event.requestId &&
  previous.responseStatus === event.responseStatus &&
  previous.responseContentHash === event.responseContentHash &&
  previous.brokerOrderId === event.brokerOrderId

const matchesReplayIntent = (
  expected: MutationReplayIntentExpectation,
  current: MutationReplayIntentSnapshot | undefined,
): boolean => {
  if (current === undefined) return false
  switch (expected._tag) {
    case 'ExactReplayIntent':
      return current.state === expected.snapshot.state && current.terminalOutcome === expected.snapshot.terminalOutcome
    case 'NonTerminalReplayIntent':
      return current.state !== IntentState.Terminal && current.terminalOutcome === null
  }
}

const decideMutationEventContract = (
  storeOperation: OutcomeStoreOperation,
  event: MutationEvent,
): Result.Result<void, MutationStoreError> => {
  const valid = (() => {
    switch (event.eventType) {
      case MutationEventType.SubmitAccepted:
        return (
          event.operation === MutationOperation.Submit &&
          event.brokerOrderId !== undefined &&
          event.responseStatus === 200
        )
      case MutationEventType.SubmitRejected:
        return (
          event.operation === MutationOperation.Submit &&
          event.brokerOrderId === undefined &&
          (event.responseStatus === 400 ||
            event.responseStatus === 401 ||
            event.responseStatus === 403 ||
            event.responseStatus === 404 ||
            event.responseStatus === 422)
        )
      case MutationEventType.SubmitUnknown:
        return event.operation === MutationOperation.Submit
      case MutationEventType.RecoveryFound:
        return event.brokerOrderId !== undefined && event.responseStatus === 200
      case MutationEventType.RecoveryNotFound:
        return (
          event.responseStatus === 404 &&
          (event.operation === MutationOperation.Submit || event.brokerOrderId !== undefined)
        )
      case MutationEventType.RecoveryUnknown:
        return true
      case MutationEventType.CancelAccepted:
        return (
          event.operation === MutationOperation.Cancel &&
          event.brokerOrderId !== undefined &&
          event.responseStatus === 204
        )
      case MutationEventType.CancelUnknown:
        return event.operation === MutationOperation.Cancel && event.brokerOrderId !== undefined
      case MutationEventType.SubmitStarted:
      case MutationEventType.CancelStarted:
        return false
    }
  })()
  return valid
    ? Result.succeed(undefined)
    : Result.fail(
        storeError(storeOperation, 'invariant', 'mutation event does not match its operation and evidence contract'),
      )
}

export const decideMutationOutcome = (
  input: MutationOutcomeInput,
  definition: MutationOutcomeDefinition,
  previous: MutationEvent | undefined,
  currentIntent: MutationReplayIntentSnapshot | undefined,
): Result.Result<MutationOutcomeDecision, MutationStoreError> => {
  const storeOperation = outcomeStoreOperation(definition)
  const facts = decideMutationOutcomeDefinition(definition)
  if (previous === undefined) {
    return Result.fail(storeError(storeOperation, 'invariant', 'mutation STARTED event does not exist'))
  }
  const expectedMutationId = canonicalMutationId(storeOperation, input.intentId, facts.operation)
  if (Result.isFailure(expectedMutationId)) return Result.fail(expectedMutationId.failure)
  if (
    previous.intentId !== input.intentId ||
    previous.operation !== facts.operation ||
    previous.mutationId !== expectedMutationId.success
  ) {
    return Result.fail(storeError(storeOperation, 'conflict', 'mutation identity and sequence must remain exact'))
  }
  if (previous.requestHash !== input.requestHash) {
    return Result.fail(storeError(storeOperation, 'conflict', 'mutation request hash changed'))
  }
  if (
    previous.brokerOrderId !== undefined &&
    input.brokerOrderId !== undefined &&
    previous.brokerOrderId !== input.brokerOrderId
  ) {
    return Result.fail(storeError(storeOperation, 'conflict', 'mutation broker order identity cannot change'))
  }

  const brokerOrderId = previous.brokerOrderId ?? input.brokerOrderId
  const eventResult = makeEventResult(storeOperation, {
    mutationId: previous.mutationId,
    intentId: input.intentId,
    sequence: previous.sequence + 1,
    operation: facts.operation,
    eventType: facts.eventType,
    requestHash: input.requestHash,
    consistencyDelayMs: previous.consistencyDelayMs,
    ...(brokerOrderId === undefined ? {} : { brokerOrderId }),
    ...(input.evidence?.requestId === undefined ? {} : { requestId: input.evidence.requestId }),
    ...(input.evidence?.status === undefined ? {} : { responseStatus: input.evidence.status }),
    ...(input.evidence?.contentHash === undefined ? {} : { responseContentHash: input.evidence.contentHash }),
    occurredAt: input.occurredAt,
  })
  if (Result.isFailure(eventResult)) return Result.fail(eventResult.failure)
  const event = eventResult.success
  if (sameOutcome(previous, event)) {
    if (facts.replayIntent !== undefined && !matchesReplayIntent(facts.replayIntent, currentIntent)) {
      return Result.fail(
        storeError(storeOperation, 'conflict', 'mutation outcome replay conflicts with durable intent state'),
      )
    }
    return Result.succeed({ _tag: 'ReplayMutation', event: previous })
  }
  if (input.occurredAt < previous.occurredAt) {
    return Result.fail(storeError(storeOperation, 'conflict', 'mutation identity and sequence must remain exact'))
  }
  if (!allowsOutcomeEvent(previous.eventType, facts.eventType)) {
    return Result.fail(
      storeError(
        storeOperation,
        'conflict',
        `invalid mutation transition from ${previous.eventType} to ${facts.eventType}`,
      ),
    )
  }
  const eventContract = decideMutationEventContract(storeOperation, event)
  if (Result.isFailure(eventContract)) return Result.fail(eventContract.failure)
  return Result.succeed({
    _tag: 'AppendMutation',
    event,
    transition: facts.transition,
    cancelFirst: facts.cancelFirst,
  })
}

const decideCancelFirst = (
  decision: MutationCancelFirstDecision,
  cancellation: MutationEvent | undefined,
): Result.Result<void, MutationStoreError> =>
  decision._tag === 'RequireNoDurableCancellation' && cancellation !== undefined
    ? Result.fail(
        storeError('record-recovery', 'conflict', 'terminal submit recovery cannot overtake a durable cancellation'),
      )
    : Result.succeed(undefined)

const decideMutationAppend = (
  storeOperation: MutationStoreError['operation'],
  event: MutationEvent,
  appendedEventIds: readonly string[],
  requireCurrentRisk: boolean,
): Result.Result<MutationEvent, MutationStoreError> =>
  appendedEventIds.length === 1
    ? Result.succeed(event)
    : Result.fail(
        storeError(
          storeOperation,
          requireCurrentRisk ? 'invariant' : 'conflict',
          requireCurrentRisk
            ? 'mutation start requires a current approved risk decision'
            : 'mutation event append lost its race',
        ),
      )

const decideSubmitStartWrite = (transitionedIntentIds: readonly string[]): Result.Result<void, MutationStoreError> =>
  transitionedIntentIds.length === 1
    ? Result.succeed(undefined)
    : Result.fail(storeError('begin-submit', 'conflict', 'approved intent transition lost its race'))

const decideMutationOutcomeWrite = (
  storeOperation: OutcomeStoreOperation,
  transitionedIntentIds: readonly string[],
): Result.Result<void, MutationStoreError> =>
  transitionedIntentIds.length === 1
    ? Result.succeed(undefined)
    : Result.fail(storeError(storeOperation, 'conflict', 'intent mutation outcome lost its race'))

const decideSubmitRecoveryWrite = (
  storeOperation: OutcomeStoreOperation,
  recoveredIntentIds: readonly string[],
  transition: Extract<MutationIntentTransition, { readonly _tag: 'RecoverSubmit' }>,
): Result.Result<SubmitRecoveryWriteDecision, MutationStoreError> => {
  if (recoveredIntentIds.length === 1) return Result.succeed({ _tag: 'TransitionRecoveredIntent' })
  if (recoveredIntentIds.length === 0 && transition.nextState === IntentState.Terminal) {
    return Result.succeed({ _tag: 'TransitionAcknowledgedTerminalIntent' })
  }
  if (recoveredIntentIds.length === 0 && transition.nextState === IntentState.Acknowledged) {
    return Result.succeed({ _tag: 'VerifyAcknowledgedIntent' })
  }
  return Result.fail(storeError(storeOperation, 'conflict', 'unknown intent recovery lost its race'))
}

const decideAcknowledgedRecovery = (
  storeOperation: OutcomeStoreOperation,
  acknowledged: boolean | undefined,
): Result.Result<void, MutationStoreError> =>
  acknowledged === true
    ? Result.succeed(undefined)
    : Result.fail(storeError(storeOperation, 'conflict', 'submit recovery requires an unresolved durable intent'))

const decideRecoveredOutcomeWrite = (
  storeOperation: OutcomeStoreOperation,
  transitionedIntentIds: readonly string[],
  acknowledgedTerminal: boolean,
): Result.Result<void, MutationStoreError> =>
  transitionedIntentIds.length === 1
    ? Result.succeed(undefined)
    : Result.fail(
        storeError(
          storeOperation,
          'conflict',
          acknowledgedTerminal
            ? 'acknowledged intent terminal recovery lost its race'
            : 'recovered intent outcome lost its race',
        ),
      )

const decideCancelRecoveryState = (
  storeOperation: OutcomeStoreOperation,
  recoveredIntentIds: readonly string[],
): Result.Result<IntentState.Acknowledged | IntentState.Recovered, MutationStoreError> => {
  if (recoveredIntentIds.length === 0) return Result.succeed(IntentState.Acknowledged)
  if (recoveredIntentIds.length === 1) return Result.succeed(IntentState.Recovered)
  return Result.fail(storeError(storeOperation, 'conflict', 'intent mutation outcome lost its race'))
}

const selectLatest = (sql: PgClient.PgClient, intentId: string, operation: MutationOperation) => sql`
  SELECT
    schema_version,
    event_id,
    mutation_id,
    intent_id,
    sequence::integer,
    operation,
    event_type,
    request_hash,
    consistency_delay_ms,
    broker_order_id,
    request_id,
    response_status::integer,
    response_content_hash,
    to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at
  FROM mutation_events
  WHERE intent_id = ${intentId} AND operation = ${operation}
  ORDER BY sequence DESC
  LIMIT 1
`

const decodeStartInput = (
  operation: MutationOperation,
  input: unknown,
): Result.Result<MutationStartInput, MutationStoreError> =>
  Result.mapError(decodeStartInputResult(input), (cause) =>
    storeError(startStoreOperationFor(operation), 'decode', 'invalid mutation start', cause),
  )

const decodeOutcomeInput = (
  storeOperation: OutcomeStoreOperation,
  input: {
    readonly intentId: string
    readonly requestHash: string
    readonly occurredAt: string
    readonly brokerOrderId?: string
    readonly evidence?: Partial<MutationEvidence>
  },
): Result.Result<MutationOutcomeInput, MutationStoreError> => {
  const evidence = decideMutationEvidence(input.evidence)
  return Result.mapError(
    decodeOutcomeInputResult({
      intentId: input.intentId,
      requestHash: input.requestHash,
      occurredAt: input.occurredAt,
      ...(input.brokerOrderId === undefined ? {} : { brokerOrderId: input.brokerOrderId }),
      ...(evidence._tag === 'RetainCompleteEvidence' ? { evidence: evidence.evidence } : {}),
    }),
    (cause) => storeError(storeOperation, 'decode', 'invalid mutation outcome', cause),
  )
}

const decodeStoredEvents = (rows: unknown): Result.Result<readonly MutationEvent[], MutationStoreError> =>
  Result.map(
    Result.mapError(decodeRowsResult(rows), (cause) =>
      storeError('read', 'decode', 'stored mutation event failed decoding', cause),
    ),
    (decoded) => decoded.map(toEvent),
  )

const decodeAuthoritySnapshot = (
  operation: MutationOperation,
  rows: unknown,
): Result.Result<MutationAuthoritySnapshot | undefined, MutationStoreError> =>
  Result.map(
    Result.mapError(decodeAuthorityRowsResult(rows), (cause) =>
      storeError(startStoreOperationFor(operation), 'decode', 'stored mutation authority failed decoding', cause),
    ),
    (decoded) => {
      const authority = decoded[0]
      return authority === undefined
        ? undefined
        : {
            maximum: authority.maximum,
            effective: authority.effective,
            killState: authority.kill_state,
            generationHash: authority.generation_hash,
            generationMaximum: authority.generation_maximum,
            generationAccountId: authority.generation_account_id,
          }
    },
  )

const decodeIntentSnapshot = (
  operation: MutationOperation,
  rows: unknown,
): Result.Result<MutationIntentSnapshot | undefined, MutationStoreError> =>
  Result.map(
    Result.mapError(decodeIntentRowsResult(rows), (cause) =>
      storeError(startStoreOperationFor(operation), 'decode', 'stored mutation intent failed decoding', cause),
    ),
    (decoded) => {
      const intent = decoded[0]
      return intent === undefined
        ? undefined
        : {
            accountId: intent.account_id,
            authorityGenerationHash: intent.authority_generation_hash,
            policyHash: intent.policy_hash,
            state: intent.state,
            strategyName: intent.strategy_name,
            updatedAt: intent.updated_at,
            generationAccountId: intent.generation_account_id,
            generationMaximum: intent.generation_maximum,
            generationRiskPolicyHash: intent.generation_risk_policy_hash,
            generationStrategyName: intent.generation_strategy_name,
          }
    },
  )

const fromDecision = <A, E>(evaluate: () => Result.Result<A, E>): Effect.Effect<A, E> =>
  Effect.suspend(() => Effect.fromResult(evaluate()))

const makeStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const fence = yield* WriterFence

  const run = <A, E, R>(
    operation: MutationStoreError['operation'],
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, MutationStoreError | WriterFenceError, R> =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause instanceof MutationStoreError || cause instanceof WriterFenceError
          ? cause
          : storeError(operation, 'query', `mutation ${operation} failed`, cause),
      ),
    )

  const readLatest = (intentId: string, operation: MutationOperation) =>
    selectLatest(sql, intentId, operation).pipe(
      Effect.flatMap((rows) => fromDecision(() => Result.map(decodeStoredEvents(rows), (events) => events[0]))),
    )

  const latest = (intentId: string, operation: MutationOperation) =>
    fromDecision(() =>
      Result.mapError(decodeIntentIdResult(intentId), (cause) =>
        storeError('read', 'decode', 'invalid intent ID', cause),
      ),
    ).pipe(
      Effect.flatMap((decodedIntentId) => readLatest(decodedIntentId, operation)),
      Effect.mapError((cause) =>
        cause instanceof MutationStoreError ? cause : storeError('read', 'query', 'mutation read failed', cause),
      ),
    )

  const appendEvent = (
    storeOperation: MutationStoreError['operation'],
    event: MutationEvent,
    requireCurrentRisk = false,
  ) =>
    sql<{ event_id: string }>`
      INSERT INTO mutation_events (
        event_id,
        schema_version,
        mutation_id,
        intent_id,
        sequence,
        operation,
        event_type,
        request_hash,
        consistency_delay_ms,
        broker_order_id,
        request_id,
        response_status,
        response_content_hash,
        occurred_at
      )
      SELECT
        ${event.eventId},
        ${event.schemaVersion},
        ${event.mutationId},
        ${event.intentId},
        ${event.sequence},
        ${event.operation},
        ${event.eventType},
        ${event.requestHash},
        ${event.consistencyDelayMs},
        ${event.brokerOrderId ?? null},
        ${event.requestId ?? null},
        ${event.responseStatus ?? null},
        ${event.responseContentHash ?? null},
        ${event.occurredAt}
      WHERE ${!requireCurrentRisk}
        OR EXISTS (
          SELECT 1
          FROM intents AS intent
          JOIN risk_decisions AS decision
            ON decision.decision_id = intent.risk_decision_id
            AND decision.intent_id = intent.intent_id
          WHERE intent.intent_id = ${event.intentId}
            AND decision.outcome = 'APPROVED'
            AND decision.decided_at <= clock_timestamp()
            AND decision.expires_at > clock_timestamp()
        )
      RETURNING event_id
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() =>
          Result.flatMap(
            Result.mapError(decodeEventIdRowsResult(rows), (cause) =>
              storeError(storeOperation, 'decode', 'mutation event append result failed decoding', cause),
            ),
            (decoded) =>
              decideMutationAppend(
                storeOperation,
                event,
                decoded.map((row) => row.event_id),
                requireCurrentRisk,
              ),
          ),
        ),
      ),
    )

  const readAuthorityBinding = (operation: MutationOperation) =>
    sql<{
      effective: string
      generation_hash: string
      generation_account_id: string | null
      generation_maximum: string | null
      kill_state: string
      maximum: string
    }>`
      SELECT
        authority.maximum,
        authority.effective,
        authority.kill_state,
        authority.generation_hash,
        generation.maximum AS generation_maximum,
        generation.account_id AS generation_account_id
      FROM authority_state AS authority
      LEFT JOIN authority_generations AS generation
        ON generation.generation_hash = authority.generation_hash
      WHERE authority.singleton
      FOR UPDATE OF authority
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() =>
          Result.flatMap(decodeAuthoritySnapshot(operation, rows), (authority) =>
            decideMutationAuthority(operation, authority),
          ),
        ),
      ),
    )

  const requireNoOtherUnresolved = (intentId: string) =>
    sql<{ unresolved: boolean }>`
      SELECT EXISTS (
        SELECT 1
        FROM (
          SELECT DISTINCT ON (events.mutation_id)
            events.intent_id,
            events.operation,
            events.event_type,
            intents.state
          FROM mutation_events AS events
          JOIN intents ON intents.intent_id = events.intent_id
          ORDER BY events.mutation_id, events.sequence DESC
        ) AS latest
        WHERE latest.intent_id <> ${intentId}
          AND latest.state <> 'TERMINAL'
          AND (
            latest.event_type IN (
              'SUBMIT_STARTED',
              'SUBMIT_UNKNOWN',
              'RECOVERY_NOT_FOUND',
              'RECOVERY_UNKNOWN',
              'CANCEL_STARTED',
              'CANCEL_ACCEPTED',
              'CANCEL_UNKNOWN'
            )
            OR (
              latest.operation = 'CANCEL'
              AND latest.event_type = 'RECOVERY_FOUND'
            )
          )
      ) AS unresolved
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() =>
          Result.flatMap(
            Result.mapError(decodeUnresolvedRowsResult(rows), (cause) =>
              storeError('begin-submit', 'decode', 'unresolved mutation result failed decoding', cause),
            ),
            (decoded) => decideMutationContainment(decoded[0]?.unresolved),
          ),
        ),
      ),
    )

  const readIntent = (operation: MutationOperation, intentId: string) =>
    sql<{
      account_id: string
      authority_generation_hash: string
      generation_account_id: string | null
      generation_maximum: string | null
      generation_risk_policy_hash: string | null
      generation_strategy_name: string | null
      policy_hash: string
      state: string
      strategy_name: string
      updated_at: string
    }>`
      SELECT
        intent.account_id,
        intent.authority_generation_hash,
        intent.policy_hash,
        intent.state,
        intent.strategy_name,
        generation.account_id AS generation_account_id,
        generation.maximum AS generation_maximum,
        generation.risk_policy_hash AS generation_risk_policy_hash,
        generation.strategy_name AS generation_strategy_name,
        to_char(intent.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
      FROM intents AS intent
      LEFT JOIN authority_generations AS generation
        ON generation.generation_hash = intent.authority_generation_hash
      WHERE intent.intent_id = ${intentId}
      FOR UPDATE OF intent
    `.pipe(Effect.flatMap((rows) => fromDecision(() => decodeIntentSnapshot(operation, rows))))

  const transitionSubmitStart = (input: MutationStartInput) =>
    sql<{ intent_id: string }>`
      UPDATE intents
      SET state = ${IntentState.IoStarted}, state_version = state_version + 1, updated_at = ${input.occurredAt}
      WHERE intent_id = ${input.intentId} AND state = ${IntentState.Approved}
      RETURNING intent_id
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() =>
          Result.flatMap(
            Result.mapError(decodeIntentIdRowsResult(rows), (cause) =>
              storeError('begin-submit', 'decode', 'submit transition result failed decoding', cause),
            ),
            (decoded) => decideSubmitStartWrite(decoded.map((row) => row.intent_id)),
          ),
        ),
      ),
    )

  const beginTransaction = (operation: MutationOperation, input: MutationStartInput) =>
    Effect.gen(function* () {
      const existing = yield* readLatest(input.intentId, operation)
      const replay = yield* fromDecision(() => decideMutationStartReplay(operation, input, existing))
      if (replay._tag === 'ReplayMutation') return replay.receipt

      const authority = yield* readAuthorityBinding(operation)
      if (operation === MutationOperation.Submit) yield* requireNoOtherUnresolved(input.intentId)
      const intent = yield* readIntent(operation, input.intentId)
      const submitted =
        operation === MutationOperation.Cancel ? yield* readLatest(input.intentId, MutationOperation.Submit) : undefined
      const decision = yield* fromDecision(() => decideMutationStart(operation, input, authority, intent, submitted))
      yield* appendEvent(startStoreOperationFor(operation), decision.event, operation === MutationOperation.Submit)
      if (decision.intentTransition === 'ApprovedToIoStarted') yield* transitionSubmitStart(input)
      return { event: decision.event, started: true } satisfies StartReceipt
    })

  const begin = (
    operation: MutationOperation,
    intentId: string,
    requestHash: string,
    consistencyDelayMs: number,
    occurredAt: string,
    brokerOrderId?: string,
  ) =>
    run(
      startStoreOperationFor(operation),
      fromDecision(() =>
        decodeStartInput(operation, {
          intentId,
          requestHash,
          consistencyDelayMs,
          occurredAt,
          ...(brokerOrderId === undefined ? {} : { brokerOrderId }),
        }),
      ).pipe(Effect.flatMap((input) => fence.transaction(beginTransaction(operation, input)))),
    )

  const decodeIntentWriteRows = (
    storeOperation: OutcomeStoreOperation,
    message: string,
    rows: unknown,
  ): Result.Result<readonly string[], MutationStoreError> =>
    Result.map(
      Result.mapError(decodeIntentIdRowsResult(rows), (cause) => storeError(storeOperation, 'decode', message, cause)),
      (decoded) => decoded.map((row) => row.intent_id),
    )

  const readOutcomeIntentSnapshot = (storeOperation: OutcomeStoreOperation, intentId: string) =>
    sql<{ state: string; terminal_outcome: string | null }>`
      SELECT state, terminal_outcome
      FROM intents
      WHERE intent_id = ${intentId}
      FOR UPDATE
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() =>
          Result.map(
            Result.mapError(decodeOutcomeIntentRowsResult(rows), (cause) =>
              storeError(storeOperation, 'decode', 'stored mutation intent state failed decoding', cause),
            ),
            (decoded): MutationReplayIntentSnapshot | undefined => {
              const intent = decoded[0]
              return intent === undefined
                ? undefined
                : {
                    state: intent.state,
                    terminalOutcome: intent.terminal_outcome,
                  }
            },
          ),
        ),
      ),
    )

  const transitionFromIoStarted = (
    storeOperation: OutcomeStoreOperation,
    input: MutationOutcomeInput,
    transition: Extract<MutationIntentTransition, { readonly _tag: 'TransitionFromIoStarted' }>,
  ) =>
    sql<{ intent_id: string }>`
      UPDATE intents
      SET
        state = ${transition.nextState},
        terminal_outcome = ${transition.terminalOutcome ?? null},
        state_version = state_version + 1,
        updated_at = GREATEST(${input.occurredAt}::timestamptz, updated_at + interval '1 microsecond')
      WHERE intent_id = ${input.intentId} AND state = ${IntentState.IoStarted}
      RETURNING intent_id
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() =>
          Result.flatMap(
            decodeIntentWriteRows(storeOperation, 'mutation outcome transition result failed decoding', rows),
            (decoded) => decideMutationOutcomeWrite(storeOperation, decoded),
          ),
        ),
      ),
    )

  const recoverUnknownSubmit = (storeOperation: OutcomeStoreOperation, input: MutationOutcomeInput) =>
    sql<{ intent_id: string }>`
      UPDATE intents
      SET state = ${IntentState.Recovered}, state_version = state_version + 1, updated_at = ${input.occurredAt}
      WHERE intent_id = ${input.intentId} AND state = ${IntentState.Unknown}
      RETURNING intent_id
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() => decodeIntentWriteRows(storeOperation, 'submit recovery result failed decoding', rows)),
      ),
    )

  const transitionRecoveredSubmit = (
    storeOperation: OutcomeStoreOperation,
    input: MutationOutcomeInput,
    transition: Extract<MutationIntentTransition, { readonly _tag: 'RecoverSubmit' }>,
  ) =>
    sql<{ intent_id: string }>`
      UPDATE intents
      SET
        state = ${transition.nextState},
        terminal_outcome = ${transition.terminalOutcome ?? null},
        state_version = state_version + 1,
        updated_at = GREATEST(
          ${input.occurredAt}::timestamptz + interval '1 microsecond',
          updated_at + interval '1 microsecond'
      )
      WHERE intent_id = ${input.intentId} AND state = ${IntentState.Recovered}
      RETURNING intent_id
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() =>
          Result.flatMap(
            decodeIntentWriteRows(storeOperation, 'recovered submit transition result failed decoding', rows),
            (decoded) => decideRecoveredOutcomeWrite(storeOperation, decoded, false),
          ),
        ),
      ),
    )

  const transitionAcknowledgedSubmit = (
    storeOperation: OutcomeStoreOperation,
    input: MutationOutcomeInput,
    transition: Extract<MutationIntentTransition, { readonly _tag: 'RecoverSubmit' }>,
  ) =>
    sql<{ intent_id: string }>`
      UPDATE intents
      SET
        state = ${IntentState.Terminal},
        terminal_outcome = ${transition.terminalOutcome ?? null},
        state_version = state_version + 1,
        updated_at = GREATEST(
          ${input.occurredAt}::timestamptz,
          updated_at + interval '1 microsecond'
        )
      WHERE intent_id = ${input.intentId} AND state = ${IntentState.Acknowledged}
      RETURNING intent_id
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() =>
          Result.flatMap(
            decodeIntentWriteRows(storeOperation, 'acknowledged submit transition result failed decoding', rows),
            (decoded) => decideRecoveredOutcomeWrite(storeOperation, decoded, true),
          ),
        ),
      ),
    )

  const verifyAcknowledgedSubmit = (storeOperation: OutcomeStoreOperation, intentId: string) =>
    sql<{ acknowledged: boolean }>`
      SELECT EXISTS (
        SELECT 1
        FROM intents
        WHERE intent_id = ${intentId} AND state = ${IntentState.Acknowledged}
      ) AS acknowledged
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() =>
          Result.flatMap(
            Result.mapError(decodeAcknowledgedRowsResult(rows), (cause) =>
              storeError(storeOperation, 'decode', 'acknowledged submit recovery result failed decoding', cause),
            ),
            (decoded) => decideAcknowledgedRecovery(storeOperation, decoded[0]?.acknowledged),
          ),
        ),
      ),
    )

  const applySubmitRecovery = (
    storeOperation: OutcomeStoreOperation,
    input: MutationOutcomeInput,
    transition: Extract<MutationIntentTransition, { readonly _tag: 'RecoverSubmit' }>,
  ) =>
    Effect.gen(function* () {
      const recovered = yield* recoverUnknownSubmit(storeOperation, input)
      const decision = yield* fromDecision(() => decideSubmitRecoveryWrite(storeOperation, recovered, transition))
      switch (decision._tag) {
        case 'TransitionRecoveredIntent':
          return yield* transitionRecoveredSubmit(storeOperation, input, transition)
        case 'TransitionAcknowledgedTerminalIntent':
          return yield* transitionAcknowledgedSubmit(storeOperation, input, transition)
        case 'VerifyAcknowledgedIntent':
          return yield* verifyAcknowledgedSubmit(storeOperation, input.intentId)
      }
    })

  const recoverUnknownCancel = (storeOperation: OutcomeStoreOperation, input: MutationOutcomeInput) =>
    sql<{ intent_id: string }>`
      UPDATE intents
      SET
        state = ${IntentState.Recovered},
        state_version = state_version + 1,
        updated_at = GREATEST(${input.occurredAt}::timestamptz, updated_at + interval '1 microsecond')
      WHERE intent_id = ${input.intentId} AND state = ${IntentState.Unknown}
      RETURNING intent_id
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() => decodeIntentWriteRows(storeOperation, 'cancel recovery result failed decoding', rows)),
      ),
    )

  const applyCancelRecovery = (
    storeOperation: OutcomeStoreOperation,
    input: MutationOutcomeInput,
    transition: Extract<MutationIntentTransition, { readonly _tag: 'RecoverCancelTerminal' }>,
  ) =>
    Effect.gen(function* () {
      const recovered = yield* recoverUnknownCancel(storeOperation, input)
      const fromState = yield* fromDecision(() => decideCancelRecoveryState(storeOperation, recovered))
      const transitioned = yield* sql<{ intent_id: string }>`
        UPDATE intents
        SET
          state = ${IntentState.Terminal},
          terminal_outcome = ${transition.terminalOutcome},
          state_version = state_version + 1,
          updated_at = GREATEST(${input.occurredAt}::timestamptz, updated_at + interval '1 microsecond')
        WHERE intent_id = ${input.intentId} AND state = ${fromState}
        RETURNING intent_id
      `
      return yield* fromDecision(() =>
        Result.flatMap(
          decodeIntentWriteRows(storeOperation, 'cancel terminal transition result failed decoding', transitioned),
          (decoded) => decideMutationOutcomeWrite(storeOperation, decoded),
        ),
      )
    })

  const applyOutcomeTransition = (
    storeOperation: OutcomeStoreOperation,
    input: MutationOutcomeInput,
    transition: MutationIntentTransition,
  ) => {
    switch (transition._tag) {
      case 'KeepIntentState':
        return Effect.void
      case 'TransitionFromIoStarted':
        return transitionFromIoStarted(storeOperation, input, transition)
      case 'RecoverSubmit':
        return applySubmitRecovery(storeOperation, input, transition)
      case 'RecoverCancelTerminal':
        return applyCancelRecovery(storeOperation, input, transition)
    }
  }

  const outcomeTransaction = (
    storeOperation: OutcomeStoreOperation,
    input: MutationOutcomeInput,
    definition: MutationOutcomeDefinition,
  ) => {
    const facts = decideMutationOutcomeDefinition(definition)
    return Effect.gen(function* () {
      const previous = yield* readLatest(input.intentId, facts.operation)
      const currentIntent = yield* readOutcomeIntentSnapshot(storeOperation, input.intentId)
      const decision = yield* fromDecision(() => decideMutationOutcome(input, definition, previous, currentIntent))
      if (decision._tag === 'ReplayMutation') return decision.event

      if (decision.cancelFirst._tag === 'RequireNoDurableCancellation') {
        const cancellation = yield* readLatest(input.intentId, MutationOperation.Cancel)
        yield* fromDecision(() => decideCancelFirst(decision.cancelFirst, cancellation))
      }
      yield* appendEvent(storeOperation, decision.event)
      yield* applyOutcomeTransition(storeOperation, input, decision.transition)
      return decision.event
    })
  }

  const appendOutcome = (
    definition: MutationOutcomeDefinition,
    intentId: string,
    requestHash: string,
    occurredAt: string,
    evidence?: Partial<MutationEvidence>,
    brokerOrderId?: string,
  ) => {
    const storeOperation = outcomeStoreOperation(definition)
    return run(
      storeOperation,
      fromDecision(() =>
        Result.map(
          decodeOutcomeInput(storeOperation, {
            intentId,
            requestHash,
            occurredAt,
            ...(evidence === undefined ? {} : { evidence }),
            ...(brokerOrderId === undefined ? {} : { brokerOrderId }),
          }),
          (input) => ({ definition, input }),
        ),
      ).pipe(
        Effect.flatMap(({ definition, input }) =>
          fence.transaction(outcomeTransaction(storeOperation, input, definition)),
        ),
      ),
    )
  }

  return {
    beginSubmit: (intentId, requestHash, consistencyDelayMs, occurredAt) =>
      begin(MutationOperation.Submit, intentId, requestHash, consistencyDelayMs, occurredAt),
    submitAccepted: (intentId, requestHash, brokerOrderId, evidence, terminalOutcome) =>
      appendOutcome(
        {
          _tag: 'SubmitAccepted',
          ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
        },
        intentId,
        requestHash,
        evidence.observedAt,
        evidence,
        brokerOrderId,
      ),
    submitRejected: (intentId, requestHash, evidence) =>
      appendOutcome({ _tag: 'SubmitRejected' }, intentId, requestHash, evidence.observedAt, evidence),
    submitUnknown: (intentId, requestHash, occurredAt, evidence, brokerOrderId) =>
      appendOutcome({ _tag: 'SubmitUnknown' }, intentId, requestHash, occurredAt, evidence, brokerOrderId),
    beginCancel: (intentId, requestHash, brokerOrderId, consistencyDelayMs, occurredAt) =>
      begin(MutationOperation.Cancel, intentId, requestHash, consistencyDelayMs, occurredAt, brokerOrderId),
    cancelAccepted: (intentId, requestHash, brokerOrderId, evidence) =>
      appendOutcome({ _tag: 'CancelAccepted' }, intentId, requestHash, evidence.observedAt, evidence, brokerOrderId),
    cancelUnknown: (intentId, requestHash, brokerOrderId, occurredAt, evidence) =>
      appendOutcome({ _tag: 'CancelUnknown' }, intentId, requestHash, occurredAt, evidence, brokerOrderId),
    recoveryFound: (intentId, operation, requestHash, brokerOrderId, evidence, terminalOutcome) =>
      appendOutcome(
        {
          _tag: 'RecoveryFound',
          operation,
          ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
        },
        intentId,
        requestHash,
        evidence.observedAt,
        evidence,
        brokerOrderId,
      ),
    recoveryNotFound: (intentId, operation, requestHash, evidence) =>
      appendOutcome({ _tag: 'RecoveryNotFound', operation }, intentId, requestHash, evidence.observedAt, evidence),
    recoveryUnknown: (intentId, operation, requestHash, occurredAt, evidence) =>
      appendOutcome({ _tag: 'RecoveryUnknown', operation }, intentId, requestHash, occurredAt, evidence),
    latest,
  } satisfies MutationStoreShape
})

export const MutationStoreLive = Layer.effect(MutationStore, makeStore)
