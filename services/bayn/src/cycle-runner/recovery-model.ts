import { Data, Schema } from 'effect'

import {
  AutonomousCycleSchema,
  type ActiveDecisionBoundCycle,
  type ActiveUnboundCycle,
  type AutonomousCycle,
  type CycleCompletionState,
  type PendingCycle,
} from '../cycle'
import type { CyclePublicationReadiness } from '../cycle-readiness'
import { ObserveShadowDecisionDocumentSchema, type ObserveShadowDecisionDocument } from '../shadow-decision-contract'
import {
  NonNegativeFiniteSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'

export type WaitingReadiness = Extract<CyclePublicationReadiness, { readonly outcome: 'WAITING' }>
export type BlockedReadiness = Extract<CyclePublicationReadiness, { readonly outcome: 'BLOCKED' }>
export type BoundOrAlreadyReadiness = Extract<
  CyclePublicationReadiness,
  { readonly outcome: 'BOUND' | 'ALREADY_BOUND' }
>
export type BoundReadiness = Omit<BoundOrAlreadyReadiness, 'outcome'> & { readonly outcome: 'BOUND' }
export type AlreadyBoundReadiness = Omit<BoundOrAlreadyReadiness, 'outcome'> & { readonly outcome: 'ALREADY_BOUND' }

export const isAlreadyBoundReadiness = (readiness: CyclePublicationReadiness): readiness is AlreadyBoundReadiness =>
  readiness.outcome === 'ALREADY_BOUND'

export type CycleRecoverySelection =
  | { readonly action: 'DISCOVER' }
  | {
      readonly action: 'BLOCK'
      readonly cycleId: string
      readonly observedAt: string
      readonly reason: import('../cycle').CycleTerminalReason
    }
  | { readonly action: 'READ_PUBLICATION'; readonly cycle: AutonomousCycle }
  | { readonly action: 'RETURN_READINESS'; readonly result: WaitingReadiness; readonly recoveryAction: 'WAITING' }
  | { readonly action: 'RETURN_READINESS'; readonly result: BlockedReadiness; readonly recoveryAction: 'BLOCKED' }
  | {
      readonly action: 'RETURN_READINESS'
      readonly result: BoundReadiness
      readonly recoveryAction: 'BOUND_SNAPSHOT'
    }
  | { readonly action: 'ACTIVATE'; readonly cycleId: string; readonly observedAt: string }
  | { readonly action: 'WAIT'; readonly cycle: AutonomousCycle; readonly observedAt: string }
  | { readonly action: 'BUILD_DECISION'; readonly cycle: AutonomousCycle }
  | { readonly action: 'READ_DECISION'; readonly cycle: AutonomousCycle }
  | {
      readonly action: 'FINISH'
      readonly cycleId: string
      readonly observedAt: string
      readonly state: CycleCompletionState
    }

export interface CycleRecoveryState {
  readonly qualificationRunId: string
  readonly accountId: string
  readonly strategyProtocolHash: string
  readonly observedAt: string
  readonly cycle: AutonomousCycle | undefined
  readonly readiness?: CyclePublicationReadiness
  readonly decisionDocument?: ObserveShadowDecisionDocument | null
}

type RecoveryScope = Pick<
  CycleRecoveryState,
  'accountId' | 'observedAt' | 'qualificationRunId' | 'strategyProtocolHash'
>

export type CorrelatedCycleRecoveryState =
  | (RecoveryScope & {
      readonly cycle?: undefined
      readonly readiness?: undefined
      readonly decisionDocument?: undefined
    })
  | (RecoveryScope & {
      readonly cycle: PendingCycle
      readonly readiness?: CyclePublicationReadiness
      readonly decisionDocument?: undefined
    })
  | (RecoveryScope & {
      readonly cycle: ActiveUnboundCycle
      readonly readiness?: undefined
      readonly decisionDocument?: undefined
    })
  | (RecoveryScope & {
      readonly cycle: ActiveDecisionBoundCycle
      readonly readiness?: undefined
      readonly decisionDocument?: ObserveShadowDecisionDocument | null
    })

interface DecodeRecoveryStateIssue {
  readonly operation: 'decode-state'
  readonly reason: 'decode'
}

interface SelectRecoveryIssue {
  readonly operation: 'select'
  readonly reason:
    | 'chronology'
    | 'decision-missing'
    | 'evidence-without-cycle'
    | 'readiness-binding'
    | 'scope'
    | 'state-evidence'
    | 'terminal-cycle'
}

interface ValidateRecoveryDecisionIssue {
  readonly operation: 'validate-decision'
  readonly reason: 'decision-binding'
}

type CycleRecoveryIssue = DecodeRecoveryStateIssue | SelectRecoveryIssue | ValidateRecoveryDecisionIssue

interface CycleRecoveryFailureDetails {
  readonly message: string
  readonly facts: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}

const CycleRecoveryFailure = Data.TaggedError('CycleRecoveryFailure')<CycleRecoveryIssue & CycleRecoveryFailureDetails>
export type CycleRecoveryFailure = InstanceType<typeof CycleRecoveryFailure>

type CycleRecoveryReason<Operation extends CycleRecoveryIssue['operation']> = Extract<
  CycleRecoveryIssue,
  { readonly operation: Operation }
>['reason']

export const decodeRecoveryStateFailure = (
  reason: CycleRecoveryReason<'decode-state'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): CycleRecoveryFailure => new CycleRecoveryFailure({ operation: 'decode-state', reason, message, facts, cause })

export const selectRecoveryFailure = (
  reason: CycleRecoveryReason<'select'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): CycleRecoveryFailure => new CycleRecoveryFailure({ operation: 'select', reason, message, facts, cause })

export const validateDecisionFailure = (
  reason: CycleRecoveryReason<'validate-decision'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): CycleRecoveryFailure => new CycleRecoveryFailure({ operation: 'validate-decision', reason, message, facts, cause })

const PublicationFreshnessSchema = Schema.Struct({
  dataAgeMs: NonNegativeFiniteSchema,
  publicationDelayMs: NonNegativeFiniteSchema,
})

const WaitingReadinessSchema = Schema.Struct({
  outcome: Schema.Literal('WAITING'),
  reason: Schema.Literals(['SIGNAL_SESSION_OPEN', 'PUBLICATION_MISSING']),
  observedAt: UtcInstantSchema,
  cycle: AutonomousCycleSchema,
})

const BoundReadinessSchema = Schema.Struct({
  outcome: Schema.Literals(['BOUND', 'ALREADY_BOUND']),
  observedAt: UtcInstantSchema,
  cycle: AutonomousCycleSchema,
  snapshotId: Sha256Schema,
  freshness: Schema.optionalKey(PublicationFreshnessSchema),
})

const BlockedReadinessSchema = Schema.Struct({
  outcome: Schema.Literal('BLOCKED'),
  observedAt: UtcInstantSchema,
  cycle: AutonomousCycleSchema,
})

const CyclePublicationReadinessSchema = Schema.Union([
  WaitingReadinessSchema,
  BoundReadinessSchema,
  BlockedReadinessSchema,
])

const CycleRecoveryStateSchema = Schema.Struct({
  qualificationRunId: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
  strategyProtocolHash: Sha256Schema,
  observedAt: UtcInstantSchema,
  cycle: Schema.UndefinedOr(AutonomousCycleSchema),
  readiness: Schema.optionalKey(CyclePublicationReadinessSchema),
  decisionDocument: Schema.optionalKey(Schema.NullOr(ObserveShadowDecisionDocumentSchema)),
})

export type DecodedCycleRecoveryState = typeof CycleRecoveryStateSchema.Type
export const decodeCycleRecoveryStateResult = Schema.decodeUnknownResult(CycleRecoveryStateSchema, strictParseOptions)
