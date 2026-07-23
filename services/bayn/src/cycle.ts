import { DateTime, Schema } from 'effect'

import { canonicalHashV1 } from './hash'
import type { SignalSessionRow } from './market-data'
import {
  IsoDateSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from './schemas'

const cycleTimeZone = 'America/New_York' as const
const SubmissionWindowMsSchema = PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(86_400_000))

export enum CycleState {
  Pending = 'PENDING',
  Active = 'ACTIVE',
  Completed = 'COMPLETED',
  NoTrade = 'NO_TRADE',
  Blocked = 'BLOCKED',
}

export enum CycleTerminalReason {
  MissedWindow = 'BLOCKED_MISSED_WINDOW',
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

const CycleExecutionPolicyMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.autonomous-cycle-execution-policy.v1'),
  strategyExecutionModelHash: Sha256Schema,
  submissionWindowMs: SubmissionWindowMsSchema,
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
  calendarVersion: StrictNonEmptyStringSchema,
  executionPolicy: CycleExecutionPolicySchema,
})
export type CycleIdentityMaterial = typeof CycleIdentityMaterialSchema.Type

const CycleIdentityBase = Schema.Struct({
  ...CycleIdentityMaterialSchema.fields,
  cycleId: Sha256Schema,
})

export const CycleIdentitySchema = CycleIdentityBase.check(
  Schema.makeFilter((identity) => {
    const { cycleId, ...material } = identity
    return cycleId === canonicalHashV1(material)
      ? []
      : [{ path: ['cycleId'], issue: 'must match the canonical cycle identity material' }]
  }),
)
export type CycleIdentity = typeof CycleIdentitySchema.Type

const CycleWindowBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.autonomous-cycle-window.v1'),
  calendarVersion: StrictNonEmptyStringSchema,
  signalSessionDate: IsoDateSchema,
  executionSessionDate: IsoDateSchema,
  signalCloseAt: UtcInstantSchema,
  publicationDeadlineAt: UtcInstantSchema,
  submissionOpenAt: UtcInstantSchema,
  executionOpenAt: UtcInstantSchema,
  executionCloseAt: UtcInstantSchema,
  submissionCutoffAt: UtcInstantSchema,
})

