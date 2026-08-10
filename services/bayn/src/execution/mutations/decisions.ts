import { Result, Schema } from 'effect'

import { MutationOperation, type MutationEvidence, type PartialMutationEvidence } from '../../broker/alpaca-mutations'
import { canonicalHashV1Result } from '../../hash'
import { Authority, IntentState, KillState, OrderSide, TerminalOutcome } from '../contracts'
import { strictParseOptions } from '../../schemas'
import {
  MutationEventType,
  OutcomeInputSchema,
  StartInputSchema,
  type MutationAuthorityBinding,
  type MutationAuthoritySnapshot,
  type MutationCancelFirstDecision,
  type MutationCanonicalizationFact,
  type MutationCanonicalizationFailure,
  type MutationEvent,
  type MutationIntentSnapshot,
  type MutationIntentTransition,
  type MutationOutcomeDecision,
  type MutationOutcomeDefinition,
  type MutationOutcomeFacts,
  type MutationOutcomeInput,
  type MutationReplayIntentExpectation,
  type MutationReplayIntentSnapshot,
  type MutationStartDecision,
  type MutationStartInput,
  type MutationStartReplayDecision,
  type MutationStoreError,
  type OutcomeStoreOperation,
  type StartStoreOperation,
  type SubmitRecoveryWriteDecision,
} from './model'
import { MutationStoreError as MutationStoreErrorValue } from './model'
import { Pipeable } from '../../pipeable'

const decodeStartInputResult = Schema.decodeUnknownResult(StartInputSchema, strictParseOptions)
const decodeOutcomeInputResult = Schema.decodeUnknownResult(OutcomeInputSchema, strictParseOptions)
const hasCompleteEvidence = (evidence: PartialMutationEvidence): evidence is MutationEvidence =>
  evidence.requestId !== undefined &&
  evidence.status !== undefined &&
  evidence.contentHash !== undefined &&
  evidence.observedAt !== undefined

type MutationEvidenceDecision =
  | { readonly _tag: 'OmitIncompleteEvidence' }
  | { readonly _tag: 'RetainCompleteEvidence'; readonly evidence: PartialMutationEvidence }

const decideMutationEvidence = (evidence: PartialMutationEvidence | undefined): MutationEvidenceDecision =>
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

const canonicalHashResult = (
  fact: MutationCanonicalizationFact,
  value: unknown,
): Result.Result<string, MutationCanonicalizationFailure> =>
  Result.mapError(
    canonicalHashV1Result(value),
    (cause): MutationCanonicalizationFailure => ({
      _tag: 'MutationCanonicalizationFailure',
      fact,
      cause,
    }),
  )

const mutationIdResultDataFirst = (
  intentId: string,
  operation: MutationOperation,
): Result.Result<string, MutationCanonicalizationFailure> =>
  canonicalHashResult(
    { _tag: 'MutationIdentity', intentId, operation },
    { schemaVersion: 'bayn.paper-mutation.v1', intentId, operation },
  )

export const mutationIdResult = Pipeable.dual(2, mutationIdResultDataFirst)

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

export interface MutationStoreErrorInput {
  readonly operation: MutationStoreError['operation']
  readonly failure: MutationStoreError['failure']
  readonly message: string
  readonly cause?: unknown
}

export const storeError = (input: MutationStoreErrorInput): MutationStoreError => new MutationStoreErrorValue(input)

export const startStoreOperationFor = (operation: MutationOperation): StartStoreOperation =>
  operation === MutationOperation.Submit ? 'begin-submit' : 'begin-cancel'

const canonicalizationStoreErrorDataFirst = (
  operation: MutationStoreError['operation'],
  failure: MutationCanonicalizationFailure,
): MutationStoreError =>
  new MutationStoreErrorValue({
    operation,
    failure: 'invariant',
    message:
      failure.fact._tag === 'MutationIdentity'
        ? 'mutation identity canonicalization failed'
        : 'mutation event canonicalization failed',
    cause: failure.cause,
    canonicalizationFailure: failure,
  })

export const canonicalizationStoreError = Pipeable.dual(2, canonicalizationStoreErrorDataFirst)

