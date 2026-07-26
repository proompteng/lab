import { Context, Data, Effect, Schema } from 'effect'

import { MutationEvidenceSchema, MutationOperation, type MutationEvidence } from '../../broker/alpaca-mutations'
import { Authority, IntentState, KillState, TerminalOutcome } from '../../paper'
import {
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  UtcInstantSchema as UtcInstant,
} from '../../schemas'
import type { WriterFenceError } from '../writer-fence'

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

export const Sequence = Schema.Int.check(Schema.isGreaterThan(0))
export const HttpStatus = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))
export const ConsistencyDelay = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 300_000 }))
export const BrokerOrderId = NonEmptyString.check(Schema.isMaxLength(256))
export const MutationEventSchema = Schema.Struct({
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

export const StartInputSchema = Schema.Struct({
  intentId: Sha256,
  requestHash: Sha256,
  consistencyDelayMs: ConsistencyDelay,
  occurredAt: UtcInstant,
  brokerOrderId: Schema.optionalKey(BrokerOrderId),
})
export const OutcomeInputSchema = Schema.Struct({
  intentId: Sha256,
  requestHash: Sha256,
  occurredAt: UtcInstant,
  brokerOrderId: Schema.optionalKey(BrokerOrderId),
  evidence: Schema.optionalKey(MutationEvidenceSchema),
})

export type MutationCanonicalizationFact =
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

export interface MutationCanonicalizationFailure {
  readonly _tag: 'MutationCanonicalizationFailure'
  readonly fact: MutationCanonicalizationFact
  readonly cause: unknown
}

export class MutationStoreError extends Data.TaggedError('MutationStoreError')<{
  readonly operation: 'begin-submit' | 'record-submit' | 'begin-cancel' | 'record-cancel' | 'record-recovery' | 'read'
  readonly failure: 'authority' | 'conflict' | 'decode' | 'invariant' | 'query'
  readonly message: string
  readonly cause?: unknown
  readonly canonicalizationFailure?: MutationCanonicalizationFailure
}> {}

export type StartStoreOperation = Extract<MutationStoreError['operation'], 'begin-submit' | 'begin-cancel'>
export type OutcomeStoreOperation = Extract<
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

export type MutationCancelFirstDecision =
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

export interface MutationOutcomeFacts {
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

export type MutationReplayIntentExpectation =
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

export type SubmitRecoveryWriteDecision =
  | { readonly _tag: 'TransitionRecoveredIntent' }
  | { readonly _tag: 'TransitionAcknowledgedTerminalIntent' }
  | { readonly _tag: 'VerifyAcknowledgedIntent' }
