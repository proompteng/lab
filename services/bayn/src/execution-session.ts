import { Data, Result, Schema } from 'effect'

import type { MarketCalendarObservation } from './broker/alpaca'
import {
  AutonomousCycleSchema,
  isIntradayAutonomousCycle,
  isLegacyAutonomousCycle,
  makeExecutionCalendarObservation,
  type AutonomousCycle,
  type ExecutionCalendarObservation,
} from './cycle'
import { canonicalHashV1Result } from './hash'
import { CycleExecutionModelSchema, type CycleExecutionModel } from './execution-model-contract'
import { IsoDateSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from './schemas'
import { utcInstantFromEpochMillis } from './time'

const CalendarIdentitySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.alpaca-market-calendar-observation.v1'),
  source: Schema.Literal('alpaca-v2-calendar'),
  requestedRange: Schema.Struct({
    start: IsoDateSchema,
    end: IsoDateSchema,
  }),
  timeZone: Schema.Literal('UTC'),
  sessions: Schema.Array(
    Schema.Struct({
      date: IsoDateSchema,
      openAt: UtcInstantSchema,
      closeAt: UtcInstantSchema,
    }),
  ).check(Schema.isMinLength(1)),
  normalizedResponseHash: Sha256Schema,
})

const SignalBindingSchema = Schema.Struct({
  sessionDate: IsoDateSchema,
  finalizedAt: UtcInstantSchema,
  contentHash: Sha256Schema,
})

const PlanningBrokerStateBindingSchema = Schema.Struct({
  observedAt: UtcInstantSchema,
  contentHash: Sha256Schema,
})

const ExecutionSessionSchema = Schema.Struct({
  date: IsoDateSchema,
  openAt: UtcInstantSchema,
  closeAt: UtcInstantSchema,
})

const SubmissionCutoffLeadMinutesSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120 }))
const IntradayOrderOffsetMsSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400_000 }))

const ExecutionSessionBindingV1Base = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-session-binding.v1'),
  signal: SignalBindingSchema,
  planningBrokerState: PlanningBrokerStateBindingSchema,
  calendar: CalendarIdentitySchema,
  executionSession: ExecutionSessionSchema,
  submissionOpenAt: UtcInstantSchema,
  submissionCutoffAt: UtcInstantSchema,
  submissionCutoffLeadMinutes: SubmissionCutoffLeadMinutesSchema,
  bindingHash: Sha256Schema,
})

const ExecutionSessionBindingV2Base = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-session-binding.v2'),
  signal: SignalBindingSchema,
  planningBrokerState: PlanningBrokerStateBindingSchema,
  calendar: CalendarIdentitySchema,
  executionSession: ExecutionSessionSchema,
  submissionOpenAt: UtcInstantSchema,
  submissionCutoffAt: UtcInstantSchema,
  decisionAfterOpenMs: IntradayOrderOffsetMsSchema,
  submissionCutoffAfterOpenMs: IntradayOrderOffsetMsSchema,
  bindingHash: Sha256Schema,
})

const ExecutionSessionBindingV3Base = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-session-binding.v3'),
  planningBrokerState: PlanningBrokerStateBindingSchema,
  calendar: CalendarIdentitySchema,
  executionSession: ExecutionSessionSchema,
  submissionOpenAt: UtcInstantSchema,
  submissionCutoffAt: UtcInstantSchema,
  decisionAfterOpenMs: IntradayOrderOffsetMsSchema,
  submissionCutoffAfterOpenMs: IntradayOrderOffsetMsSchema,
  bindingHash: Sha256Schema,
})

interface BindExecutionSessionIssue {
  readonly operation: 'bind'
  readonly reason: 'decode' | 'hash'
}

interface BindCycleExecutionSessionIssue {
  readonly operation: 'bind-cycle'
  readonly reason: 'cycle-calendar' | 'cycle-policy' | 'cycle-window' | 'decode' | 'hash'
}

interface DeriveExecutionSessionWindowIssue {
  readonly operation: 'derive-window'
  readonly reason:
    | 'calendar-hash'
    | 'calendar-order'
    | 'calendar-session'
    | 'future-session'
    | 'hash'
    | 'range'
    | 'signal-finalization'
    | 'submission-window'
}

type ExecutionSessionBindingIssue =
  | BindExecutionSessionIssue
  | BindCycleExecutionSessionIssue
  | DeriveExecutionSessionWindowIssue

interface ExecutionSessionBindingFailureDetails {
  readonly message: string
  readonly facts: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}

const ExecutionSessionBindingFailure = Data.TaggedError('ExecutionSessionBindingFailure')<
  ExecutionSessionBindingIssue & ExecutionSessionBindingFailureDetails
>
export type ExecutionSessionBindingFailure = InstanceType<typeof ExecutionSessionBindingFailure>

type ExecutionSessionBindingReason<Operation extends ExecutionSessionBindingIssue['operation']> = Extract<
  ExecutionSessionBindingIssue,
  { readonly operation: Operation }
>['reason']

const bindFailure = (
  reason: ExecutionSessionBindingReason<'bind'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): ExecutionSessionBindingFailure =>
  new ExecutionSessionBindingFailure({ operation: 'bind', reason, message, facts, cause })

const bindCycleFailure = (
  reason: ExecutionSessionBindingReason<'bind-cycle'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): ExecutionSessionBindingFailure =>
  new ExecutionSessionBindingFailure({ operation: 'bind-cycle', reason, message, facts, cause })

const deriveWindowFailure = (
  reason: ExecutionSessionBindingReason<'derive-window'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): ExecutionSessionBindingFailure =>
  new ExecutionSessionBindingFailure({ operation: 'derive-window', reason, message, facts, cause })

