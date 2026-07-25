import { Data, DateTime, Result, Schema } from 'effect'

import type { MarketCalendarObservation, MarketCalendarSession } from './broker/alpaca'
import { canonicalHashV1 } from './hash'
import { ExecutionModelV2Schema } from './protocol'
import {
  IsoDateSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from './schemas'
const cycleTimeZone = 'America/New_York' as const
const autonomousCycleSubmissionWindowMs = 30 * 60_000
const SubmissionWindowMsSchema = PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(86_400_000))
const maximumSubmissionDurationMs = 86_400_000

const canonicalHashResult = (value: unknown): Result.Result<string, unknown> => Result.try(() => canonicalHashV1(value))

const canonicalHashMatches = (value: unknown, expectedHash: string): boolean => {
  const hash = canonicalHashResult(value)
  return Result.isSuccess(hash) && hash.success === expectedHash
}

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

export enum CycleState {
  Pending = 'PENDING',
  Active = 'ACTIVE',
  Completed = 'COMPLETED',
  NoTrade = 'NO_TRADE',
  Blocked = 'BLOCKED',
}
export type CycleCompletionState = CycleState.Completed | CycleState.NoTrade

interface CycleDraftConstructionIssue {
  readonly operation: 'cycle-draft'
  readonly reason: 'binding' | 'decode'
}

interface CycleIdentityConstructionIssue {
  readonly operation: 'cycle-identity'
  readonly reason: 'decode' | 'hash' | 'session-order'
}

interface CycleWindowConstructionIssue {
  readonly operation: 'cycle-window'
  readonly reason: 'decode' | 'duration' | 'market-time' | 'session-order' | 'submission-window'
}

interface ExecutionCalendarConstructionIssue {
  readonly operation: 'execution-calendar'
  readonly reason: 'decode' | 'hash'
}

interface ExecutionPolicyConstructionIssue {
  readonly operation: 'execution-policy'
  readonly reason: 'decode' | 'hash'
}

interface SignalCloseConstructionIssue {
  readonly operation: 'signal-close'
  readonly reason: 'decode' | 'market-time'
}

type CycleConstructionIssue =
  | CycleDraftConstructionIssue
  | CycleIdentityConstructionIssue
  | CycleWindowConstructionIssue
  | ExecutionCalendarConstructionIssue
  | ExecutionPolicyConstructionIssue
  | SignalCloseConstructionIssue

interface CycleConstructionFailureDetails {
  readonly message: string
  readonly facts: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}

const CycleConstructionFailure = Data.TaggedError('CycleConstructionFailure')<
  CycleConstructionIssue & CycleConstructionFailureDetails
>
export type CycleConstructionFailure = InstanceType<typeof CycleConstructionFailure>

type CycleConstructionReason<Operation extends CycleConstructionIssue['operation']> = Extract<
  CycleConstructionIssue,
  { readonly operation: Operation }
>['reason']

const cycleDraftFailure = (
  reason: CycleConstructionReason<'cycle-draft'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): CycleConstructionFailure => new CycleConstructionFailure({ operation: 'cycle-draft', reason, message, facts, cause })

const cycleIdentityFailure = (
  reason: CycleConstructionReason<'cycle-identity'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): CycleConstructionFailure =>
  new CycleConstructionFailure({ operation: 'cycle-identity', reason, message, facts, cause })

const cycleWindowFailure = (
  reason: CycleConstructionReason<'cycle-window'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): CycleConstructionFailure =>
  new CycleConstructionFailure({ operation: 'cycle-window', reason, message, facts, cause })

const executionCalendarFailure = (
  reason: CycleConstructionReason<'execution-calendar'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): CycleConstructionFailure =>
  new CycleConstructionFailure({ operation: 'execution-calendar', reason, message, facts, cause })

const executionPolicyFailure = (
  reason: CycleConstructionReason<'execution-policy'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): CycleConstructionFailure =>
  new CycleConstructionFailure({ operation: 'execution-policy', reason, message, facts, cause })