const canonicalMutationIdDataFirst = (
  storeOperation: MutationStoreError['operation'],
  intentId: string,
  operation: MutationOperation,
): Result.Result<string, MutationStoreError> =>
  Result.mapError(mutationIdResult(intentId, operation), (failure) =>
    canonicalizationStoreError(storeOperation, failure),
  )

export const canonicalMutationId = Pipeable.dual(3, canonicalMutationIdDataFirst)

const makeEventResultDataFirst = (
  storeOperation: MutationStoreError['operation'],
  event: Omit<MutationEvent, 'eventId' | 'schemaVersion'>,
): Result.Result<MutationEvent, MutationStoreError> =>
  Result.mapError(mutationEventResult(event), (failure) => canonicalizationStoreError(storeOperation, failure))

export const makeEventResult = Pipeable.dual(2, makeEventResultDataFirst)

const decideMutationStartReplayDataFirst = (
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
      storeError({
        operation: storeOperation,
        failure: 'conflict',
        message: 'mutation identity was reused with different request content',
      }),
    )
  }
  return Result.succeed({
    _tag: 'ReplayMutation',
    receipt: { event: existing, started: false },
  })
}

export const decideMutationStartReplay = Pipeable.dual(3, decideMutationStartReplayDataFirst)

const decideMutationAuthorityDataFirst = (
  operation: MutationOperation,
  authority: MutationAuthoritySnapshot | undefined,
  closeOnly = false,
): Result.Result<MutationAuthorityBinding, MutationStoreError> => {
  const storeOperation = startStoreOperationFor(operation)
  if (authority === undefined) {
    return Result.fail(
      storeError({ operation: storeOperation, failure: 'authority', message: 'paper authority is not initialized' }),
    )
  }
  if (authority.maximum !== Authority.Paper) {
    return Result.fail(
      storeError({ operation: storeOperation, failure: 'authority', message: 'GitOps maximum authority is not PAPER' }),
    )
  }
  const ordinarySubmit = authority.effective === Authority.Paper && authority.killState === KillState.Clear
  const boundedCloseSubmit =
    closeOnly &&
    (authority.effective === Authority.Paper || authority.effective === Authority.Observe) &&
    (authority.killState === KillState.Clear || authority.killState === KillState.Active)
  if (operation === MutationOperation.Submit && !ordinarySubmit && !boundedCloseSubmit) {
    return Result.fail(
      storeError({
        operation: 'begin-submit',
        failure: 'authority',
        message: 'effective authority is not PAPER and clear',
      }),
    )
  }
  if (
    operation === MutationOperation.Cancel &&
    authority.killState === KillState.Clear &&
    authority.effective !== Authority.Paper
  ) {
    return Result.fail(
      storeError({
        operation: 'begin-cancel',
        failure: 'authority',
        message: 'cancellation requires PAPER authority or an active kill',
      }),
    )
  }
  if (authority.generationMaximum !== Authority.Paper || authority.generationAccountId === null) {
    return Result.fail(
      storeError({
        operation: storeOperation,
        failure: 'authority',
        message: 'active PAPER authority lacks its immutable account binding',
      }),
    )
  }
  return Result.succeed({
    accountId: authority.generationAccountId,
    generationHash: authority.generationHash,
  })
}

export const decideMutationAuthority = Pipeable.by<
  (
    authority: MutationAuthoritySnapshot | undefined,
    closeOnly?: boolean,
  ) => (operation: MutationOperation) => ReturnType<typeof decideMutationAuthorityDataFirst>,
  typeof decideMutationAuthorityDataFirst
>((arguments_) => typeof arguments_[0] === 'string', decideMutationAuthorityDataFirst)