type CalendarIdentity = typeof CalendarIdentitySchema.Type
type SignalBinding = typeof SignalBindingSchema.Type
type PlanningBrokerStateBinding = typeof PlanningBrokerStateBindingSchema.Type
type ExecutionSession = typeof ExecutionSessionSchema.Type

interface ExecutionSessionWindowInput {
  readonly signal: SignalBinding
  readonly planningBrokerState: PlanningBrokerStateBinding
  readonly calendar: CalendarIdentity
  readonly submissionCutoffLeadMinutes: number
}

interface IntradayExecutionSessionWindowInput {
  readonly executionSessionDate: string
  readonly planningBrokerState: PlanningBrokerStateBinding
  readonly calendar: CalendarIdentity
  readonly decisionAfterOpenMs: number
  readonly submissionCutoffAfterOpenMs: number
}

interface RollingIntradayExecutionSessionWindowInput {
  readonly executionSessionDate: string
  readonly planningBrokerState: PlanningBrokerStateBinding
  readonly calendar: CalendarIdentity
  readonly warmupAfterOpenMs: number
  readonly submissionCutoffBeforeCloseMs: number
}

interface LegacyIntradayExecutionSessionWindowInput {
  readonly signal: SignalBinding
  readonly planningBrokerState: PlanningBrokerStateBinding
  readonly calendar: CalendarIdentity
  readonly decisionAfterOpenMs: number
  readonly submissionCutoffAfterOpenMs: number
}

interface ExecutionSessionWindow {
  readonly executionSession: ExecutionSession
  readonly submissionOpenAt: string
  readonly submissionCutoffAt: string
}

const calendarObservationMaterial = (observation: CalendarIdentity) => ({
  schemaVersion: observation.schemaVersion,
  source: observation.source,
  requestedRange: observation.requestedRange,
  timeZone: observation.timeZone,
  sessions: observation.sessions,
})

const validateCalendarHash = (calendar: CalendarIdentity): Result.Result<void, ExecutionSessionBindingFailure> => {
  const observedCalendarHash = Result.mapError(canonicalHashV1Result(calendarObservationMaterial(calendar)), (cause) =>
    deriveWindowFailure('hash', 'Alpaca market calendar content is not canonicalizable', {}, cause),
  )
  if (Result.isFailure(observedCalendarHash)) return Result.fail(observedCalendarHash.failure)
  if (observedCalendarHash.success !== calendar.normalizedResponseHash) {
    return Result.fail(
      deriveWindowFailure(
        'calendar-hash',
        'Alpaca market calendar normalized response hash does not match its content',
        {
          expectedHash: observedCalendarHash.success,
          observedHash: calendar.normalizedResponseHash,
        },
      ),
    )
  }
  return Result.succeed(undefined)
}

const validateCalendarRangeAndSignal = (
  calendar: CalendarIdentity,
  signal: SignalBinding,
): Result.Result<void, ExecutionSessionBindingFailure> => {
  if (calendar.requestedRange.start > calendar.requestedRange.end) {
    return Result.fail(
      deriveWindowFailure('range', 'Alpaca market calendar request range must be ordered', {
        requestedRange: calendar.requestedRange,
      }),
    )
  }
  if (calendar.requestedRange.start > signal.sessionDate) {
    return Result.fail(
      deriveWindowFailure('range', 'Alpaca market calendar request must start on or before the signal session', {
        requestedRange: calendar.requestedRange,
        signalSessionDate: signal.sessionDate,
      }),
    )
  }
  if (signal.finalizedAt.slice(0, 10) < signal.sessionDate) {
    return Result.fail(
      deriveWindowFailure(
        'signal-finalization',
        'signal publication cannot be finalized before its declared signal session date exists',
        {
          finalizedAt: signal.finalizedAt,
          signalSessionDate: signal.sessionDate,
        },
      ),
    )
  }
  return Result.succeed(undefined)
}

const validateCalendarRangeAndExecutionSession = (
  calendar: CalendarIdentity,
  executionSessionDate: string,
): Result.Result<void, ExecutionSessionBindingFailure> => {
  if (calendar.requestedRange.start > calendar.requestedRange.end) {
    return Result.fail(
      deriveWindowFailure('range', 'Alpaca market calendar request range must be ordered', {
        requestedRange: calendar.requestedRange,
      }),
    )
  }
  if (executionSessionDate < calendar.requestedRange.start || executionSessionDate > calendar.requestedRange.end) {
    return Result.fail(
      deriveWindowFailure('range', 'intraday execution session must be within the requested calendar range', {
        executionSessionDate,
        requestedRange: calendar.requestedRange,
      }),
    )
  }
  return Result.succeed(undefined)
}

const validateCalendarSessions = (calendar: CalendarIdentity): Result.Result<void, ExecutionSessionBindingFailure> => {
  let previousDate: string | undefined
  for (const [index, session] of calendar.sessions.entries()) {
    if (
      session.date < calendar.requestedRange.start ||
      session.date > calendar.requestedRange.end ||
      session.openAt.slice(0, 10) !== session.date ||
      session.closeAt.slice(0, 10) !== session.date ||
      session.openAt >= session.closeAt
    ) {
      return Result.fail(
        deriveWindowFailure(
          'calendar-session',
          'Alpaca market calendar sessions must have ordered UTC hours on their declared date within the request',
          { index, session, requestedRange: calendar.requestedRange },
        ),
      )
    }
    if (previousDate !== undefined && previousDate >= session.date) {
      return Result.fail(
        deriveWindowFailure('calendar-order', 'Alpaca market calendar sessions must be unique and strictly ordered', {
          index,
          previousDate,
          date: session.date,
        }),
      )
    }
    previousDate = session.date
  }
  return Result.succeed(undefined)
}