const signalCloseFailure = (
  reason: CycleConstructionReason<'signal-close'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): CycleConstructionFailure =>
  new CycleConstructionFailure({ operation: 'signal-close', reason, message, facts, cause })

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

const decodeExecutionCalendarMaterialResult = Schema.decodeUnknownResult(
  ExecutionCalendarObservationMaterialSchema,
  strictParseOptions,
)
const decodeExecutionCalendarObservationResult = Schema.decodeUnknownResult(
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

const cycleExecutionPolicyIssues = (policy: typeof CycleExecutionPolicyBase.Type): readonly Schema.FilterIssue[] => {
  const { executionPolicyHash, ...material } = policy
  return canonicalHashMatches(material, executionPolicyHash)
    ? []
    : [{ path: ['executionPolicyHash'], issue: 'must match the canonical execution policy material' }]
}

export const CycleExecutionPolicySchema = CycleExecutionPolicyBase.check(Schema.makeFilter(cycleExecutionPolicyIssues))
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

const SignalCycleSessionSchema = Schema.Struct({
  calendar_version: StrictNonEmptyStringSchema,
  session_date: IsoDateSchema,
  close_time: Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
  timezone: Schema.Literal(cycleTimeZone),
})

const SelectedExecutionCalendarSessionSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.alpaca-market-calendar-observation.v1'),
  source: Schema.Literal('alpaca-v2-calendar'),
  date: IsoDateSchema,
  openAt: UtcInstantSchema,
  closeAt: UtcInstantSchema,
})

const CycleWindowPolicyInputSchema = Schema.Union([
  CycleExecutionPolicySchema,
  Schema.Struct({
    submissionWindowMs: Schema.Number,
    submissionCutoffBeforeOpenMs: Schema.Number,
  }),
])

const decodeSignalCycleSessionResult = Schema.decodeUnknownResult(SignalCycleSessionSchema, strictParseOptions)
const decodeSelectedExecutionCalendarSessionResult = Schema.decodeUnknownResult(
  SelectedExecutionCalendarSessionSchema,
  strictParseOptions,
)
const decodeCycleWindowPolicyInputResult = Schema.decodeUnknownResult(CycleWindowPolicyInputSchema, strictParseOptions)
const decodeCycleExecutionPolicyMaterialResult = Schema.decodeUnknownResult(
  CycleExecutionPolicyMaterialSchema,
  strictParseOptions,
)
const decodeExecutionModelV2Result = Schema.decodeUnknownResult(ExecutionModelV2Schema, strictParseOptions)
const decodeCycleExecutionPolicyResult = Schema.decodeUnknownResult(CycleExecutionPolicySchema, strictParseOptions)
const decodeCycleIdentityMaterialResult = Schema.decodeUnknownResult(CycleIdentityMaterialSchema, strictParseOptions)
const decodeCycleIdentityResult = Schema.decodeUnknownResult(CycleIdentitySchema, strictParseOptions)
const decodeCycleWindowResult = Schema.decodeUnknownResult(CycleWindowSchema, strictParseOptions)
const decodeCycleDraftResult = Schema.decodeUnknownResult(CycleDraftSchema, strictParseOptions)

type SignalCycleSession = typeof SignalCycleSessionSchema.Type
type CycleWindowPolicyInput = typeof CycleWindowPolicyInputSchema.Type

interface DecodedCycleWindowInput {
  readonly signal: SignalCycleSession
  readonly calendar: ExecutionCalendarObservation
  readonly policy: CycleWindowPolicyInput
}

interface DerivedCycleWindowTimes {
  readonly signalCloseAt: string
  readonly submissionOpenAt: string
  readonly submissionCutoffAt: string
}

export const signalSessionCloseAt = (signalSession: unknown): Result.Result<string, CycleConstructionFailure> =>
  Result.flatMap(
    Result.mapError(decodeSignalCycleSessionResult(signalSession), (cause) =>
      signalCloseFailure('decode', 'Signal session must contain a canonical America/New_York close', {}, cause),
    ),
    (decoded) => {
      const instant = localMarketTimeToUtcOption(decoded.session_date, decoded.close_time)
      return instant === undefined
        ? Result.fail(
            signalCloseFailure(
              'market-time',
              `${decoded.session_date} ${decoded.close_time} is not a valid ${cycleTimeZone} market time`,
              { sessionDate: decoded.session_date, marketTime: decoded.close_time, timeZone: cycleTimeZone },
            ),
          )
        : Result.succeed(instant)
    },
  )

