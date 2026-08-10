import { Data, DateTime, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { ExecutionModelV2Schema } from '../protocol'
import { strictParseOptions } from '../schemas'
import { utcInstantFromEpochMillis } from '../time'
import {
  cycleTimeZone,
  decodeCycleDraftResult,
  decodeCycleExecutionPolicyMaterialResult,
  decodeCycleExecutionPolicyResult,
  decodeCycleIdentityMaterialResult,
  decodeCycleIdentityResult,
  decodeCycleWindowPolicyInputResult,
  decodeCycleWindowResult,
  decodeExecutionCalendarMaterialResult,
  decodeExecutionCalendarObservationResult,
  maximumSubmissionDurationMs,
  SelectedExecutionCalendarSessionSchema,
  SignalCycleSessionSchema,
  type CycleDraft,
  type CycleExecutionPolicy,
  type CycleIdentity,
  type CycleWindow,
  type CycleWindowPolicyInput,
  type ExecutionCalendarObservation,
  type SignalCycleSession,
} from './cycle-model'
import { Pipeable } from '../pipeable'

const autonomousCycleSubmissionWindowMs = 30 * 60_000
const decodeSelectedExecutionCalendarSessionResult = Schema.decodeUnknownResult(
  SelectedExecutionCalendarSessionSchema,
  strictParseOptions,
)
const decodeSignalCycleSessionResult = Schema.decodeUnknownResult(SignalCycleSessionSchema, strictParseOptions)
const decodeExecutionModelV2Result = Schema.decodeUnknownResult(ExecutionModelV2Schema, strictParseOptions)

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

const failure = <Operation extends CycleConstructionIssue['operation']>(
  operation: Operation,
  reason: CycleConstructionReason<Operation>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): CycleConstructionFailure =>
  new CycleConstructionFailure({ operation, reason, message, facts, cause } as CycleConstructionIssue &
    CycleConstructionFailureDetails)

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
    { timeZone: cycleTimeZone, adjustForTimeZone: true, disambiguation: 'reject' },
  )
  return zoned._tag === 'None' ? undefined : DateTime.toDateUtc(zoned.value).toISOString()
}