const selectExecutionSession = (
  calendar: CalendarIdentity,
  signal: SignalBinding,
): Result.Result<ExecutionSession, ExecutionSessionBindingFailure> => {
  const executionSession = calendar.sessions.find((session) => session.date > signal.sessionDate)
  if (executionSession === undefined) {
    return Result.fail(
      deriveWindowFailure(
        'future-session',
        'Alpaca market calendar response does not contain a future execution session',
        { signalSessionDate: signal.sessionDate },
      ),
    )
  }
  return Result.succeed(executionSession)
}

const selectExactExecutionSession = (
  calendar: CalendarIdentity,
  executionSessionDate: string,
): Result.Result<ExecutionSession, ExecutionSessionBindingFailure> => {
  const executionSession = calendar.sessions.find((session) => session.date === executionSessionDate)
  if (executionSession === undefined) {
    return Result.fail(
      deriveWindowFailure('calendar-session', 'Alpaca market calendar does not contain the exact execution session', {
        executionSessionDate,
      }),
    )
  }
  return Result.succeed(executionSession)
}

const deriveSubmissionWindow = (
  executionSession: ExecutionSession,
  signal: SignalBinding,
  planningBrokerState: PlanningBrokerStateBinding,
  submissionCutoffLeadMinutes: number,
): Result.Result<Omit<ExecutionSessionWindow, 'executionSession'>, ExecutionSessionBindingFailure> => {
  const submissionOpenAt =
    signal.finalizedAt >= planningBrokerState.observedAt ? signal.finalizedAt : planningBrokerState.observedAt
  const submissionCutoffAt = utcInstantFromEpochMillis(
    Date.parse(executionSession.openAt) - submissionCutoffLeadMinutes * 60_000,
  )
  if (submissionOpenAt >= submissionCutoffAt || submissionCutoffAt >= executionSession.openAt) {
    return Result.fail(
      deriveWindowFailure(
        'submission-window',
        'execution-session binding must produce submissionOpenAt < submissionCutoffAt < executionSession.openAt',
        {
          executionOpenAt: executionSession.openAt,
          submissionCutoffAt,
          submissionOpenAt,
        },
      ),
    )
  }
  return Result.succeed({ submissionOpenAt, submissionCutoffAt })
}

const deriveExecutionSessionWindow = (
  input: ExecutionSessionWindowInput,
): Result.Result<ExecutionSessionWindow, ExecutionSessionBindingFailure> =>
  Result.flatMap(validateCalendarHash(input.calendar), () =>
    Result.flatMap(validateCalendarRangeAndSignal(input.calendar, input.signal), () =>
      Result.flatMap(validateCalendarSessions(input.calendar), () =>
        Result.flatMap(selectExecutionSession(input.calendar, input.signal), (executionSession) =>
          Result.map(
            deriveSubmissionWindow(
              executionSession,
              input.signal,
              input.planningBrokerState,
              input.submissionCutoffLeadMinutes,
            ),
            (submissionWindow) => ({ executionSession, ...submissionWindow }),
          ),
        ),
      ),
    ),
  )

const deriveIntradaySubmissionWindow = (
  executionSession: ExecutionSession,
  planningBrokerState: PlanningBrokerStateBinding,
  decisionAfterOpenMs: number,
  submissionCutoffAfterOpenMs: number,
): Result.Result<Omit<ExecutionSessionWindow, 'executionSession'>, ExecutionSessionBindingFailure> => {
  const configuredOpenMs = Date.parse(executionSession.openAt) + decisionAfterOpenMs
  const submissionOpenAt = utcInstantFromEpochMillis(
    Math.max(configuredOpenMs, Date.parse(planningBrokerState.observedAt)),
  )
  const submissionCutoffAt = utcInstantFromEpochMillis(
    Date.parse(executionSession.openAt) + submissionCutoffAfterOpenMs,
  )
  if (submissionOpenAt >= submissionCutoffAt || submissionCutoffAt >= executionSession.closeAt) {
    return Result.fail(
      deriveWindowFailure(
        'submission-window',
        'intraday execution-session binding must produce open < submissionOpenAt < submissionCutoffAt < close',
        {
          executionOpenAt: executionSession.openAt,
          executionCloseAt: executionSession.closeAt,
          submissionOpenAt,
          submissionCutoffAt,
        },
      ),
    )
  }
  return Result.succeed({ submissionOpenAt, submissionCutoffAt })
}

const deriveIntradayExecutionSessionWindow = (
  input: IntradayExecutionSessionWindowInput,
): Result.Result<ExecutionSessionWindow, ExecutionSessionBindingFailure> =>
  Result.flatMap(validateCalendarHash(input.calendar), () =>
    Result.flatMap(validateCalendarRangeAndExecutionSession(input.calendar, input.executionSessionDate), () =>
      Result.flatMap(validateCalendarSessions(input.calendar), () =>
        Result.flatMap(selectExactExecutionSession(input.calendar, input.executionSessionDate), (executionSession) =>
          Result.map(
            deriveIntradaySubmissionWindow(
              executionSession,
              input.planningBrokerState,
              input.decisionAfterOpenMs,
              input.submissionCutoffAfterOpenMs,
            ),
            (submissionWindow) => ({ executionSession, ...submissionWindow }),
          ),
        ),
      ),
    ),
  )