export const makeCycleExecutionPolicy = (
  material: unknown,
): Result.Result<CycleExecutionPolicy, CycleConstructionFailure> =>
  Result.flatMap(
    Result.mapError(decodeCycleExecutionPolicyMaterialResult(material), (cause) =>
      executionPolicyFailure('decode', 'cycle execution policy material is invalid', {}, cause),
    ),
    (decoded) =>
      Result.flatMap(
        Result.try({
          try: () => ({ ...decoded, executionPolicyHash: canonicalHashV1(decoded) }),
          catch: (cause) =>
            executionPolicyFailure('hash', 'cycle execution policy material is not canonicalizable', {}, cause),
        }),
        (policy) =>
          Result.mapError(decodeCycleExecutionPolicyResult(policy), (cause) =>
            executionPolicyFailure('decode', 'cycle execution policy is invalid', {}, cause),
          ),
      ),
  )

export const makeCycleExecutionPolicyFromModel = (
  executionModel: unknown,
): Result.Result<CycleExecutionPolicy, CycleConstructionFailure> =>
  Result.flatMap(
    Result.mapError(decodeExecutionModelV2Result(executionModel), (cause) =>
      executionPolicyFailure('decode', 'strategy execution model is invalid', {}, cause),
    ),
    (decodedModel) =>
      Result.flatMap(
        Result.try({
          try: () => canonicalHashV1(decodedModel),
          catch: (cause) =>
            executionPolicyFailure('hash', 'strategy execution model is not canonicalizable', {}, cause),
        }),
        (strategyExecutionModelHash) =>
          makeCycleExecutionPolicy({
            schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
            strategyExecutionModelHash,
            submissionWindowMs: autonomousCycleSubmissionWindowMs,
            submissionCutoffBeforeOpenMs: decodedModel.order.submissionCutoffLeadMinutes * 60_000,
          }),
      ),
  )

export const makeExecutionCalendarObservation = (
  session: unknown,
): Result.Result<ExecutionCalendarObservation, CycleConstructionFailure> =>
  Result.flatMap(
    Result.mapError(decodeSelectedExecutionCalendarSessionResult(session), (cause) =>
      executionCalendarFailure(
        'decode',
        'broker calendar session must contain ordered UTC instants for its session date',
        {},
        cause,
      ),
    ),
    (decoded) => {
      const materialResult = decodeExecutionCalendarMaterialResult({
        executionCalendarSchemaVersion: decoded.schemaVersion,
        executionCalendarSource: decoded.source,
        executionSessionDate: decoded.date,
        executionOpenAt: decoded.openAt,
        executionCloseAt: decoded.closeAt,
      })
      return Result.flatMap(
        Result.mapError(materialResult, (cause) =>
          executionCalendarFailure(
            'decode',
            'broker calendar session must contain ordered UTC instants for its session date',
            { sessionDate: decoded.date },
            cause,
          ),
        ),
        (material) =>
          Result.flatMap(
            Result.try({
              try: () => ({ ...material, executionCalendarHash: canonicalHashV1(material) }),
              catch: (cause) =>
                executionCalendarFailure(
                  'hash',
                  'broker calendar session is not canonicalizable',
                  { sessionDate: decoded.date },
                  cause,
                ),
            }),
            (observation) =>
              Result.mapError(decodeExecutionCalendarObservationResult(observation), (cause) =>
                executionCalendarFailure(
                  'decode',
                  'selected broker calendar session is invalid',
                  { sessionDate: decoded.date },
                  cause,
                ),
              ),
          ),
      )
    },
  )

