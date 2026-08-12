import { Result, Schema } from 'effect'

import type { MarketCalendarObservation, MarketCalendarSession } from '../broker/alpaca'
import { canonicalHashV1Result } from '../hash'
import {
  IsoDateSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import { Pipeable } from '../pipeable'

export const cycleTimeZone = 'America/New_York' as const
export const maximumSubmissionDurationMs = 86_400_000
export const SubmissionWindowMsSchema = PositiveIntegerSchema.check(
  Schema.isLessThanOrEqualTo(maximumSubmissionDurationMs),
)

const canonicalHashMatches = (value: unknown, expectedHash: string): boolean => {
  const hash = canonicalHashV1Result(value)
  return Result.isSuccess(hash) && hash.success === expectedHash
}

export enum CycleState {
  Pending = 'PENDING',
  Active = 'ACTIVE',
  Completed = 'COMPLETED',
  NoTrade = 'NO_TRADE',
  Blocked = 'BLOCKED',
}

export type CycleCompletionState = CycleState.Completed | CycleState.NoTrade

export enum CycleTerminalReason {
  MissedPublication = 'BLOCKED_MISSED_PUBLICATION_DEADLINE',
  MissedSubmission = 'BLOCKED_MISSED_SUBMISSION_DEADLINE',
  DataUnavailable = 'BLOCKED_DATA_UNAVAILABLE',
  DataStale = 'BLOCKED_DATA_STALE',
  DataInvalid = 'BLOCKED_DATA_INVALID',
  ProvenanceMismatch = 'BLOCKED_PROVENANCE_MISMATCH',
  Authority = 'BLOCKED_AUTHORITY',
  KillActive = 'BLOCKED_KILL_ACTIVE',
  BrokerDisabled = 'BLOCKED_BROKER_DISABLED',
  BrokerUnavailable = 'BLOCKED_BROKER_UNAVAILABLE',
  UnresolvedMutation = 'BLOCKED_UNRESOLVED_MUTATION',
  Reconciliation = 'BLOCKED_RECONCILIATION',
  Risk = 'BLOCKED_RISK',
}

const ExecutionCalendarObservationMaterialBase = Schema.Struct({
  executionCalendarSchemaVersion: Schema.Literal('bayn.alpaca-market-calendar-observation.v1'),
  executionCalendarSource: Schema.Literal('alpaca-v2-calendar'),
  executionSessionDate: IsoDateSchema,
  executionOpenAt: UtcInstantSchema,
  executionCloseAt: UtcInstantSchema,
})

const executionCalendarMaterialIssues = (
  observation: typeof ExecutionCalendarObservationMaterialBase.Type,
): Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  if (observation.executionOpenAt >= observation.executionCloseAt) {
    issues.push({ path: ['executionCloseAt'], issue: 'must follow the execution session open' })
  }
  if (
    !observation.executionOpenAt.startsWith(observation.executionSessionDate) ||
    !observation.executionCloseAt.startsWith(observation.executionSessionDate)
  ) {
    issues.push({ path: ['executionSessionDate'], issue: 'must match the UTC execution session instants' })
  }
  return issues
}

export const ExecutionCalendarObservationMaterialSchema = ExecutionCalendarObservationMaterialBase.check(
  Schema.makeFilter(executionCalendarMaterialIssues),
)
export type ExecutionCalendarObservationMaterial = typeof ExecutionCalendarObservationMaterialSchema.Type

const executionCalendarMaterialOf = (
  observation: ExecutionCalendarObservationMaterial,
): ExecutionCalendarObservationMaterial => ({
  executionCalendarSchemaVersion: observation.executionCalendarSchemaVersion,
  executionCalendarSource: observation.executionCalendarSource,
  executionSessionDate: observation.executionSessionDate,
  executionOpenAt: observation.executionOpenAt,
  executionCloseAt: observation.executionCloseAt,
})

const ExecutionCalendarObservationBase = Schema.Struct({
  ...ExecutionCalendarObservationMaterialBase.fields,
  executionCalendarHash: Sha256Schema,
})

const executionCalendarObservationIssues = (
  observation: typeof ExecutionCalendarObservationBase.Type,
): Schema.FilterIssue[] => {
  const issues = executionCalendarMaterialIssues(observation)
  if (!canonicalHashMatches(executionCalendarMaterialOf(observation), observation.executionCalendarHash)) {
    issues.push({ path: ['executionCalendarHash'], issue: 'must match the selected broker-calendar session' })
  }
  return issues
}