const deriveRollingIntradayExecutionSessionWindow = (
  input: RollingIntradayExecutionSessionWindowInput,
): Result.Result<ExecutionSessionWindow, ExecutionSessionBindingFailure> =>
  Result.flatMap(validateCalendarHash(input.calendar), () =>
    Result.flatMap(validateCalendarRangeAndExecutionSession(input.calendar, input.executionSessionDate), () =>
      Result.flatMap(validateCalendarSessions(input.calendar), () =>
        Result.flatMap(selectExactExecutionSession(input.calendar, input.executionSessionDate), (executionSession) => {
          const submissionCutoffAfterOpenMs =
            Date.parse(executionSession.closeAt) -
            Date.parse(executionSession.openAt) -
            input.submissionCutoffBeforeCloseMs
          return Result.map(
            deriveIntradaySubmissionWindow(
              executionSession,
              input.planningBrokerState,
              input.warmupAfterOpenMs,
              submissionCutoffAfterOpenMs,
            ),
            (submissionWindow) => ({ executionSession, ...submissionWindow }),
          )
        }),
      ),
    ),
  )

const deriveLegacyIntradayExecutionSessionWindow = (
  input: LegacyIntradayExecutionSessionWindowInput,
): Result.Result<ExecutionSessionWindow, ExecutionSessionBindingFailure> =>
  Result.flatMap(validateCalendarHash(input.calendar), () =>
    Result.flatMap(validateCalendarRangeAndSignal(input.calendar, input.signal), () =>
      Result.flatMap(validateCalendarSessions(input.calendar), () =>
        Result.flatMap(selectExecutionSession(input.calendar, input.signal), (executionSession) =>
          Result.map(
            deriveIntradaySubmissionWindow(
              executionSession,
              input.planningBrokerState,
              input.decisionAfterOpenMs,
              input.submissionCutoffAfterOpenMs,
            ),
            (submissionWindow) => ({ executionSession, ...submissionWindow }),
          ),
        ),
      ),
    ),
  )

const bindingHashIssues = (
  binding:
    | typeof ExecutionSessionBindingV1Base.Type
    | typeof ExecutionSessionBindingV2Base.Type
    | typeof ExecutionSessionBindingV3Base.Type,
): readonly Schema.FilterIssue[] => {
  const { bindingHash, ...material } = binding
  const expectedBindingHash = canonicalHashV1Result(material)
  if (Result.isFailure(expectedBindingHash)) {
    return [{ path: ['bindingHash'], issue: 'execution-session material must be canonicalizable' }]
  }
  return bindingHash === expectedBindingHash.success
    ? []
    : [{ path: ['bindingHash'], issue: 'must match the causal execution-session material' }]
}

const dailyBindingIssues = (binding: typeof ExecutionSessionBindingV1Base.Type): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  const derived = deriveExecutionSessionWindow({
    signal: binding.signal,
    planningBrokerState: binding.planningBrokerState,
    calendar: binding.calendar,
    submissionCutoffLeadMinutes: binding.submissionCutoffLeadMinutes,
  })
  if (Result.isFailure(derived)) {
    issues.push({ path: ['calendar'], issue: derived.failure.message })
  } else {
    const expected = derived.success
    if (
      expected.executionSession.date !== binding.executionSession.date ||
      expected.executionSession.openAt !== binding.executionSession.openAt ||
      expected.executionSession.closeAt !== binding.executionSession.closeAt
    ) {
      issues.push({
        path: ['executionSession'],
        issue: 'must be the first post-signal session in the supplied normalized calendar observation',
      })
    }
    if (binding.submissionOpenAt !== expected.submissionOpenAt) {
      issues.push({
        path: ['submissionOpenAt'],
        issue: 'must equal the later of finalized signal data and reconciled planning broker state',
      })
    }
    if (binding.submissionCutoffAt !== expected.submissionCutoffAt) {
      issues.push({
        path: ['submissionCutoffAt'],
        issue: 'must equal execution open minus the declared fixed cutoff lead',
      })
    }
  }
  return [...issues, ...bindingHashIssues(binding)]
}

const legacyIntradayBindingIssues = (
  binding: typeof ExecutionSessionBindingV2Base.Type,
): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  const derived = deriveLegacyIntradayExecutionSessionWindow({
    signal: binding.signal,
    planningBrokerState: binding.planningBrokerState,
    calendar: binding.calendar,
    decisionAfterOpenMs: binding.decisionAfterOpenMs,
    submissionCutoffAfterOpenMs: binding.submissionCutoffAfterOpenMs,
  })
  if (Result.isFailure(derived)) {
    issues.push({ path: ['calendar'], issue: derived.failure.message })
  } else {
    const expected = derived.success
    if (
      expected.executionSession.date !== binding.executionSession.date ||
      expected.executionSession.openAt !== binding.executionSession.openAt ||
      expected.executionSession.closeAt !== binding.executionSession.closeAt
    ) {
      issues.push({ path: ['executionSession'], issue: 'must be the first post-signal exchange session' })
    }
    if (binding.submissionOpenAt !== expected.submissionOpenAt) {
      issues.push({
        path: ['submissionOpenAt'],
        issue: 'must equal the later of the decision offset and reconciled planning broker state',
      })
    }
    if (binding.submissionCutoffAt !== expected.submissionCutoffAt) {
      issues.push({ path: ['submissionCutoffAt'], issue: 'must equal execution open plus the entry cutoff offset' })
    }
  }
  return [...issues, ...bindingHashIssues(binding)]
}

