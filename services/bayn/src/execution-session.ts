import { Data, Result, Schema } from 'effect'

import type { MarketCalendarObservation } from './broker/alpaca'
import {
  AutonomousCycleSchema,
  makeExecutionCalendarObservation,
  type AutonomousCycle,
  type ExecutionCalendarObservation,
} from './cycle'
import { canonicalHashV1 } from './hash'
import { ExecutionModelV2Schema, type ExecutionModel } from './protocol'
import { IsoDateSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from './schemas'

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

const ExecutionSessionBindingBase = Schema.Struct({
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
  const observedCalendarHash = Result.try({
    try: () => canonicalHashV1(calendarObservationMaterial(calendar)),
    catch: (cause) => deriveWindowFailure('hash', 'Alpaca market calendar content is not canonicalizable', {}, cause),
  })
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

const validateCalendarSessions = (calendar: CalendarIdentity): Result.Result<void, ExecutionSessionBindingFailure> => {
  for (let index = 0; index < calendar.sessions.length; index += 1) {
    const session = calendar.sessions[index]
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
    if (index > 0 && calendar.sessions[index - 1].date >= session.date) {
      return Result.fail(
        deriveWindowFailure('calendar-order', 'Alpaca market calendar sessions must be unique and strictly ordered', {
          index,
          previousDate: calendar.sessions[index - 1].date,
          date: session.date,
        }),
      )
    }
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

const deriveSubmissionWindow = (
  executionSession: ExecutionSession,
  signal: SignalBinding,
  planningBrokerState: PlanningBrokerStateBinding,
  submissionCutoffLeadMinutes: number,
): Result.Result<Omit<ExecutionSessionWindow, 'executionSession'>, ExecutionSessionBindingFailure> => {
  const submissionOpenAt =
    signal.finalizedAt >= planningBrokerState.observedAt ? signal.finalizedAt : planningBrokerState.observedAt
  const submissionCutoffAt = new Date(
    Date.parse(executionSession.openAt) - submissionCutoffLeadMinutes * 60_000,
  ).toISOString()
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

const bindingIssues = (binding: typeof ExecutionSessionBindingBase.Type): readonly Schema.FilterIssue[] => {
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
  const { bindingHash, ...material } = binding
  const expectedBindingHash = Result.try(() => canonicalHashV1(material))
  if (Result.isFailure(expectedBindingHash)) {
    issues.push({ path: ['bindingHash'], issue: 'execution-session material must be canonicalizable' })
  } else if (bindingHash !== expectedBindingHash.success) {
    issues.push({ path: ['bindingHash'], issue: 'must match the causal execution-session material' })
  }
  return issues
}

export const ExecutionSessionBindingSchema = ExecutionSessionBindingBase.check(Schema.makeFilter(bindingIssues))
export type ExecutionSessionBinding = typeof ExecutionSessionBindingSchema.Type

export interface BindExecutionSessionInput {
  readonly signal: {
    readonly sessionDate: string
    readonly finalizedAt: string
    readonly contentHash: string
  }
  readonly planningBrokerState: {
    readonly observedAt: string
    readonly contentHash: string
  }
  readonly calendar: MarketCalendarObservation
  readonly executionModel: ExecutionModel
}

export interface BindCycleExecutionSessionInput extends BindExecutionSessionInput {
  readonly cycle: AutonomousCycle
}

const BindExecutionSessionInputSchema = Schema.Struct({
  signal: SignalBindingSchema,
  planningBrokerState: PlanningBrokerStateBindingSchema,
  calendar: CalendarIdentitySchema,
  executionModel: ExecutionModelV2Schema,
})

const BindCycleExecutionSessionInputSchema = Schema.Struct({
  ...BindExecutionSessionInputSchema.fields,
  cycle: AutonomousCycleSchema,
})

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
): Result.Result<ExecutionSessionBinding, ExecutionSessionBindingFailure> =>
  Result.flatMap(
    deriveExecutionSessionWindow({
      signal: input.signal,
      planningBrokerState: input.planningBrokerState,
      calendar: input.calendar,
      submissionCutoffLeadMinutes: input.executionModel.order.submissionCutoffLeadMinutes,
    }),
    (derived) => {
      const material = {
        schemaVersion: 'bayn.execution-session-binding.v1',
        signal: input.signal,
        planningBrokerState: input.planningBrokerState,
        calendar: input.calendar,
        ...derived,
        submissionCutoffLeadMinutes: input.executionModel.order.submissionCutoffLeadMinutes,
      } as const
      return Result.flatMap(
        Result.try({
          try: () => ({ ...material, bindingHash: canonicalHashV1(material) }),
          catch: (cause) => bindFailure('hash', 'execution-session binding material is not canonicalizable', {}, cause),
        }),
        (binding) =>
          Result.mapError(decodeExecutionSessionBindingResult(binding), (cause) =>
            bindFailure('decode', 'derived execution-session binding is invalid', {}, cause),
          ),
      )
    },
  )

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
  const mismatch = [
    {
      field: 'signalSessionDate',
      expected: cycle.identity.signalSessionDate,
      observed: binding.signal.sessionDate,
    },
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
  ].find(({ expected, observed }) => expected !== observed)
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
  const executionModelHash = Result.try({
    try: () => canonicalHashV1(input.executionModel),
    catch: (cause) =>
      bindCycleFailure(
        'hash',
        'execution model is not canonicalizable',
        { cycleId: input.cycle.identity.cycleId },
        cause,
      ),
  })
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
  const observedCutoffLeadMs = binding.submissionCutoffLeadMinutes * 60_000
  if (observedCutoffLeadMs !== input.cycle.identity.executionPolicy.submissionCutoffBeforeOpenMs) {
    return Result.fail(
      bindCycleFailure('cycle-policy', 'execution-session binding does not match the durable cycle execution policy', {
        cycleId: input.cycle.identity.cycleId,
        field: 'submissionCutoffBeforeOpenMs',
        expected: input.cycle.identity.executionPolicy.submissionCutoffBeforeOpenMs,
        observed: observedCutoffLeadMs,
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