export const ExecutionCalendarObservationSchema = ExecutionCalendarObservationBase.check(
  Schema.makeFilter(executionCalendarObservationIssues),
)
export type ExecutionCalendarObservation = typeof ExecutionCalendarObservationSchema.Type
export type SelectedExecutionCalendarSession = Pick<MarketCalendarObservation, 'schemaVersion' | 'source'> &
  MarketCalendarSession

export const CycleExecutionPolicyMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.autonomous-cycle-execution-policy.v1'),
  strategyExecutionModelHash: Sha256Schema,
  submissionWindowMs: SubmissionWindowMsSchema,
  submissionCutoffBeforeOpenMs: SubmissionWindowMsSchema,
})
export type CycleExecutionPolicyMaterial = typeof CycleExecutionPolicyMaterialSchema.Type

const CycleExecutionPolicyBase = Schema.Struct({
  ...CycleExecutionPolicyMaterialSchema.fields,
  executionPolicyHash: Sha256Schema,
})

const cycleExecutionPolicyIssues = (policy: typeof CycleExecutionPolicyBase.Type): readonly Schema.FilterIssue[] => {
  const { executionPolicyHash, ...material } = policy
  return canonicalHashMatches(material, executionPolicyHash)
    ? []
    : [{ path: ['executionPolicyHash'], issue: 'must match the canonical execution policy material' }]
}

export const CycleExecutionPolicySchema = CycleExecutionPolicyBase.check(Schema.makeFilter(cycleExecutionPolicyIssues))
export type CycleExecutionPolicy = typeof CycleExecutionPolicySchema.Type

export const CycleIdentityMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.autonomous-cycle-identity.v1'),
  strategyName: Schema.Literal('risk-balanced-trend'),
  qualificationRunId: Sha256Schema,
  strategyProtocolHash: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
  signalSessionDate: IsoDateSchema,
  signalCalendarVersion: StrictNonEmptyStringSchema,
  executionSessionDate: IsoDateSchema,
  executionCalendarSchemaVersion: Schema.Literal('bayn.alpaca-market-calendar-observation.v1'),
  executionCalendarSource: Schema.Literal('alpaca-v2-calendar'),
  executionCalendarHash: Sha256Schema,
  executionPolicy: CycleExecutionPolicySchema,
})
export type CycleIdentityMaterial = typeof CycleIdentityMaterialSchema.Type

const CycleIdentityBase = Schema.Struct({ ...CycleIdentityMaterialSchema.fields, cycleId: Sha256Schema })

const cycleIdentityIssues = (identity: typeof CycleIdentityBase.Type): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  const { cycleId, ...material } = identity
  if (identity.signalSessionDate >= identity.executionSessionDate) {
    issues.push({ path: ['executionSessionDate'], issue: 'must follow the Signal session' })
  }
  if (!canonicalHashMatches(material, cycleId)) {
    issues.push({ path: ['cycleId'], issue: 'must match the canonical cycle identity material' })
  }
  return issues
}

export const CycleIdentitySchema = CycleIdentityBase.check(Schema.makeFilter(cycleIdentityIssues))
export type CycleIdentity = typeof CycleIdentitySchema.Type

const CycleWindowBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.autonomous-cycle-window.v1'),
  signalCalendarVersion: StrictNonEmptyStringSchema,
  signalSessionDate: IsoDateSchema,
  ...ExecutionCalendarObservationBase.fields,
  signalCloseAt: UtcInstantSchema,
  publicationDeadlineAt: UtcInstantSchema,
  submissionOpenAt: UtcInstantSchema,
  submissionCutoffAt: UtcInstantSchema,
})

const cycleWindowIssues = (window: typeof CycleWindowBase.Type): readonly Schema.FilterIssue[] => {
  const issues = executionCalendarObservationIssues(window)
  if (window.signalSessionDate >= window.executionSessionDate) {
    issues.push({ path: ['executionSessionDate'], issue: 'must follow the Signal session' })
  }
  if (window.signalCloseAt >= window.submissionOpenAt) {
    issues.push({ path: ['submissionOpenAt'], issue: 'must follow the Signal session close' })
  }
  if (window.publicationDeadlineAt !== window.submissionOpenAt) {
    issues.push({ path: ['publicationDeadlineAt'], issue: 'must equal the pre-open submission window' })
  }
  if (window.submissionOpenAt >= window.submissionCutoffAt) {
    issues.push({ path: ['submissionCutoffAt'], issue: 'must follow the submission window open' })
  }
  if (window.submissionCutoffAt >= window.executionOpenAt) {
    issues.push({ path: ['executionOpenAt'], issue: 'must follow the broker submission cutoff' })
  }
  if (window.executionOpenAt >= window.executionCloseAt) {
    issues.push({ path: ['executionCloseAt'], issue: 'must follow the execution session open' })
  }
  return issues
}