export const makeCycleIdentity = (material: unknown): Result.Result<CycleIdentity, CycleConstructionFailure> =>
  Result.flatMap(
    Result.mapError(decodeCycleIdentityMaterialResult(material), (cause) =>
      cycleIdentityFailure('decode', 'cycle identity material is invalid', {}, cause),
    ),
    (decoded) =>
      Result.flatMap(
        Result.try({
          try: () => ({ ...decoded, cycleId: canonicalHashV1(decoded) }),
          catch: (cause) => cycleIdentityFailure('hash', 'cycle identity material is not canonicalizable', {}, cause),
        }),
        (identity) =>
          Result.mapError(decodeCycleIdentityResult(identity), (cause) =>
            cycleIdentityFailure(
              'session-order',
              'execution session must follow the Signal session',
              {
                signalSessionDate: decoded.signalSessionDate,
                executionSessionDate: decoded.executionSessionDate,
              },
              cause,
            ),
          ),
      ),
  )

const decodeCycleWindowInputs = (
  signalSession: unknown,
  executionCalendar: unknown,
  executionPolicy: unknown,
): Result.Result<DecodedCycleWindowInput, CycleConstructionFailure> => {
  const decodedSignal = Result.mapError(decodeSignalCycleSessionResult(signalSession), (cause) =>
    cycleWindowFailure('decode', 'Signal session material is invalid', {}, cause),
  )
  const decodedCalendar = Result.mapError(decodeExecutionCalendarObservationResult(executionCalendar), (cause) =>
    cycleWindowFailure('decode', 'selected broker calendar session is invalid', {}, cause),
  )
  const decodedPolicy = Result.mapError(decodeCycleWindowPolicyInputResult(executionPolicy), (cause) =>
    cycleWindowFailure('decode', 'cycle window policy is invalid', {}, cause),
  )
  return Result.flatMap(decodedSignal, (signal) =>
    Result.flatMap(decodedCalendar, (calendar) =>
      Result.map(decodedPolicy, (policy) => ({ signal, calendar, policy })),
    ),
  )
}

const validateCycleWindowDurations = (
  policy: CycleWindowPolicyInput,
): Result.Result<void, CycleConstructionFailure> => {
  const { submissionCutoffBeforeOpenMs, submissionWindowMs } = policy
  if (
    !Number.isSafeInteger(submissionWindowMs) ||
    submissionWindowMs <= 0 ||
    submissionWindowMs > maximumSubmissionDurationMs
  ) {
    return Result.fail(
      cycleWindowFailure('duration', 'submission window must be between one millisecond and one day', {
        submissionWindowMs,
      }),
    )
  }
  if (
    !Number.isSafeInteger(submissionCutoffBeforeOpenMs) ||
    submissionCutoffBeforeOpenMs <= 0 ||
    submissionCutoffBeforeOpenMs > maximumSubmissionDurationMs
  ) {
    return Result.fail(
      cycleWindowFailure('duration', 'broker cutoff lead must be between one millisecond and one day', {
        submissionCutoffBeforeOpenMs,
      }),
    )
  }
  return Result.succeed(undefined)
}

const deriveCycleWindowTimes = (
  input: DecodedCycleWindowInput,
): Result.Result<DerivedCycleWindowTimes, CycleConstructionFailure> => {
  const { calendar, policy, signal } = input
  if (signal.session_date >= calendar.executionSessionDate) {
    return Result.fail(
      cycleWindowFailure('session-order', 'execution session must follow the Signal session', {
        signalSessionDate: signal.session_date,
        executionSessionDate: calendar.executionSessionDate,
      }),
    )
  }
  const signalCloseAt = localMarketTimeToUtcOption(signal.session_date, signal.close_time)
  if (signalCloseAt === undefined) {
    return Result.fail(
      cycleWindowFailure(
        'market-time',
        `${signal.session_date} ${signal.close_time} is not a valid ${cycleTimeZone} market time`,
        { sessionDate: signal.session_date, marketTime: signal.close_time, timeZone: cycleTimeZone },
      ),
    )
  }
  const submissionCutoffAt = new Date(
    Date.parse(calendar.executionOpenAt) - policy.submissionCutoffBeforeOpenMs,
  ).toISOString()
  const submissionOpenAt = new Date(Date.parse(submissionCutoffAt) - policy.submissionWindowMs).toISOString()
  if (submissionOpenAt <= signalCloseAt) {
    return Result.fail(
      cycleWindowFailure('submission-window', 'submission window must begin after the Signal session close', {
        signalCloseAt,
        submissionOpenAt,
      }),
    )
  }
  return Result.succeed({ signalCloseAt, submissionOpenAt, submissionCutoffAt })
}