const intradayBindingIssues = (binding: typeof ExecutionSessionBindingV3Base.Type): readonly Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = []
  const derived = deriveIntradayExecutionSessionWindow({
    executionSessionDate: binding.executionSession.date,
    planningBrokerState: binding.planningBrokerState,
    calendar: binding.calendar,
    decisionAfterOpenMs: binding.decisionAfterOpenMs,
    submissionCutoffAfterOpenMs: binding.submissionCutoffAfterOpenMs,
  })
  if (Result.isFailure(derived)) {
    issues.push({ path: ['calendar'], issue: derived.failure.message })
  } else {
    const expected = derived.success
    if (
      expected.executionSession.date !== binding.executionSession.date ||
      expected.executionSession.openAt !== binding.executionSession.openAt ||
      expected.executionSession.closeAt !== binding.executionSession.closeAt
    ) {
      issues.push({ path: ['executionSession'], issue: 'must be the exact requested execution session' })
    }
    if (binding.submissionOpenAt !== expected.submissionOpenAt) {
      issues.push({
        path: ['submissionOpenAt'],
        issue: 'must equal the later of the decision offset and reconciled planning broker state',
      })
    }
    if (binding.submissionCutoffAt !== expected.submissionCutoffAt) {
      issues.push({ path: ['submissionCutoffAt'], issue: 'must equal execution open plus the entry cutoff offset' })
    }
  }
  return [...issues, ...bindingHashIssues(binding)]
}

const ExecutionSessionBindingV1Schema = ExecutionSessionBindingV1Base.check(Schema.makeFilter(dailyBindingIssues))
const ExecutionSessionBindingV2Schema = ExecutionSessionBindingV2Base.check(
  Schema.makeFilter(legacyIntradayBindingIssues),
)
const ExecutionSessionBindingV3Schema = ExecutionSessionBindingV3Base.check(Schema.makeFilter(intradayBindingIssues))

export const ExecutionSessionBindingSchema = Schema.Union([
  ExecutionSessionBindingV1Schema,
  ExecutionSessionBindingV2Schema,
  ExecutionSessionBindingV3Schema,
])
export type ExecutionSessionBinding = typeof ExecutionSessionBindingSchema.Type

interface BindExecutionSessionCommonInput {
  readonly planningBrokerState: {
    readonly observedAt: string
    readonly contentHash: string
  }
  readonly calendar: MarketCalendarObservation
}

export interface BindLegacyExecutionSessionInput extends BindExecutionSessionCommonInput {
  readonly signal: {
    readonly sessionDate: string
    readonly finalizedAt: string
    readonly contentHash: string
  }
  readonly executionModel: CycleExecutionModel
}

export interface BindIntradayExecutionSessionInput extends BindExecutionSessionCommonInput {
  readonly executionSessionDate: string
  readonly executionModel: CycleExecutionModel
}

export type BindExecutionSessionInput = BindLegacyExecutionSessionInput | BindIntradayExecutionSessionInput

export type BindCycleExecutionSessionInput = BindExecutionSessionInput & {
  readonly cycle: AutonomousCycle
}

const BindLegacyExecutionSessionInputSchema = Schema.Struct({
  signal: SignalBindingSchema,
  planningBrokerState: PlanningBrokerStateBindingSchema,
  calendar: CalendarIdentitySchema,
  executionModel: CycleExecutionModelSchema,
})

const BindIntradayExecutionSessionInputSchema = Schema.Struct({
  executionSessionDate: IsoDateSchema,
  planningBrokerState: PlanningBrokerStateBindingSchema,
  calendar: CalendarIdentitySchema,
  executionModel: CycleExecutionModelSchema,
})

const BindExecutionSessionInputSchema = Schema.Union([
  BindLegacyExecutionSessionInputSchema,
  BindIntradayExecutionSessionInputSchema,
])

const BindCycleExecutionSessionInputSchema = Schema.Union([
  Schema.Struct({ ...BindLegacyExecutionSessionInputSchema.fields, cycle: AutonomousCycleSchema }),
  Schema.Struct({ ...BindIntradayExecutionSessionInputSchema.fields, cycle: AutonomousCycleSchema }),
])

type DecodedBindExecutionSessionInput = typeof BindExecutionSessionInputSchema.Type
type DecodedBindCycleExecutionSessionInput = typeof BindCycleExecutionSessionInputSchema.Type

const decodeBindExecutionSessionInputResult = Schema.decodeUnknownResult(
  BindExecutionSessionInputSchema,
  strictParseOptions,
)
const decodeBindCycleExecutionSessionInputResult = Schema.decodeUnknownResult(
  BindCycleExecutionSessionInputSchema,
  strictParseOptions,
)
const decodeExecutionSessionBindingResult = Schema.decodeUnknownResult(
  ExecutionSessionBindingSchema,
  strictParseOptions,
)