export const CycleWindowSchema = CycleWindowBase.check(Schema.makeFilter(cycleWindowIssues))
export type CycleWindow = typeof CycleWindowSchema.Type

const CycleDraftBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.autonomous-cycle.v1'),
  identity: CycleIdentitySchema,
  window: CycleWindowSchema,
})

const cycleDraftIssues = (draft: typeof CycleDraftBase.Type): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  if (draft.identity.signalSessionDate !== draft.window.signalSessionDate) {
    issues.push({ path: ['window', 'signalSessionDate'], issue: 'must match the cycle identity' })
  }
  if (draft.identity.signalCalendarVersion !== draft.window.signalCalendarVersion) {
    issues.push({ path: ['window', 'signalCalendarVersion'], issue: 'must match the cycle identity' })
  }
  if (draft.identity.executionSessionDate !== draft.window.executionSessionDate) {
    issues.push({ path: ['window', 'executionSessionDate'], issue: 'must match the cycle identity' })
  }
  if (draft.identity.executionCalendarSchemaVersion !== draft.window.executionCalendarSchemaVersion) {
    issues.push({ path: ['window', 'executionCalendarSchemaVersion'], issue: 'must match the cycle identity' })
  }
  if (draft.identity.executionCalendarSource !== draft.window.executionCalendarSource) {
    issues.push({ path: ['window', 'executionCalendarSource'], issue: 'must match the cycle identity' })
  }
  if (draft.identity.executionCalendarHash !== draft.window.executionCalendarHash) {
    issues.push({ path: ['window', 'executionCalendarHash'], issue: 'must match the cycle identity' })
  }
  const submissionWindowMs = Date.parse(draft.window.submissionCutoffAt) - Date.parse(draft.window.submissionOpenAt)
  if (submissionWindowMs !== draft.identity.executionPolicy.submissionWindowMs) {
    issues.push({
      path: ['window', 'submissionCutoffAt'],
      issue: 'must match the bound execution policy submission window',
    })
  }
  const submissionCutoffBeforeOpenMs =
    Date.parse(draft.window.executionOpenAt) - Date.parse(draft.window.submissionCutoffAt)
  if (submissionCutoffBeforeOpenMs !== draft.identity.executionPolicy.submissionCutoffBeforeOpenMs) {
    issues.push({
      path: ['window', 'submissionCutoffAt'],
      issue: 'must match the bound execution policy broker cutoff lead',
    })
  }
  return issues
}

export const CycleDraftSchema = CycleDraftBase.check(Schema.makeFilter(cycleDraftIssues))
export type CycleDraft = typeof CycleDraftSchema.Type

const CycleBindingsSchema = Schema.Struct({
  snapshotId: Schema.optionalKey(Sha256Schema),
  decisionHash: Schema.optionalKey(Sha256Schema),
})
export type CycleBindings = typeof CycleBindingsSchema.Type

const AutonomousCycleBase = Schema.Struct({
  ...CycleDraftBase.fields,
  state: Schema.Enum(CycleState),
  bindings: CycleBindingsSchema,
  terminalReason: Schema.optionalKey(Schema.Enum(CycleTerminalReason)),
  stateVersion: PositiveIntegerSchema,
  createdAt: UtcInstantSchema,
  updatedAt: UtcInstantSchema,
  terminalAt: Schema.optionalKey(UtcInstantSchema),
})