export const signalSessionCloseAt = (signalSession: unknown): Result.Result<string, CycleConstructionFailure> =>
  Result.flatMap(
    Result.mapError(decodeSignalCycleSessionResult(signalSession), (cause) =>
      failure('signal-close', 'decode', 'Signal session must contain a canonical America/New_York close', {}, cause),
    ),
    (decoded) => {
      const instant = localMarketTimeToUtcOption(decoded.session_date, decoded.close_time)
      return instant === undefined
        ? Result.fail(
            failure(
              'signal-close',
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
      failure('execution-policy', 'decode', 'cycle execution policy material is invalid', {}, cause),
    ),
    (decoded) =>
      Result.flatMap(
        Result.mapError(canonicalHashV1Result(decoded), (cause) =>
          failure('execution-policy', 'hash', 'cycle execution policy material is not canonicalizable', {}, cause),
        ),
        (executionPolicyHash) =>
          Result.mapError(decodeCycleExecutionPolicyResult({ ...decoded, executionPolicyHash }), (cause) =>
            failure('execution-policy', 'decode', 'cycle execution policy is invalid', {}, cause),
          ),
      ),
  )

export const makeCycleExecutionPolicyFromModel = (
  executionModel: unknown,
): Result.Result<CycleExecutionPolicy, CycleConstructionFailure> =>
  Result.flatMap(
    Result.mapError(decodeExecutionModelV2Result(executionModel), (cause) =>
      failure('execution-policy', 'decode', 'strategy execution model is invalid', {}, cause),
    ),
    (decodedModel) =>
      Result.flatMap(
        Result.mapError(canonicalHashV1Result(decodedModel), (cause) =>
          failure('execution-policy', 'hash', 'strategy execution model is not canonicalizable', {}, cause),
        ),
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
      failure(
        'execution-calendar',
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
          failure(
            'execution-calendar',
            'decode',
            'broker calendar session must contain ordered UTC instants for its session date',
            { sessionDate: decoded.date },
            cause,
          ),
        ),
        (material) =>
          Result.flatMap(
            Result.mapError(canonicalHashV1Result(material), (cause) =>
              failure(
                'execution-calendar',
                'hash',
                'broker calendar session is not canonicalizable',
                { sessionDate: decoded.date },
                cause,
              ),
            ),
            (executionCalendarHash) =>
              Result.mapError(
                decodeExecutionCalendarObservationResult({ ...material, executionCalendarHash }),
                (cause) =>
                  failure(
                    'execution-calendar',
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
      failure('cycle-identity', 'decode', 'cycle identity material is invalid', {}, cause),
    ),
    (decoded) =>
      Result.flatMap(
        Result.mapError(canonicalHashV1Result(decoded), (cause) =>
          failure('cycle-identity', 'hash', 'cycle identity material is not canonicalizable', {}, cause),
        ),
        (cycleId) =>
          Result.mapError(decodeCycleIdentityResult({ ...decoded, cycleId }), (cause) =>
            failure(
              'cycle-identity',
              'session-order',
              'execution session must follow the Signal session',
              { signalSessionDate: decoded.signalSessionDate, executionSessionDate: decoded.executionSessionDate },
              cause,
            ),
          ),
      ),
  )

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

const decodeCycleWindowInputs = (
  signalSession: unknown,
  executionCalendar: unknown,
  executionPolicy: unknown,
): Result.Result<DecodedCycleWindowInput, CycleConstructionFailure> => {
  const decodedSignal = Result.mapError(decodeSignalCycleSessionResult(signalSession), (cause) =>
    failure('cycle-window', 'decode', 'Signal session material is invalid', {}, cause),
  )
  const decodedCalendar = Result.mapError(decodeExecutionCalendarObservationResult(executionCalendar), (cause) =>
    failure('cycle-window', 'decode', 'selected broker calendar session is invalid', {}, cause),
  )
  const decodedPolicy = Result.mapError(decodeCycleWindowPolicyInputResult(executionPolicy), (cause) =>
    failure('cycle-window', 'decode', 'cycle window policy is invalid', {}, cause),
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
      failure('cycle-window', 'duration', 'submission window must be between one millisecond and one day', {
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
      failure('cycle-window', 'duration', 'broker cutoff lead must be between one millisecond and one day', {
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
      failure('cycle-window', 'session-order', 'execution session must follow the Signal session', {
        signalSessionDate: signal.session_date,
        executionSessionDate: calendar.executionSessionDate,
      }),
    )
  }
  const signalCloseAt = localMarketTimeToUtcOption(signal.session_date, signal.close_time)
  if (signalCloseAt === undefined) {
    return Result.fail(
      failure(
        'cycle-window',
        'market-time',
        `${signal.session_date} ${signal.close_time} is not a valid ${cycleTimeZone} market time`,
        { sessionDate: signal.session_date, marketTime: signal.close_time, timeZone: cycleTimeZone },
      ),
    )
  }
  const submissionCutoffAt = utcInstantFromEpochMillis(
    Date.parse(calendar.executionOpenAt) - policy.submissionCutoffBeforeOpenMs,
  )
  const submissionOpenAt = utcInstantFromEpochMillis(Date.parse(submissionCutoffAt) - policy.submissionWindowMs)
  if (submissionOpenAt <= signalCloseAt) {
    return Result.fail(
      failure('cycle-window', 'submission-window', 'submission window must begin after the Signal session close', {
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
    (cause) => failure('cycle-window', 'decode', 'derived cycle window is invalid', {}, cause),
  )

const makeCycleWindowDataFirst = (
  signalSession: unknown,
  executionCalendar: unknown,
  executionPolicy: unknown,
): Result.Result<CycleWindow, CycleConstructionFailure> =>
  Result.flatMap(decodeCycleWindowInputs(signalSession, executionCalendar, executionPolicy), (input) =>
    Result.flatMap(validateCycleWindowDurations(input.policy), () =>
      Result.flatMap(deriveCycleWindowTimes(input), (times) => assembleCycleWindow(input, times)),
    ),
  )

export const makeCycleWindow = Pipeable.dual(3, makeCycleWindowDataFirst)

const makeCycleDraftDataFirst = (
  identity: unknown,
  window: unknown,
): Result.Result<CycleDraft, CycleConstructionFailure> =>
  Result.flatMap(
    Result.mapError(decodeCycleIdentityResult(identity), (cause) =>
      failure('cycle-draft', 'decode', 'cycle identity is invalid', {}, cause),
    ),
    (decodedIdentity) =>
      Result.flatMap(
        Result.mapError(decodeCycleWindowResult(window), (cause) =>
          failure('cycle-draft', 'decode', 'cycle window is invalid', {}, cause),
        ),
        (decodedWindow) =>
          Result.mapError(
            decodeCycleDraftResult({
              schemaVersion: 'bayn.autonomous-cycle.v1',
              identity: decodedIdentity,
              window: decodedWindow,
            }),
            (cause) =>
              failure(
                'cycle-draft',
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

export const makeCycleDraft = Pipeable.dual(2, makeCycleDraftDataFirst)