const bindDecodedExecutionSession = (
  input: DecodedBindExecutionSessionInput,
): Result.Result<ExecutionSessionBinding, ExecutionSessionBindingFailure> => {
  if ('executionSessionDate' in input) {
    if (
      input.executionModel.schemaVersion !== 'bayn.execution-model.v4' &&
      input.executionModel.schemaVersion !== 'bayn.execution-model.v5'
    ) {
      return Result.fail(bindFailure('decode', 'an exact execution session requires the intraday execution model'))
    }
    const executionModel = input.executionModel
    return Result.flatMap(
      executionModel.schemaVersion === 'bayn.execution-model.v4'
        ? deriveIntradayExecutionSessionWindow({
            executionSessionDate: input.executionSessionDate,
            planningBrokerState: input.planningBrokerState,
            calendar: input.calendar,
            decisionAfterOpenMs: executionModel.order.decisionAfterOpenMs,
            submissionCutoffAfterOpenMs: executionModel.order.submissionCutoffAfterOpenMs,
          })
        : deriveRollingIntradayExecutionSessionWindow({
            executionSessionDate: input.executionSessionDate,
            planningBrokerState: input.planningBrokerState,
            calendar: input.calendar,
            warmupAfterOpenMs: executionModel.order.warmupAfterOpenMs,
            submissionCutoffBeforeCloseMs: executionModel.order.submissionCutoffBeforeCloseMs,
          }),
      (window) => {
        const decisionAfterOpenMs =
          executionModel.schemaVersion === 'bayn.execution-model.v4'
            ? executionModel.order.decisionAfterOpenMs
            : executionModel.order.warmupAfterOpenMs
        const submissionCutoffAfterOpenMs =
          executionModel.schemaVersion === 'bayn.execution-model.v4'
            ? executionModel.order.submissionCutoffAfterOpenMs
            : Date.parse(window.executionSession.closeAt) -
              Date.parse(window.executionSession.openAt) -
              executionModel.order.submissionCutoffBeforeCloseMs
        const material = {
          schemaVersion: 'bayn.execution-session-binding.v3',
          planningBrokerState: input.planningBrokerState,
          calendar: input.calendar,
          ...window,
          decisionAfterOpenMs,
          submissionCutoffAfterOpenMs,
        } as const
        return Result.flatMap(
          Result.mapError(canonicalHashV1Result(material), (cause) =>
            bindFailure('hash', 'execution-session binding material is not canonicalizable', {}, cause),
          ),
          (bindingHash) =>
            Result.mapError(decodeExecutionSessionBindingResult({ ...material, bindingHash }), (cause) =>
              bindFailure('decode', 'derived execution-session binding is invalid', {}, cause),
            ),
        )
      },
    )
  }
  if (input.executionModel.schemaVersion === 'bayn.execution-model.v4') {
    const executionModel = input.executionModel
    return Result.flatMap(
      deriveLegacyIntradayExecutionSessionWindow({
        signal: input.signal,
        planningBrokerState: input.planningBrokerState,
        calendar: input.calendar,
        decisionAfterOpenMs: executionModel.order.decisionAfterOpenMs,
        submissionCutoffAfterOpenMs: executionModel.order.submissionCutoffAfterOpenMs,
      }),
      (window) => {
        const material = {
          schemaVersion: 'bayn.execution-session-binding.v2',
          signal: input.signal,
          planningBrokerState: input.planningBrokerState,
          calendar: input.calendar,
          ...window,
          decisionAfterOpenMs: executionModel.order.decisionAfterOpenMs,
          submissionCutoffAfterOpenMs: executionModel.order.submissionCutoffAfterOpenMs,
        } as const
        return Result.flatMap(
          Result.mapError(canonicalHashV1Result(material), (cause) =>
            bindFailure('hash', 'execution-session binding material is not canonicalizable', {}, cause),
          ),
          (bindingHash) =>
            Result.mapError(decodeExecutionSessionBindingResult({ ...material, bindingHash }), (cause) =>
              bindFailure('decode', 'derived execution-session binding is invalid', {}, cause),
            ),
        )
      },
    )
  }
  if (input.executionModel.schemaVersion === 'bayn.execution-model.v5') {
    return Result.fail(bindFailure('decode', 'rolling intraday execution requires an exact execution session'))
  }
  const executionModel = input.executionModel
  return Result.flatMap(
    deriveExecutionSessionWindow({
      signal: input.signal,
      planningBrokerState: input.planningBrokerState,
      calendar: input.calendar,
      submissionCutoffLeadMinutes: executionModel.order.submissionCutoffLeadMinutes,
    }),
    (window) => {
      const material = {
        schemaVersion: 'bayn.execution-session-binding.v1',
        signal: input.signal,
        planningBrokerState: input.planningBrokerState,
        calendar: input.calendar,
        ...window,
        submissionCutoffLeadMinutes: executionModel.order.submissionCutoffLeadMinutes,
      } as const
      return Result.flatMap(
        Result.mapError(canonicalHashV1Result(material), (cause) =>
          bindFailure('hash', 'execution-session binding material is not canonicalizable', {}, cause),
        ),
        (bindingHash) =>
          Result.mapError(decodeExecutionSessionBindingResult({ ...material, bindingHash }), (cause) =>
            bindFailure('decode', 'derived execution-session binding is invalid', {}, cause),
          ),
      )
    },
  )
}

export const bindExecutionSession = (
  input: unknown,
): Result.Result<ExecutionSessionBinding, ExecutionSessionBindingFailure> =>
  Result.flatMap(
    Result.mapError(decodeBindExecutionSessionInputResult(input), (cause) =>
      bindFailure('decode', 'execution-session binding input is invalid', {}, cause),
    ),
    bindDecodedExecutionSession,
  )

const makeSelectedCycleCalendar = (
  binding: ExecutionSessionBinding,
): Result.Result<ExecutionCalendarObservation, ExecutionSessionBindingFailure> =>
  Result.mapError(
    makeExecutionCalendarObservation({
      schemaVersion: binding.calendar.schemaVersion,
      source: binding.calendar.source,
      ...binding.executionSession,
    }),
    (cause) =>
      bindCycleFailure(
        'cycle-calendar',
        'execution-session binding selected an invalid durable cycle calendar',
        {},
        cause,
      ),
  )