export const AutonomousCycleSchema = AutonomousCycleBase.check(
  Schema.makeFilter((cycle) => {
    const issues = [...cycleDraftIssues(cycle)]
    if (cycle.updatedAt < cycle.createdAt) {
      issues.push({ path: ['updatedAt'], issue: 'must not precede cycle creation' })
    }
    if (cycle.bindings.decisionHash !== undefined && cycle.bindings.snapshotId === undefined) {
      issues.push({ path: ['bindings', 'decisionHash'], issue: 'requires a bound snapshot' })
    }
    switch (cycle.state) {
      case CycleState.Pending:
        if (
          cycle.bindings.decisionHash !== undefined ||
          cycle.terminalReason !== undefined ||
          cycle.terminalAt !== undefined
        ) {
          issues.push({ path: ['state'], issue: 'PENDING permits only an optional snapshot binding' })
        }
        break
      case CycleState.Active:
        if (
          cycle.bindings.snapshotId === undefined ||
          cycle.terminalReason !== undefined ||
          cycle.terminalAt !== undefined
        ) {
          issues.push({ path: ['state'], issue: 'ACTIVE requires a snapshot and no terminal fields' })
        }
        break
      case CycleState.Completed:
        if (
          cycle.bindings.snapshotId === undefined ||
          cycle.bindings.decisionHash === undefined ||
          cycle.terminalReason !== undefined ||
          cycle.terminalAt === undefined
        ) {
          issues.push({ path: ['state'], issue: 'COMPLETED requires a bound decision and terminal time' })
        }
        break
      case CycleState.NoTrade:
        if (
          cycle.bindings.snapshotId === undefined ||
          cycle.bindings.decisionHash === undefined ||
          cycle.terminalReason !== undefined ||
          cycle.terminalAt === undefined
        ) {
          issues.push({ path: ['state'], issue: 'NO_TRADE requires a bound decision and terminal time' })
        }
        break
      case CycleState.Blocked:
        if (cycle.terminalReason === undefined || cycle.terminalAt === undefined) {
          issues.push({ path: ['state'], issue: 'BLOCKED requires its durable reason and terminal time' })
        }
        break
    }
    if (cycle.terminalAt !== undefined && cycle.terminalAt !== cycle.updatedAt) {
      issues.push({ path: ['terminalAt'], issue: 'must equal the terminal state update time' })
    }
    return issues
  }),
)
export type AutonomousCycle = typeof AutonomousCycleSchema.Type

type AutonomousCycleVariantBase = Omit<AutonomousCycle, 'bindings' | 'state' | 'terminalAt' | 'terminalReason'>
type PendingCycleBindings =
  | { readonly snapshotId?: undefined; readonly decisionHash?: undefined }
  | { readonly snapshotId: string; readonly decisionHash?: undefined }
type TerminalCycleBindings = PendingCycleBindings | { readonly snapshotId: string; readonly decisionHash: string }
export type PendingCycle = AutonomousCycleVariantBase & {
  readonly state: CycleState.Pending
  readonly bindings: PendingCycleBindings
  readonly terminalReason?: undefined
  readonly terminalAt?: undefined
}
export type ActiveUnboundCycle = AutonomousCycleVariantBase & {
  readonly state: CycleState.Active
  readonly bindings: { readonly snapshotId: string; readonly decisionHash?: undefined }
  readonly terminalReason?: undefined
  readonly terminalAt?: undefined
}
export type ActiveDecisionBoundCycle = AutonomousCycleVariantBase & {
  readonly state: CycleState.Active
  readonly bindings: { readonly snapshotId: string; readonly decisionHash: string }
  readonly terminalReason?: undefined
  readonly terminalAt?: undefined
}
export type CompletedCycle = AutonomousCycleVariantBase & {
  readonly state: CycleCompletionState
  readonly bindings: { readonly snapshotId: string; readonly decisionHash: string }
  readonly terminalReason?: undefined
  readonly terminalAt: string
}
export type BlockedCycle = AutonomousCycleVariantBase & {
  readonly state: CycleState.Blocked
  readonly bindings: TerminalCycleBindings
  readonly terminalReason: CycleTerminalReason
  readonly terminalAt: string
}
export type CorrelatedAutonomousCycle =
  | PendingCycle
  | ActiveUnboundCycle
  | ActiveDecisionBoundCycle
  | CompletedCycle
  | BlockedCycle

export const SignalCycleSessionSchema = Schema.Struct({
  calendar_version: StrictNonEmptyStringSchema,
  session_date: IsoDateSchema,
  close_time: Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
  timezone: Schema.Literal(cycleTimeZone),
})

export const SelectedExecutionCalendarSessionSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.alpaca-market-calendar-observation.v1'),
  source: Schema.Literal('alpaca-v2-calendar'),
  date: IsoDateSchema,
  openAt: UtcInstantSchema,
  closeAt: UtcInstantSchema,
})

export const CycleWindowPolicyInputSchema = Schema.Union([
  CycleExecutionPolicySchema,
  Schema.Struct({
    submissionWindowMs: Schema.Finite,
    submissionCutoffBeforeOpenMs: Schema.Finite,
  }),
])

export type SignalCycleSession = typeof SignalCycleSessionSchema.Type
export type CycleWindowPolicyInput = typeof CycleWindowPolicyInputSchema.Type

