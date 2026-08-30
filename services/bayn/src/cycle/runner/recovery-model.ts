import { Data, Schema } from 'effect'

import {
  AutonomousCycleSchema,
  type ActiveDecisionBoundCycle,
  type ActiveUnboundCycle,
  type AutonomousCycle,
  type CycleCompletionState,
  type PendingCycle,
} from '../model'
import { CycleDecisionDocumentSchema, type CycleDecisionDocument } from '../../shadow-decision-contract'
import { Sha256Schema, StrictNonEmptyStringSchema, UtcInstantSchema, strictParseOptions } from '../../schemas'

export type CycleRecoverySelection =
  | { readonly action: 'DISCOVER' }
  | {
      readonly action: 'BLOCK'
      readonly cycleId: string
      readonly observedAt: string
      readonly reason: import('../model').CycleTerminalReason
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
  readonly cycleBindingId: string
  readonly accountId: string
  readonly strategyProtocolHash: string
  readonly observedAt: string
  readonly cycle: AutonomousCycle | undefined
  readonly decisionDocument?: CycleDecisionDocument | null
}

type RecoveryScope = Pick<CycleRecoveryState, 'accountId' | 'cycleBindingId' | 'observedAt' | 'strategyProtocolHash'>

export type CorrelatedCycleRecoveryState =
  | (RecoveryScope & {
      readonly cycle?: undefined
      readonly decisionDocument?: undefined
    })
  | (RecoveryScope & {
      readonly cycle: PendingCycle
      readonly decisionDocument?: undefined
    })
  | (RecoveryScope & {
      readonly cycle: ActiveUnboundCycle
      readonly decisionDocument?: undefined
    })
  | (RecoveryScope & {
      readonly cycle: ActiveDecisionBoundCycle
      readonly decisionDocument?: CycleDecisionDocument | null
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

interface CycleRecoveryFailureInput<Operation extends CycleRecoveryIssue['operation']> {
  readonly reason: CycleRecoveryReason<Operation>
  readonly message: string
  readonly facts?: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}

export const decodeRecoveryStateFailure = (input: CycleRecoveryFailureInput<'decode-state'>): CycleRecoveryFailure =>
  new CycleRecoveryFailure({ operation: 'decode-state', ...input, facts: input.facts ?? {} })

export const selectRecoveryFailure = (input: CycleRecoveryFailureInput<'select'>): CycleRecoveryFailure =>
  new CycleRecoveryFailure({ operation: 'select', ...input, facts: input.facts ?? {} })

export const validateDecisionFailure = (input: CycleRecoveryFailureInput<'validate-decision'>): CycleRecoveryFailure =>
  new CycleRecoveryFailure({ operation: 'validate-decision', ...input, facts: input.facts ?? {} })

const CycleRecoveryStateSchema = Schema.Struct({
  cycleBindingId: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
  strategyProtocolHash: Sha256Schema,
  observedAt: UtcInstantSchema,
  cycle: Schema.UndefinedOr(AutonomousCycleSchema),
  decisionDocument: Schema.optionalKey(Schema.NullOr(CycleDecisionDocumentSchema)),
})

export type DecodedCycleRecoveryState = typeof CycleRecoveryStateSchema.Type

const decodeCycleRecoveryState = Schema.decodeUnknownResult(CycleRecoveryStateSchema, strictParseOptions)

export const decodeCycleRecoveryStateResult = (input: unknown) => decodeCycleRecoveryState(input)