export const CycleWindowSchema = CycleWindowBase.check(
  Schema.makeFilter((window) => {
    const issues: Schema.FilterIssue[] = []
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
    if (window.submissionCutoffAt !== window.executionOpenAt) {
      issues.push({ path: ['submissionCutoffAt'], issue: 'must equal the execution session open' })
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
  if (draft.identity.calendarVersion !== draft.window.calendarVersion) {
    issues.push({ path: ['window', 'calendarVersion'], issue: 'must match the cycle identity' })
  }
  const submissionWindowMs = Date.parse(draft.window.submissionCutoffAt) - Date.parse(draft.window.submissionOpenAt)
  if (submissionWindowMs !== draft.identity.executionPolicy.submissionWindowMs) {
    issues.push({
      path: ['window', 'submissionCutoffAt'],
      issue: 'must match the bound execution policy submission window',
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

const localMarketTimeToUtc = (sessionDate: string, marketTime: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(`${sessionDate}T${marketTime}`)
  if (match === null) throw new TypeError(`invalid exchange session timestamp: ${sessionDate} ${marketTime}`)
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
  if (zoned._tag === 'None') {
    throw new TypeError(`${sessionDate} ${marketTime} is not a valid ${cycleTimeZone} market time`)
  }
  return DateTime.toDateUtc(zoned.value).toISOString()
}

type CycleSessionRow = Pick<
  SignalSessionRow,
  'calendar_version' | 'session_date' | 'open_time' | 'close_time' | 'timezone'
>

const validateCalendar = (sessions: readonly CycleSessionRow[]): void => {
  if (sessions.length < 2) throw new TypeError('cycle scheduling requires at least two exchange sessions')
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index]
    if (session.open_time >= session.close_time) {
      throw new TypeError(`exchange session ${session.session_date} close must follow its open`)
    }
    if (index > 0) {
      const previous = sessions[index - 1]
      if (previous.session_date >= session.session_date) {
        throw new TypeError('exchange sessions must be unique and strictly ordered')
      }
      if (previous.calendar_version !== session.calendar_version) {
        throw new TypeError('exchange sessions must use one calendar version')
      }
    }
  }
}

export const makeCycleExecutionPolicy = (material: CycleExecutionPolicyMaterial): CycleExecutionPolicy => ({
  ...material,
  executionPolicyHash: canonicalHashV1(material),
})

export const makeCycleIdentity = (material: CycleIdentityMaterial): CycleIdentity => ({
  ...material,
  cycleId: canonicalHashV1(material),
})

export const makeCycleWindow = (
  sessions: readonly Pick<
    SignalSessionRow,
    'calendar_version' | 'session_date' | 'open_time' | 'close_time' | 'timezone'
  >[],
  signalSessionDate: string,
  submissionWindowMs: number,
): CycleWindow => {
  validateCalendar(sessions)
  if (!Number.isSafeInteger(submissionWindowMs) || submissionWindowMs <= 0) {
    throw new TypeError('submission window must be a positive integer number of milliseconds')
  }
  const signalIndex = sessions.findIndex((session) => session.session_date === signalSessionDate)
  if (signalIndex < 0) throw new TypeError(`Signal session ${signalSessionDate} is absent from the exchange calendar`)
  const signalSession = sessions[signalIndex]
  const executionSession = sessions[signalIndex + 1]
  if (executionSession === undefined) {
    throw new TypeError(`Signal session ${signalSessionDate} has no following exchange session`)
  }
  const signalCloseAt = localMarketTimeToUtc(signalSession.session_date, signalSession.close_time)
  const executionOpenAt = localMarketTimeToUtc(executionSession.session_date, executionSession.open_time)
  const executionCloseAt = localMarketTimeToUtc(executionSession.session_date, executionSession.close_time)
  const submissionOpenAt = new Date(Date.parse(executionOpenAt) - submissionWindowMs).toISOString()
  if (submissionOpenAt <= signalCloseAt) {
    throw new TypeError('submission window must begin after the Signal session close')
  }
  return {
    schemaVersion: 'bayn.autonomous-cycle-window.v1',
    calendarVersion: signalSession.calendar_version,
    signalSessionDate: signalSession.session_date,
    executionSessionDate: executionSession.session_date,
    signalCloseAt,
    publicationDeadlineAt: submissionOpenAt,
    submissionOpenAt,
    executionOpenAt,
    executionCloseAt,
    submissionCutoffAt: executionOpenAt,
  }
}

export const makeCycleDraft = (identity: CycleIdentity, window: CycleWindow): CycleDraft => {
  if (identity.signalSessionDate !== window.signalSessionDate) {
    throw new TypeError('cycle identity and window must bind the same Signal session')
  }
  if (identity.calendarVersion !== window.calendarVersion) {
    throw new TypeError('cycle identity and window must bind the same exchange calendar')
  }
  const submissionWindowMs = Date.parse(window.submissionCutoffAt) - Date.parse(window.submissionOpenAt)
  if (submissionWindowMs !== identity.executionPolicy.submissionWindowMs) {
    throw new TypeError('cycle window must match the bound execution policy')
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

export const decodeCycleExecutionPolicy = Schema.decodeUnknownEffect(CycleExecutionPolicySchema, strictParseOptions)
export const decodeCycleIdentity = Schema.decodeUnknownEffect(CycleIdentitySchema, strictParseOptions)
export const decodeCycleWindow = Schema.decodeUnknownEffect(CycleWindowSchema, strictParseOptions)
export const decodeCycleDraft = Schema.decodeUnknownEffect(CycleDraftSchema, strictParseOptions)
export const decodeAutonomousCycle = Schema.decodeUnknownEffect(AutonomousCycleSchema, strictParseOptions)