export const decideFinalSubmitAuthorization = (
  authority: MutationAuthorityBinding,
  intent: MutationIntentSnapshot | undefined,
  closeOnly = false,
): Result.Result<void, MutationStoreError> => {
  if (intent === undefined) {
    return Result.fail(
      storeError({ operation: 'begin-submit', failure: 'invariant', message: 'final submit intent does not exist' }),
    )
  }
  if (closeOnly && intent.side !== OrderSide.Sell) {
    return Result.fail(
      storeError({
        operation: 'begin-submit',
        failure: 'authority',
        message: 'close-only submit requires a sell intent',
      }),
    )
  }
  if (
    intent.state !== IntentState.IoStarted ||
    intent.generationMaximum !== Authority.Paper ||
    intent.generationAccountId === null ||
    intent.generationAccountId !== intent.accountId ||
    intent.generationRiskPolicyHash !== intent.policyHash ||
    intent.generationStrategyName !== intent.strategyName ||
    intent.accountId !== authority.accountId ||
    intent.authorityGenerationHash !== authority.generationHash
  ) {
    return Result.fail(
      storeError({
        operation: 'begin-submit',
        failure: 'authority',
        message: 'final submit no longer matches active PAPER authority and immutable intent bindings',
      }),
    )
  }
  return Result.succeed(undefined)
}

export const decideMutationContainment = (unresolved: boolean | undefined): Result.Result<void, MutationStoreError> =>
  unresolved === false
    ? Result.succeed(undefined)
    : Result.fail(
        storeError({
          operation: 'begin-submit',
          failure: 'invariant',
          message: 'another broker mutation has an unresolved outcome',
        }),
      )