const decodeExecutionCalendarMaterialResultDataFirst = Schema.decodeUnknownResult(
  ExecutionCalendarObservationMaterialSchema,
  strictParseOptions,
)

export const decodeExecutionCalendarMaterialResult = Pipeable.dual(1, (input: unknown) =>
  decodeExecutionCalendarMaterialResultDataFirst(input),
)
const decodeExecutionCalendarObservationResultDataFirst = Schema.decodeUnknownResult(
  ExecutionCalendarObservationSchema,
  strictParseOptions,
)

export const decodeExecutionCalendarObservationResult = Pipeable.dual(1, (input: unknown) =>
  decodeExecutionCalendarObservationResultDataFirst(input),
)
const decodeCycleWindowPolicyInputResultDataFirst = Schema.decodeUnknownResult(
  CycleWindowPolicyInputSchema,
  strictParseOptions,
)

export const decodeCycleWindowPolicyInputResult = Pipeable.dual(1, (input: unknown) =>
  decodeCycleWindowPolicyInputResultDataFirst(input),
)
const decodeCycleExecutionPolicyMaterialResultDataFirst = Schema.decodeUnknownResult(
  CycleExecutionPolicyMaterialSchema,
  strictParseOptions,
)

export const decodeCycleExecutionPolicyMaterialResult = Pipeable.dual(1, (input: unknown) =>
  decodeCycleExecutionPolicyMaterialResultDataFirst(input),
)
const decodeCycleExecutionPolicyResultDataFirst = Schema.decodeUnknownResult(
  CycleExecutionPolicySchema,
  strictParseOptions,
)

export const decodeCycleExecutionPolicyResult = Pipeable.dual(1, (input: unknown) =>
  decodeCycleExecutionPolicyResultDataFirst(input),
)
const decodeCycleIdentityMaterialResultDataFirst = Schema.decodeUnknownResult(
  CycleIdentityMaterialSchema,
  strictParseOptions,
)

export const decodeCycleIdentityMaterialResult = Pipeable.dual(1, (input: unknown) =>
  decodeCycleIdentityMaterialResultDataFirst(input),
)
const decodeCycleIdentityResultDataFirst = Schema.decodeUnknownResult(CycleIdentitySchema, strictParseOptions)

export const decodeCycleIdentityResult = Pipeable.dual(1, (input: unknown) => decodeCycleIdentityResultDataFirst(input))
const decodeCycleWindowResultDataFirst = Schema.decodeUnknownResult(CycleWindowSchema, strictParseOptions)

export const decodeCycleWindowResult = Pipeable.dual(1, (input: unknown) => decodeCycleWindowResultDataFirst(input))
const decodeCycleDraftResultDataFirst = Schema.decodeUnknownResult(CycleDraftSchema, strictParseOptions)

export const decodeCycleDraftResult = Pipeable.dual(1, (input: unknown) => decodeCycleDraftResultDataFirst(input))

const decodeExecutionCalendarObservationDataFirst = Schema.decodeUnknownEffect(
  ExecutionCalendarObservationSchema,
  strictParseOptions,
)

export const decodeExecutionCalendarObservation = Pipeable.dual(1, (input: unknown) =>
  decodeExecutionCalendarObservationDataFirst(input),
)
const decodeCycleExecutionPolicyDataFirst = Schema.decodeUnknownEffect(CycleExecutionPolicySchema, strictParseOptions)

export const decodeCycleExecutionPolicy = Pipeable.dual(1, (input: unknown) =>
  decodeCycleExecutionPolicyDataFirst(input),
)
const decodeCycleIdentityDataFirst = Schema.decodeUnknownEffect(CycleIdentitySchema, strictParseOptions)

export const decodeCycleIdentity = Pipeable.dual(1, (input: unknown) => decodeCycleIdentityDataFirst(input))
const decodeCycleWindowDataFirst = Schema.decodeUnknownEffect(CycleWindowSchema, strictParseOptions)

export const decodeCycleWindow = Pipeable.dual(1, (input: unknown) => decodeCycleWindowDataFirst(input))
const decodeCycleDraftDataFirst = Schema.decodeUnknownEffect(CycleDraftSchema, strictParseOptions)

export const decodeCycleDraft = Pipeable.dual(1, (input: unknown) => decodeCycleDraftDataFirst(input))
const decodeAutonomousCycleDataFirst = Schema.decodeUnknownEffect(AutonomousCycleSchema, strictParseOptions)

export const decodeAutonomousCycle = Pipeable.dual(1, (input: unknown) => decodeAutonomousCycleDataFirst(input))