const validateCycleCalendar = (
  binding: ExecutionSessionBinding,
  cycle: AutonomousCycle,
  selected: ExecutionCalendarObservation,
): Result.Result<void, ExecutionSessionBindingFailure> => {
  const commonFacts = [
    {
      field: 'executionSessionDate',
      expected: cycle.window.executionSessionDate,
      observed: binding.executionSession.date,
    },
    {
      field: 'executionOpenAt',
      expected: cycle.window.executionOpenAt,
      observed: binding.executionSession.openAt,
    },
    {
      field: 'executionCloseAt',
      expected: cycle.window.executionCloseAt,
      observed: binding.executionSession.closeAt,
    },
    {
      field: 'executionCalendarSchemaVersion',
      expected: cycle.window.executionCalendarSchemaVersion,
      observed: selected.executionCalendarSchemaVersion,
    },
    {
      field: 'executionCalendarSource',
      expected: cycle.window.executionCalendarSource,
      observed: selected.executionCalendarSource,
    },
    {
      field: 'executionCalendarHash',
      expected: cycle.window.executionCalendarHash,
      observed: selected.executionCalendarHash,
    },
  ]
  const signalFacts =
    isLegacyAutonomousCycle(cycle) && 'signal' in binding
      ? [
          {
            field: 'signalSessionDate',
            expected: cycle.identity.signalSessionDate,
            observed: binding.signal.sessionDate,
          },
        ]
      : []
  if (
    (isLegacyAutonomousCycle(cycle) &&
      ((cycle.identity.executionPolicy.schemaVersion === 'bayn.autonomous-cycle-execution-policy.v1' &&
        binding.schemaVersion !== 'bayn.execution-session-binding.v1') ||
        (cycle.identity.executionPolicy.schemaVersion === 'bayn.autonomous-cycle-execution-policy.v2' &&
          binding.schemaVersion !== 'bayn.execution-session-binding.v2'))) ||
    (isIntradayAutonomousCycle(cycle) && binding.schemaVersion !== 'bayn.execution-session-binding.v3')
  ) {
    return Result.fail(
      bindCycleFailure('cycle-calendar', 'execution-session binding version does not match the cycle contract', {
        cycleId: cycle.identity.cycleId,
        cycleSchemaVersion: cycle.schemaVersion,
        bindingSchemaVersion: binding.schemaVersion,
      }),
    )
  }
  const mismatch = [...signalFacts, ...commonFacts].find(({ expected, observed }) => expected !== observed)
  if (mismatch !== undefined) {
    return Result.fail(
      bindCycleFailure('cycle-calendar', 'execution-session binding does not match the durable cycle calendar', {
        cycleId: cycle.identity.cycleId,
        ...mismatch,
      }),
    )
  }
  return Result.succeed(undefined)
}

const validateCycleSignalFinalization = (
  binding: ExecutionSessionBinding,
  cycle: AutonomousCycle,
): Result.Result<void, ExecutionSessionBindingFailure> => {
  if (!isLegacyAutonomousCycle(cycle) || !('signal' in binding)) {
    return Result.succeed(undefined)
  }
  if (binding.signal.finalizedAt < cycle.window.signalCloseAt) {
    return Result.fail(
      bindCycleFailure(
        'cycle-window',
        'cycle execution-session signal finalization cannot precede the durable signal close',
        {
          cycleId: cycle.identity.cycleId,
          expectedMinimumSignalFinalizedAt: cycle.window.signalCloseAt,
          observedSignalFinalizedAt: binding.signal.finalizedAt,
        },
      ),
    )
  }
  return Result.succeed(undefined)
}

