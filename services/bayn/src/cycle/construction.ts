import { isContinuousMarket, type MarketHours } from '../market-hours'
import { continuousExecutionPolicy } from '../market-hours'
import { Data, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { ExecutionModelV6Schema } from '../execution-model-contract'
import { strictParseOptions } from '../schemas'
import { utcInstantFromEpochMillis } from '../time'
import {
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
  type CycleDraft,
  type CycleExecutionPolicy,
  type CycleIdentity,
  type CycleWindow,
  type ExecutionCalendarObservation,
} from './model'

const decodeSelectedExecutionCalendarSessionResult = Schema.decodeUnknownResult(
  SelectedExecutionCalendarSessionSchema,
  strictParseOptions,
)
const decodeCycleExecutionModelResult = Schema.decodeUnknownResult(ExecutionModelV6Schema, strictParseOptions)

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

type CycleConstructionIssue =
  | CycleDraftConstructionIssue
  | CycleIdentityConstructionIssue
  | CycleWindowConstructionIssue
  | ExecutionCalendarConstructionIssue
  | ExecutionPolicyConstructionIssue

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

export const makeCycleExecutionPolicy = (
  material: unknown,
): Result.Result<CycleExecutionPolicy, CycleConstructionFailure> =>
  Result.gen(function* () {
    const decoded = yield* Result.mapError(decodeCycleExecutionPolicyMaterialResult(material), (cause) =>
      failure('execution-policy', 'decode', 'cycle execution policy material is invalid', {}, cause),
    )
    const executionPolicyHash = yield* Result.mapError(canonicalHashV1Result(decoded), (cause) =>
      failure('execution-policy', 'hash', 'cycle execution policy material is not canonicalizable', {}, cause),
    )
    return yield* Result.mapError(decodeCycleExecutionPolicyResult({ ...decoded, executionPolicyHash }), (cause) =>
      failure('execution-policy', 'decode', 'cycle execution policy is invalid', {}, cause),
    )
  })

export const makeCycleExecutionPolicyFromModel = (
  executionModel: unknown,
): Result.Result<CycleExecutionPolicy, CycleConstructionFailure> =>
  Result.gen(function* () {
    const decodedModel = yield* Result.mapError(decodeCycleExecutionModelResult(executionModel), (cause) =>
      failure('execution-policy', 'decode', 'strategy execution model is invalid', {}, cause),
    )
    const strategyExecutionModelHash = yield* Result.mapError(canonicalHashV1Result(decodedModel), (cause) =>
      failure('execution-policy', 'hash', 'strategy execution model is not canonicalizable', {}, cause),
    )
    return yield* makeCycleExecutionPolicy({
      schemaVersion: 'bayn.autonomous-cycle-execution-policy.v3',
      strategyExecutionModelHash,
      warmupAfterOpenMs: decodedModel.order.warmupAfterOpenMs,
      submissionCutoffBeforeCloseMs: decodedModel.order.submissionCutoffBeforeCloseMs,
    })
  })

export const makeExecutionCalendarObservation = (
  session: unknown,
): Result.Result<ExecutionCalendarObservation, CycleConstructionFailure> =>
  Result.gen(function* () {
    const decoded = yield* Result.mapError(decodeSelectedExecutionCalendarSessionResult(session), (cause) =>
      failure(
        'execution-calendar',
        'decode',
        'broker calendar session must contain ordered UTC instants for its session date',
        {},
        cause,
      ),
    )
    const material = yield* Result.mapError(
      decodeExecutionCalendarMaterialResult({
        executionCalendarSchemaVersion: decoded.schemaVersion,
        executionCalendarSource: decoded.source,
        executionSessionDate: decoded.date,
        executionOpenAt: decoded.openAt,
        executionCloseAt: decoded.closeAt,
      }),
      (cause) =>
        failure(
          'execution-calendar',
          'decode',
          'broker calendar session must contain ordered UTC instants for its session date',
          { sessionDate: decoded.date },
          cause,
        ),
    )
    const executionCalendarHash = yield* Result.mapError(canonicalHashV1Result(material), (cause) =>
      failure(
        'execution-calendar',
        'hash',
        'broker calendar session is not canonicalizable',
        { sessionDate: decoded.date },
        cause,
      ),
    )
    return yield* Result.mapError(
      decodeExecutionCalendarObservationResult({ ...material, executionCalendarHash }),
      (cause) =>
        failure(
          'execution-calendar',
          'decode',
          'selected broker calendar session is invalid',
          { sessionDate: decoded.date },
          cause,
        ),
    )
  })

export const makeCycleIdentity = (material: unknown): Result.Result<CycleIdentity, CycleConstructionFailure> =>
  Result.gen(function* () {
    const decoded = yield* Result.mapError(decodeCycleIdentityMaterialResult(material), (cause) =>
      failure('cycle-identity', 'decode', 'cycle identity material is invalid', {}, cause),
    )
    const cycleId = yield* Result.mapError(canonicalHashV1Result(decoded), (cause) =>
      failure('cycle-identity', 'hash', 'cycle identity material is not canonicalizable', {}, cause),
    )
    return yield* Result.mapError(decodeCycleIdentityResult({ ...decoded, cycleId }), (cause) =>
      failure(
        'cycle-identity',
        'session-order',
        'intraday cycle identity is invalid',
        { executionSessionDate: decoded.executionSessionDate },
        cause,
      ),
    )
  })

export const makeIntradayCycleWindow = (
  executionCalendar: unknown,
  executionPolicy: unknown,
): Result.Result<CycleWindow, CycleConstructionFailure> =>
  Result.gen(function* () {
    const calendar = yield* Result.mapError(decodeExecutionCalendarObservationResult(executionCalendar), (cause) =>
      failure('cycle-window', 'decode', 'selected broker calendar session is invalid', {}, cause),
    )
    const policy = yield* Result.mapError(decodeCycleWindowPolicyInputResult(executionPolicy), (cause) =>
      failure('cycle-window', 'decode', 'intraday cycle window policy is invalid', {}, cause),
    )
    const offsets = [policy.warmupAfterOpenMs, policy.submissionCutoffBeforeCloseMs]
    if (offsets.some((offset) => !Number.isSafeInteger(offset) || offset < 0 || offset > maximumSubmissionDurationMs))
      return yield* Result.fail(
        failure('cycle-window', 'duration', 'intraday session-relative offsets must be within one day', {}),
      )
    const continuous = calendar.executionCalendarSchemaVersion === 'bayn.continuous-market-hours.v1'
    const submissionOpenAt = utcInstantFromEpochMillis(
      continuous
        ? Date.parse(calendar.executionOpenAt)
        : Date.parse(calendar.executionOpenAt) + policy.warmupAfterOpenMs,
    )
    const submissionCutoffAt = utcInstantFromEpochMillis(
      continuous
        ? Date.parse(calendar.executionOpenAt) + continuousExecutionPolicy.entryValidityMs
        : Date.parse(calendar.executionCloseAt) - policy.submissionCutoffBeforeCloseMs,
    )
    return yield* Result.mapError(
      decodeCycleWindowResult({
        schemaVersion: 'bayn.autonomous-cycle-window.v3',
        ...calendar,
        submissionOpenAt,
        submissionCutoffAt,
      }),
      (cause) => failure('cycle-window', 'submission-window', 'derived intraday cycle window is invalid', {}, cause),
    )
  })

export const makeCycleDraft = (
  identity: unknown,
  window: unknown,
): Result.Result<CycleDraft, CycleConstructionFailure> =>
  Result.gen(function* () {
    const decodedIdentity = yield* Result.mapError(decodeCycleIdentityResult(identity), (cause) =>
      failure('cycle-draft', 'decode', 'cycle identity is invalid', {}, cause),
    )
    const decodedWindow = yield* Result.mapError(decodeCycleWindowResult(window), (cause) =>
      failure('cycle-draft', 'decode', 'cycle window is invalid', {}, cause),
    )
    return yield* Result.mapError(
      decodeCycleDraftResult({
        schemaVersion: 'bayn.autonomous-cycle.v4',
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
            executionSessionDate: decodedWindow.executionSessionDate,
          },
          cause,
        ),
    )
  })

export const makeBoundExecutionCalendar = (
  hours: MarketHours,
  window: Pick<CycleWindow, 'executionSessionDate' | 'executionOpenAt' | 'executionCloseAt'>,
) => {
  const session = isContinuousMarket(hours)
    ? { date: window.executionSessionDate, openAt: window.executionOpenAt, closeAt: window.executionCloseAt }
    : hours.sessions.find((entry) => entry.date === window.executionSessionDate)
  return session === undefined
    ? Result.fail(failure('execution-calendar', 'decode', 'market hours have no selected execution window'))
    : makeExecutionCalendarObservation({ schemaVersion: hours.schemaVersion, source: hours.source, ...session })
}