const assembleCycleWindow = (
  input: DecodedCycleWindowInput,
  times: DerivedCycleWindowTimes,
): Result.Result<CycleWindow, CycleConstructionFailure> =>
  Result.mapError(
    decodeCycleWindowResult({
      schemaVersion: 'bayn.autonomous-cycle-window.v1',
      signalCalendarVersion: input.signal.calendar_version,
      signalSessionDate: input.signal.session_date,
      ...input.calendar,
      signalCloseAt: times.signalCloseAt,
      publicationDeadlineAt: times.submissionOpenAt,
      submissionOpenAt: times.submissionOpenAt,
      submissionCutoffAt: times.submissionCutoffAt,
    }),
    (cause) => cycleWindowFailure('decode', 'derived cycle window is invalid', {}, cause),
  )

export const makeCycleWindow = (
  signalSession: unknown,
  executionCalendar: unknown,
  executionPolicy: unknown,
): Result.Result<CycleWindow, CycleConstructionFailure> =>
  Result.flatMap(decodeCycleWindowInputs(signalSession, executionCalendar, executionPolicy), (input) =>
    Result.flatMap(validateCycleWindowDurations(input.policy), () =>
      Result.flatMap(deriveCycleWindowTimes(input), (times) => assembleCycleWindow(input, times)),
    ),
  )

export const makeCycleDraft = (
  identity: unknown,
  window: unknown,
): Result.Result<CycleDraft, CycleConstructionFailure> =>
  Result.flatMap(
    Result.mapError(decodeCycleIdentityResult(identity), (cause) =>
      cycleDraftFailure('decode', 'cycle identity is invalid', {}, cause),
    ),
    (decodedIdentity) =>
      Result.flatMap(
        Result.mapError(decodeCycleWindowResult(window), (cause) =>
          cycleDraftFailure('decode', 'cycle window is invalid', {}, cause),
        ),
        (decodedWindow) =>
          Result.mapError(
            decodeCycleDraftResult({
              schemaVersion: 'bayn.autonomous-cycle.v1',
              identity: decodedIdentity,
              window: decodedWindow,
            }),
            (cause) =>
              cycleDraftFailure(
                'binding',
                'cycle identity and window bindings are incoherent',
                {
                  cycleId: decodedIdentity.cycleId,
                  signalSessionDate: decodedWindow.signalSessionDate,
                  executionSessionDate: decodedWindow.executionSessionDate,
                },
                cause,
              ),
          ),
      ),
  )

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

export const cycleDraftMatches = (left: CycleDraft, right: CycleDraft): boolean => {
  const leftHash = canonicalHashResult(left)
  if (Result.isFailure(leftHash)) return false
  const rightHash = canonicalHashResult(right)
  return Result.isSuccess(rightHash) && leftHash.success === rightHash.success
}

export const decodeExecutionCalendarObservation = Schema.decodeUnknownEffect(
  ExecutionCalendarObservationSchema,
  strictParseOptions,
)
export const decodeCycleExecutionPolicy = Schema.decodeUnknownEffect(CycleExecutionPolicySchema, strictParseOptions)
export const decodeCycleIdentity = Schema.decodeUnknownEffect(CycleIdentitySchema, strictParseOptions)
export const decodeCycleWindow = Schema.decodeUnknownEffect(CycleWindowSchema, strictParseOptions)
export const decodeCycleDraft = Schema.decodeUnknownEffect(CycleDraftSchema, strictParseOptions)
export const decodeAutonomousCycle = Schema.decodeUnknownEffect(AutonomousCycleSchema, strictParseOptions)