const validateCycleExecutionPolicy = (
  input: DecodedBindCycleExecutionSessionInput,
  binding: ExecutionSessionBinding,
): Result.Result<void, ExecutionSessionBindingFailure> => {
  const expectedPolicyVersion =
    input.executionModel.schemaVersion === 'bayn.execution-model.v5'
      ? 'bayn.autonomous-cycle-execution-policy.v3'
      : input.executionModel.schemaVersion === 'bayn.execution-model.v4'
        ? 'bayn.autonomous-cycle-execution-policy.v2'
        : 'bayn.autonomous-cycle-execution-policy.v1'
  if (input.cycle.identity.executionPolicy.schemaVersion !== expectedPolicyVersion) {
    return Result.fail(
      bindCycleFailure('cycle-policy', 'execution-session binding and cycle policy versions do not match', {
        cycleId: input.cycle.identity.cycleId,
        executionPolicySchemaVersion: input.cycle.identity.executionPolicy.schemaVersion,
        executionModelSchemaVersion: input.executionModel.schemaVersion,
      }),
    )
  }
  const executionModelHash = Result.mapError(canonicalHashV1Result(input.executionModel), (cause) =>
    bindCycleFailure(
      'hash',
      'execution model is not canonicalizable',
      { cycleId: input.cycle.identity.cycleId },
      cause,
    ),
  )
  if (Result.isFailure(executionModelHash)) return Result.fail(executionModelHash.failure)
  if (executionModelHash.success !== input.cycle.identity.executionPolicy.strategyExecutionModelHash) {
    return Result.fail(
      bindCycleFailure('cycle-policy', 'execution-session binding does not match the durable cycle execution policy', {
        cycleId: input.cycle.identity.cycleId,
        field: 'strategyExecutionModelHash',
        expected: input.cycle.identity.executionPolicy.strategyExecutionModelHash,
        observed: executionModelHash.success,
      }),
    )
  }
  if (
    (binding.schemaVersion === 'bayn.execution-session-binding.v2' ||
      binding.schemaVersion === 'bayn.execution-session-binding.v3') &&
    input.executionModel.schemaVersion === 'bayn.execution-model.v4' &&
    input.cycle.identity.executionPolicy.schemaVersion === 'bayn.autonomous-cycle-execution-policy.v2'
  ) {
    const policyDecisionAfterOpenMs =
      input.cycle.identity.executionPolicy.submissionCutoffAfterOpenMs -
      input.cycle.identity.executionPolicy.submissionWindowMs
    const mismatch = [
      {
        field: 'decisionAfterOpenMs',
        expected: policyDecisionAfterOpenMs,
        observed: binding.decisionAfterOpenMs,
      },
      {
        field: 'submissionCutoffAfterOpenMs',
        expected: input.cycle.identity.executionPolicy.submissionCutoffAfterOpenMs,
        observed: binding.submissionCutoffAfterOpenMs,
      },
    ].find(({ expected, observed }) => expected !== observed)
    if (mismatch !== undefined) {
      return Result.fail(
        bindCycleFailure(
          'cycle-policy',
          'execution-session binding does not match the durable cycle execution policy',
          {
            cycleId: input.cycle.identity.cycleId,
            ...mismatch,
          },
        ),
      )
    }
  } else if (
    binding.schemaVersion === 'bayn.execution-session-binding.v3' &&
    input.executionModel.schemaVersion === 'bayn.execution-model.v5' &&
    input.cycle.identity.executionPolicy.schemaVersion === 'bayn.autonomous-cycle-execution-policy.v3'
  ) {
    const observedCutoffBeforeCloseMs =
      Date.parse(binding.executionSession.closeAt) -
      Date.parse(binding.executionSession.openAt) -
      binding.submissionCutoffAfterOpenMs
    const mismatch = [
      {
        field: 'warmupAfterOpenMs',
        expected: input.cycle.identity.executionPolicy.warmupAfterOpenMs,
        observed: binding.decisionAfterOpenMs,
      },
      {
        field: 'submissionCutoffBeforeCloseMs',
        expected: input.cycle.identity.executionPolicy.submissionCutoffBeforeCloseMs,
        observed: observedCutoffBeforeCloseMs,
      },
    ].find(({ expected, observed }) => expected !== observed)
    if (mismatch !== undefined) {
      return Result.fail(
        bindCycleFailure(
          'cycle-policy',
          'execution-session binding does not match the durable cycle execution policy',
          { cycleId: input.cycle.identity.cycleId, ...mismatch },
        ),
      )
    }
  } else if (
    binding.schemaVersion === 'bayn.execution-session-binding.v1' &&
    input.executionModel.schemaVersion !== 'bayn.execution-model.v4' &&
    input.executionModel.schemaVersion !== 'bayn.execution-model.v5' &&
    input.cycle.identity.executionPolicy.schemaVersion === 'bayn.autonomous-cycle-execution-policy.v1'
  ) {
    const observed = binding.submissionCutoffLeadMinutes * 60_000
    const expected = input.cycle.identity.executionPolicy.submissionCutoffBeforeOpenMs
    if (observed !== expected) {
      return Result.fail(
        bindCycleFailure(
          'cycle-policy',
          'execution-session binding does not match the durable cycle execution policy',
          {
            cycleId: input.cycle.identity.cycleId,
            field: 'submissionCutoffBeforeOpenMs',
            expected,
            observed,
          },
        ),
      )
    }
  } else {
    return Result.fail(
      bindCycleFailure('cycle-policy', 'execution-session binding does not match the durable cycle execution policy', {
        cycleId: input.cycle.identity.cycleId,
        field: 'submission-offset-schema',
      }),
    )
  }
  if (binding.submissionCutoffAt !== input.cycle.window.submissionCutoffAt) {
    return Result.fail(
      bindCycleFailure('cycle-policy', 'execution-session binding does not match the durable cycle execution policy', {
        cycleId: input.cycle.identity.cycleId,
        field: 'submissionCutoffAt',
        expected: input.cycle.window.submissionCutoffAt,
        observed: binding.submissionCutoffAt,
      }),
    )
  }
  return Result.succeed(undefined)
}

const validateCycleSubmissionWindow = (
  cycle: AutonomousCycle,
  binding: ExecutionSessionBinding,
): Result.Result<void, ExecutionSessionBindingFailure> => {
  if (binding.submissionOpenAt < cycle.window.submissionOpenAt) {
    return Result.fail(
      bindCycleFailure('cycle-window', 'execution-session binding cannot widen the durable cycle submission window', {
        cycleId: cycle.identity.cycleId,
        expectedMinimumSubmissionOpenAt: cycle.window.submissionOpenAt,
        observedSubmissionOpenAt: binding.submissionOpenAt,
      }),
    )
  }
  return Result.succeed(undefined)
}

const bindDecodedCycleExecutionSession = (
  input: DecodedBindCycleExecutionSessionInput,
): Result.Result<ExecutionSessionBinding, ExecutionSessionBindingFailure> =>
  Result.flatMap(bindDecodedExecutionSession(input), (binding) =>
    Result.flatMap(makeSelectedCycleCalendar(binding), (selected) =>
      Result.flatMap(validateCycleCalendar(binding, input.cycle, selected), () =>
        Result.flatMap(validateCycleSignalFinalization(binding, input.cycle), () =>
          Result.flatMap(validateCycleExecutionPolicy(input, binding), () =>
            Result.map(validateCycleSubmissionWindow(input.cycle, binding), () => binding),
          ),
        ),
      ),
    ),
  )

export const bindCycleExecutionSession = (
  input: unknown,
): Result.Result<ExecutionSessionBinding, ExecutionSessionBindingFailure> =>
  Result.flatMap(
    Result.mapError(decodeBindCycleExecutionSessionInputResult(input), (cause) =>
      bindCycleFailure('decode', 'cycle execution-session binding input is invalid', {}, cause),
    ),
    bindDecodedCycleExecutionSession,
  )
