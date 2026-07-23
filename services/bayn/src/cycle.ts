import { DateTime, Schema } from 'effect'

import type { MarketCalendarObservation, MarketCalendarSession } from './broker/alpaca'
import { canonicalHashV1 } from './hash'
import type { SignalSessionRow } from './market-data'
import type { CausalProtocol } from './protocol'
import {
  IsoDateSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from './schemas'
import { TargetPlanReason } from './target-planner'

const cycleTimeZone = 'America/New_York' as const
const autonomousCycleSubmissionWindowMs = 30 * 60_000
const SubmissionWindowMsSchema = PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(86_400_000))
const maximumSubmissionDurationMs = 86_400_000

const localMarketTimeToUtcOption = (sessionDate: string, marketTime: string): string | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(`${sessionDate}T${marketTime}`)
  if (match === null) return undefined
  const zoned = DateTime.makeZoned(
    {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
    },
    {
      timeZone: cycleTimeZone,
      adjustForTimeZone: true,
      disambiguation: 'reject',
    },
  )
  return zoned._tag === 'None' ? undefined : DateTime.toDateUtc(zoned.value).toISOString()
}

const localMarketTimeToUtc = (sessionDate: string, marketTime: string): string => {
  const instant = localMarketTimeToUtcOption(sessionDate, marketTime)
  if (instant === undefined) {
    throw new TypeError(`${sessionDate} ${marketTime} is not a valid ${cycleTimeZone} market time`)
  }
  return instant
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

export const cycleTerminalReasonForTargetPlanBlock = (reason: TargetPlanReason): CycleTerminalReason => {
  switch (reason) {
    case TargetPlanReason.SubmissionCutoffReached:
      return CycleTerminalReason.MissedSubmission
    case TargetPlanReason.IdentityMismatch:
      return CycleTerminalReason.ProvenanceMismatch
    case TargetPlanReason.InputMismatch:
      return CycleTerminalReason.DataInvalid
    case TargetPlanReason.InputStale:
      return CycleTerminalReason.DataStale
    case TargetPlanReason.ReconciliationNotExact:
      return CycleTerminalReason.Reconciliation
    case TargetPlanReason.AccountNotActive:
      return CycleTerminalReason.BrokerDisabled
    case TargetPlanReason.UnknownOrder:
    case TargetPlanReason.UnresolvedOrder:
      return CycleTerminalReason.UnresolvedMutation
    case TargetPlanReason.BelowMinimumBuyNotional:
    case TargetPlanReason.InsufficientBuyingPower:
    case TargetPlanReason.NonPositiveEquity:
    case TargetPlanReason.ShortPositionNotAllowed:
      return CycleTerminalReason.Risk
    case TargetPlanReason.TargetsSatisfied:
      throw new TypeError('blocked target plan cannot use the no-trade reason')
  }
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
  if (observation.executionCalendarHash !== canonicalHashV1(executionCalendarMaterialOf(observation))) {
    issues.push({
      path: ['executionCalendarHash'],
      issue: 'must match the selected broker-calendar session',
    })
  }
  return issues
}

export const ExecutionCalendarObservationSchema = ExecutionCalendarObservationBase.check(
  Schema.makeFilter(executionCalendarObservationIssues),
)
export type ExecutionCalendarObservation = typeof ExecutionCalendarObservationSchema.Type
export type SelectedExecutionCalendarSession = Pick<MarketCalendarObservation, 'schemaVersion' | 'source'> &
  MarketCalendarSession

const decodeExecutionCalendarMaterialSync = Schema.decodeUnknownSync(
  ExecutionCalendarObservationMaterialSchema,
  strictParseOptions,
)
const decodeExecutionCalendarObservationSync = Schema.decodeUnknownSync(
  ExecutionCalendarObservationSchema,
  strictParseOptions,
)

const CycleExecutionPolicyMaterialSchema = Schema.Struct({
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

export const CycleExecutionPolicySchema = CycleExecutionPolicyBase.check(
  Schema.makeFilter((policy) => {
    const { executionPolicyHash, ...material } = policy
    return executionPolicyHash === canonicalHashV1(material)
      ? []
      : [{ path: ['executionPolicyHash'], issue: 'must match the canonical execution policy material' }]
  }),
)
export type CycleExecutionPolicy = typeof CycleExecutionPolicySchema.Type

const CycleIdentityMaterialSchema = Schema.Struct({
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

const CycleIdentityBase = Schema.Struct({
  ...CycleIdentityMaterialSchema.fields,
  cycleId: Sha256Schema,
})

export const CycleIdentitySchema = CycleIdentityBase.check(
  Schema.makeFilter((identity) => {
    const issues: Schema.FilterIssue[] = []
    const { cycleId, ...material } = identity
    if (identity.signalSessionDate >= identity.executionSessionDate) {
      issues.push({ path: ['executionSessionDate'], issue: 'must follow the Signal session' })
    }
    if (cycleId !== canonicalHashV1(material)) {
      issues.push({ path: ['cycleId'], issue: 'must match the canonical cycle identity material' })
    }
    return issues
  }),
)
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

export const CycleWindowSchema = CycleWindowBase.check(
  Schema.makeFilter((window) => {
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
  }),
)
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

type SignalCycleSessionRow = Pick<SignalSessionRow, 'calendar_version' | 'session_date' | 'close_time' | 'timezone'>

export const signalSessionCloseAt = (signalSession: SignalCycleSessionRow): string => {
  if (signalSession.timezone !== cycleTimeZone) {
    throw new TypeError('Signal session timezone must be America/New_York')
  }
  return localMarketTimeToUtc(signalSession.session_date, signalSession.close_time)
}

export const makeCycleExecutionPolicy = (material: CycleExecutionPolicyMaterial): CycleExecutionPolicy => ({
  ...material,
  executionPolicyHash: canonicalHashV1(material),
})

export const makeCycleExecutionPolicyFromModel = (
  executionModel: CausalProtocol['executionModel'],
): CycleExecutionPolicy =>
  makeCycleExecutionPolicy({
    schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
    strategyExecutionModelHash: canonicalHashV1(executionModel),
    submissionWindowMs: autonomousCycleSubmissionWindowMs,
    submissionCutoffBeforeOpenMs: executionModel.order.submissionCutoffLeadMinutes * 60_000,
  })

export const makeExecutionCalendarObservation = (
  session: SelectedExecutionCalendarSession,
): ExecutionCalendarObservation => {
  let material: ExecutionCalendarObservationMaterial
  try {
    material = decodeExecutionCalendarMaterialSync({
      executionCalendarSchemaVersion: session.schemaVersion,
      executionCalendarSource: session.source,
      executionSessionDate: session.date,
      executionOpenAt: session.openAt,
      executionCloseAt: session.closeAt,
    })
  } catch {
    throw new TypeError('broker calendar session must contain ordered UTC instants for its session date')
  }
  return { ...material, executionCalendarHash: canonicalHashV1(material) }
}

export const makeCycleIdentity = (material: CycleIdentityMaterial): CycleIdentity => ({
  ...material,
  cycleId: canonicalHashV1(material),
})

export const makeCycleWindow = (
  signalSession: SignalCycleSessionRow,
  executionCalendar: ExecutionCalendarObservation,
  executionPolicy: Pick<CycleExecutionPolicy, 'submissionWindowMs' | 'submissionCutoffBeforeOpenMs'>,
): CycleWindow => {
  const { submissionCutoffBeforeOpenMs, submissionWindowMs } = executionPolicy
  if (
    !Number.isSafeInteger(submissionWindowMs) ||
    submissionWindowMs <= 0 ||
    submissionWindowMs > maximumSubmissionDurationMs
  ) {
    throw new TypeError('submission window must be between one millisecond and one day')
  }
  if (
    !Number.isSafeInteger(submissionCutoffBeforeOpenMs) ||
    submissionCutoffBeforeOpenMs <= 0 ||
    submissionCutoffBeforeOpenMs > maximumSubmissionDurationMs
  ) {
    throw new TypeError('broker cutoff lead must be between one millisecond and one day')
  }
  if (signalSession.session_date >= executionCalendar.executionSessionDate) {
    throw new TypeError('execution session must follow the Signal session')
  }
  try {
    decodeExecutionCalendarObservationSync(executionCalendar)
  } catch {
    throw new TypeError('selected broker calendar session is invalid')
  }
  const signalCloseAt = signalSessionCloseAt(signalSession)
  const executionOpenAt = executionCalendar.executionOpenAt
  const submissionCutoffAt = new Date(Date.parse(executionOpenAt) - submissionCutoffBeforeOpenMs).toISOString()
  const submissionOpenAt = new Date(Date.parse(submissionCutoffAt) - submissionWindowMs).toISOString()
  if (submissionOpenAt <= signalCloseAt) {
    throw new TypeError('submission window must begin after the Signal session close')
  }
  return {
    schemaVersion: 'bayn.autonomous-cycle-window.v1',
    signalCalendarVersion: signalSession.calendar_version,
    signalSessionDate: signalSession.session_date,
    ...executionCalendar,
    signalCloseAt,
    publicationDeadlineAt: submissionOpenAt,
    submissionOpenAt,
    submissionCutoffAt,
  }
}

export const makeCycleDraft = (identity: CycleIdentity, window: CycleWindow): CycleDraft => {
  if (identity.signalSessionDate !== window.signalSessionDate) {
    throw new TypeError('cycle identity and window must bind the same Signal session')
  }
  if (identity.signalCalendarVersion !== window.signalCalendarVersion) {
    throw new TypeError('cycle identity and window must bind the same Signal calendar')
  }
  if (
    identity.executionSessionDate !== window.executionSessionDate ||
    identity.executionCalendarSchemaVersion !== window.executionCalendarSchemaVersion ||
    identity.executionCalendarSource !== window.executionCalendarSource ||
    identity.executionCalendarHash !== window.executionCalendarHash
  ) {
    throw new TypeError('cycle identity and window must bind the same execution calendar observation')
  }
  const submissionWindowMs = Date.parse(window.submissionCutoffAt) - Date.parse(window.submissionOpenAt)
  if (submissionWindowMs !== identity.executionPolicy.submissionWindowMs) {
    throw new TypeError('cycle window must match the bound execution policy')
  }
  const submissionCutoffBeforeOpenMs = Date.parse(window.executionOpenAt) - Date.parse(window.submissionCutoffAt)
  if (submissionCutoffBeforeOpenMs !== identity.executionPolicy.submissionCutoffBeforeOpenMs) {
    throw new TypeError('cycle broker cutoff must match the bound execution policy')
  }
  return { schemaVersion: 'bayn.autonomous-cycle.v1', identity, window }
}

export const isTerminalCycleState = (state: CycleState): boolean =>
  state === CycleState.Completed || state === CycleState.NoTrade || state === CycleState.Blocked

export const isCycleStateTransitionAllowed = (from: CycleState, to: CycleState): boolean => {
  if (from === CycleState.Pending) return to === CycleState.Active || to === CycleState.Blocked
  if (from === CycleState.Active) {
    return to === CycleState.Completed || to === CycleState.NoTrade || to === CycleState.Blocked
  }
  return false
}

export const cycleDraftOf = (cycle: AutonomousCycle): CycleDraft => ({
  schemaVersion: cycle.schemaVersion,
  identity: cycle.identity,
  window: cycle.window,
})

export const cycleDraftMatches = (left: CycleDraft, right: CycleDraft): boolean =>
  canonicalHashV1(left) === canonicalHashV1(right)

export const decodeExecutionCalendarObservation = Schema.decodeUnknownEffect(
  ExecutionCalendarObservationSchema,
  strictParseOptions,
)
export const decodeCycleExecutionPolicy = Schema.decodeUnknownEffect(CycleExecutionPolicySchema, strictParseOptions)
export const decodeCycleIdentity = Schema.decodeUnknownEffect(CycleIdentitySchema, strictParseOptions)
export const decodeCycleWindow = Schema.decodeUnknownEffect(CycleWindowSchema, strictParseOptions)
export const decodeCycleDraft = Schema.decodeUnknownEffect(CycleDraftSchema, strictParseOptions)
export const decodeAutonomousCycle = Schema.decodeUnknownEffect(AutonomousCycleSchema, strictParseOptions)