const decideMutationStartDataFirst = (
  operation: MutationOperation,
  input: MutationStartInput,
  authority: MutationAuthorityBinding,
  intent: MutationIntentSnapshot | undefined,
  submitted: MutationEvent | undefined,
): Result.Result<MutationStartDecision, MutationStoreError> => {
  const storeOperation = startStoreOperationFor(operation)
  if (intent === undefined) {
    return Result.fail(
      storeError({ operation: storeOperation, failure: 'invariant', message: 'intent does not exist' }),
    )
  }
  if (
    intent.generationMaximum !== Authority.Paper ||
    intent.generationAccountId === null ||
    intent.generationAccountId !== intent.accountId ||
    intent.generationRiskPolicyHash !== intent.policyHash ||
    intent.generationStrategyName !== intent.strategyName
  ) {
    return Result.fail(
      storeError({
        operation: storeOperation,
        failure: 'authority',
        message: 'intent does not match its immutable PAPER authority-generation bindings',
      }),
    )
  }
  if (intent.accountId !== authority.accountId) {
    return Result.fail(
      storeError({
        operation: storeOperation,
        failure: 'authority',
        message: 'intent account does not match the active PAPER authority generation',
      }),
    )
  }
  if (input.closeOnly === true && intent.side !== OrderSide.Sell) {
    return Result.fail(
      storeError({
        operation: 'begin-submit',
        failure: 'authority',
        message: 'close-only submit requires a sell intent',
      }),
    )
  }
  if (operation === MutationOperation.Submit && intent.authorityGenerationHash !== authority.generationHash) {
    return Result.fail(
      storeError({
        operation: 'begin-submit',
        failure: 'authority',
        message: 'intent authority generation is not the active PAPER generation',
      }),
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
      storeError({
        operation: 'begin-cancel',
        failure: 'invariant',
        message: 'cancel requires the exact durable submitted order identity',
      }),
    )
  }
  if (intent.state !== requiredState) {
    return Result.fail(
      storeError({
        operation: storeOperation,
        failure: 'invariant',
        message: `${operation.toLowerCase()} requires an ${requiredState} intent`,
      }),
    )
  }
  if (input.occurredAt <= intent.updatedAt) {
    return Result.fail(
      storeError({
        operation: storeOperation,
        failure: 'invariant',
        message: 'mutation time must follow the intent state',
      }),
    )
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

export const decideMutationStart = Pipeable.dual(5, decideMutationStartDataFirst)

export const decideMutationOutcomeDefinition = (definition: MutationOutcomeDefinition): MutationOutcomeFacts => {
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
    case 'SubmitDenied':
      return {
        operation: MutationOperation.Submit,
        eventType: MutationEventType.SubmitDenied,
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

export const outcomeStoreOperation = (definition: MutationOutcomeDefinition): OutcomeStoreOperation => {
  switch (definition._tag) {
    case 'SubmitAccepted':
    case 'SubmitRejected':
    case 'SubmitDenied':
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
        next === MutationEventType.SubmitDenied ||
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
    case MutationEventType.SubmitDenied:
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
      case MutationEventType.SubmitDenied:
        return (
          event.operation === MutationOperation.Submit &&
          event.brokerOrderId === undefined &&
          event.requestId === undefined &&
          event.responseStatus === undefined &&
          event.responseContentHash === undefined
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
        storeError({
          operation: storeOperation,
          failure: 'invariant',
          message: 'mutation event does not match its operation and evidence contract',
        }),
      )
}

const decideMutationOutcomeDataFirst = (
  input: MutationOutcomeInput,
  definition: MutationOutcomeDefinition,
  previous: MutationEvent | undefined,
  currentIntent: MutationReplayIntentSnapshot | undefined,
): Result.Result<MutationOutcomeDecision, MutationStoreError> => {
  const storeOperation = outcomeStoreOperation(definition)
  const facts = decideMutationOutcomeDefinition(definition)
  if (previous === undefined) {
    return Result.fail(
      storeError({ operation: storeOperation, failure: 'invariant', message: 'mutation STARTED event does not exist' }),
    )
  }
  const expectedMutationId = canonicalMutationId(storeOperation, input.intentId, facts.operation)
  if (Result.isFailure(expectedMutationId)) return Result.fail(expectedMutationId.failure)
  if (
    previous.intentId !== input.intentId ||
    previous.operation !== facts.operation ||
    previous.mutationId !== expectedMutationId.success
  ) {
    return Result.fail(
      storeError({
        operation: storeOperation,
        failure: 'conflict',
        message: 'mutation identity and sequence must remain exact',
      }),
    )
  }
  if (previous.requestHash !== input.requestHash) {
    return Result.fail(
      storeError({ operation: storeOperation, failure: 'conflict', message: 'mutation request hash changed' }),
    )
  }
  if (
    previous.brokerOrderId !== undefined &&
    input.brokerOrderId !== undefined &&
    previous.brokerOrderId !== input.brokerOrderId
  ) {
    return Result.fail(
      storeError({
        operation: storeOperation,
        failure: 'conflict',
        message: 'mutation broker order identity cannot change',
      }),
    )
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
        storeError({
          operation: storeOperation,
          failure: 'conflict',
          message: 'mutation outcome replay conflicts with durable intent state',
        }),
      )
    }
    return Result.succeed({ _tag: 'ReplayMutation', event: previous })
  }
  if (input.occurredAt < previous.occurredAt) {
    return Result.fail(
      storeError({
        operation: storeOperation,
        failure: 'conflict',
        message: 'mutation identity and sequence must remain exact',
      }),
    )
  }
  if (!allowsOutcomeEvent(previous.eventType, facts.eventType)) {
    return Result.fail(
      storeError({
        operation: storeOperation,
        failure: 'conflict',
        message: `invalid mutation transition from ${previous.eventType} to ${facts.eventType}`,
      }),
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

export const decideMutationOutcome = Pipeable.dual(4, decideMutationOutcomeDataFirst)

const decideCancelFirstDataFirst = (
  decision: MutationCancelFirstDecision,
  cancellation: MutationEvent | undefined,
): Result.Result<void, MutationStoreError> =>
  decision._tag === 'RequireNoDurableCancellation' && cancellation !== undefined
    ? Result.fail(
        storeError({
          operation: 'record-recovery',
          failure: 'conflict',
          message: 'terminal submit recovery cannot overtake a durable cancellation',
        }),
      )
    : Result.succeed(undefined)

export const decideCancelFirst = Pipeable.dual(2, decideCancelFirstDataFirst)

const decideMutationAppendDataFirst = (
  storeOperation: MutationStoreError['operation'],
  event: MutationEvent,
  appendedEventIds: readonly string[],
  requireCurrentRisk: boolean,
): Result.Result<MutationEvent, MutationStoreError> =>
  appendedEventIds.length === 1
    ? Result.succeed(event)
    : Result.fail(
        storeError({
          operation: storeOperation,
          failure: requireCurrentRisk ? 'invariant' : 'conflict',
          message: requireCurrentRisk
            ? 'mutation start requires a current approved risk decision'
            : 'mutation event append lost its race',
        }),
      )

export const decideMutationAppend = Pipeable.dual(4, decideMutationAppendDataFirst)

export const decideSubmitStartWrite = (
  transitionedIntentIds: readonly string[],
): Result.Result<void, MutationStoreError> =>
  transitionedIntentIds.length === 1
    ? Result.succeed(undefined)
    : Result.fail(
        storeError({
          operation: 'begin-submit',
          failure: 'conflict',
          message: 'approved intent transition lost its race',
        }),
      )

const decideMutationOutcomeWriteDataFirst = (
  storeOperation: OutcomeStoreOperation,
  transitionedIntentIds: readonly string[],
): Result.Result<void, MutationStoreError> =>
  transitionedIntentIds.length === 1
    ? Result.succeed(undefined)
    : Result.fail(
        storeError({
          operation: storeOperation,
          failure: 'conflict',
          message: 'intent mutation outcome lost its race',
        }),
      )

export const decideMutationOutcomeWrite = Pipeable.dual(2, decideMutationOutcomeWriteDataFirst)

const decideSubmitRecoveryWriteDataFirst = (
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
  return Result.fail(
    storeError({ operation: storeOperation, failure: 'conflict', message: 'unknown intent recovery lost its race' }),
  )
}

export const decideSubmitRecoveryWrite = Pipeable.dual(3, decideSubmitRecoveryWriteDataFirst)

const decideAcknowledgedRecoveryDataFirst = (
  storeOperation: OutcomeStoreOperation,
  acknowledged: boolean | undefined,
): Result.Result<void, MutationStoreError> =>
  acknowledged === true
    ? Result.succeed(undefined)
    : Result.fail(
        storeError({
          operation: storeOperation,
          failure: 'conflict',
          message: 'submit recovery requires an unresolved durable intent',
        }),
      )

export const decideAcknowledgedRecovery = Pipeable.dual(2, decideAcknowledgedRecoveryDataFirst)

const decideRecoveredOutcomeWriteDataFirst = (
  storeOperation: OutcomeStoreOperation,
  transitionedIntentIds: readonly string[],
  acknowledgedTerminal: boolean,
): Result.Result<void, MutationStoreError> =>
  transitionedIntentIds.length === 1
    ? Result.succeed(undefined)
    : Result.fail(
        storeError({
          operation: storeOperation,
          failure: 'conflict',
          message: acknowledgedTerminal
            ? 'acknowledged intent terminal recovery lost its race'
            : 'recovered intent outcome lost its race',
        }),
      )

export const decideRecoveredOutcomeWrite = Pipeable.dual(3, decideRecoveredOutcomeWriteDataFirst)

const decideCancelRecoveryStateDataFirst = (
  storeOperation: OutcomeStoreOperation,
  recoveredIntentIds: readonly string[],
): Result.Result<IntentState.Acknowledged | IntentState.Recovered, MutationStoreError> => {
  if (recoveredIntentIds.length === 0) return Result.succeed(IntentState.Acknowledged)
  if (recoveredIntentIds.length === 1) return Result.succeed(IntentState.Recovered)
  return Result.fail(
    storeError({ operation: storeOperation, failure: 'conflict', message: 'intent mutation outcome lost its race' }),
  )
}

export const decideCancelRecoveryState = Pipeable.dual(2, decideCancelRecoveryStateDataFirst)

const decodeStartInputDataFirst = (
  operation: MutationOperation,
  input: unknown,
): Result.Result<MutationStartInput, MutationStoreError> =>
  Result.mapError(decodeStartInputResult(input), (cause) =>
    storeError({
      operation: startStoreOperationFor(operation),
      failure: 'decode',
      message: 'invalid mutation start',
      cause,
    }),
  )

export const decodeStartInput = Pipeable.dual(2, decodeStartInputDataFirst)

const decodeOutcomeInputDataFirst = (
  storeOperation: OutcomeStoreOperation,
  input: {
    readonly intentId: string
    readonly requestHash: string
    readonly occurredAt: string
    readonly brokerOrderId?: string
    readonly evidence?: PartialMutationEvidence
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
    (cause) => storeError({ operation: storeOperation, failure: 'decode', message: 'invalid mutation outcome', cause }),
  )
}

export const decodeOutcomeInput = Pipeable.dual(2, decodeOutcomeInputDataFirst)
