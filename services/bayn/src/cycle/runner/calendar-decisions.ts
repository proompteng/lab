import {
  isContinuousMarket,
  tradingWindow,
  continuousExecutionPolicy,
  continuousMarketHours,
  type MarketHours,
} from '../../market-hours'
import { DateTime, Option, Result } from 'effect'

import type { MarketCalendarQuery, MarketCalendarSession } from '../../broker/alpaca/model'
import { intradayDecisionDelaySeconds, intradayMinimumCompletedHistoryMs } from '../../strategy/intraday-market'
import {
  makeCycleDraft,
  makeCycleIdentity,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
  type CycleConstructionFailure,
} from '../construction'
import {
  CycleState,
  CycleTerminalReason,
  type AutonomousCycle,
  type CycleDraft,
  type CycleExecutionPolicy,
  type IntradayCycleEntryAttemptOrdinal,
} from '../model'
import { cycleDraftMatches, cycleDraftOf } from '../transitions'
import { unusedEntryExpiresAt } from '../entry-admission'

const calendarRangeDays = 31
const millisecondsPerDay = 86_400_000
export const intradayEntryRearmDelayMs = 60_000

export type IsoDateShiftCause =
  | { readonly _tag: 'IsoDateInputInvalid'; readonly date: string; readonly epochMillis: number }
  | { readonly _tag: 'IsoDateInputNotCanonical'; readonly date: string; readonly normalized: string }
  | { readonly _tag: 'IsoDateOffsetInvalid'; readonly date: string; readonly days: number }
  | {
      readonly _tag: 'IsoDateShiftEpochOutOfRange'
      readonly date: string
      readonly days: number
      readonly epochMillis: number
    }
  | {
      readonly _tag: 'IsoDateShiftResultOutOfRange'
      readonly date: string
      readonly days: number
      readonly shifted: string
    }

type IsoDateShiftFailure = {
  readonly _tag: 'IsoDateShiftOutOfRange'
  readonly date: string
  readonly days: number
  readonly cause: IsoDateShiftCause
}

export type CycleCalendarQueryFailure = {
  readonly _tag: 'CycleCalendarQueryRangeOutOfRange'
  readonly startSessionDate: string
  readonly offsetDays: number
  readonly cause: IsoDateShiftCause
}

const shiftIsoDate = (date: string, days: number): Result.Result<string, IsoDateShiftFailure> => {
  const failure = (cause: IsoDateShiftCause): Result.Result<never, IsoDateShiftFailure> =>
    Result.fail({ _tag: 'IsoDateShiftOutOfRange', date, days, cause })
  if (!Number.isSafeInteger(days)) return failure({ _tag: 'IsoDateOffsetInvalid', date, days })
  const inputEpochMillis = Date.parse(date + 'T00:00:00.000Z')
  const inputDate = DateTime.make(inputEpochMillis)
  if (Option.isNone(inputDate)) return failure({ _tag: 'IsoDateInputInvalid', date, epochMillis: inputEpochMillis })
  const input = DateTime.formatIso(inputDate.value)
  if (input !== date + 'T00:00:00.000Z') {
    return failure({ _tag: 'IsoDateInputNotCanonical', date, normalized: input })
  }
  const shiftedEpochMillis = inputEpochMillis + days * millisecondsPerDay
  const shiftedDateValue = DateTime.make(shiftedEpochMillis)
  if (Option.isNone(shiftedDateValue)) {
    return failure({ _tag: 'IsoDateShiftEpochOutOfRange', date, days, epochMillis: shiftedEpochMillis })
  }
  const shifted = DateTime.formatIso(shiftedDateValue.value)
  const shiftedDate = shifted.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(shiftedDate) && shifted === shiftedDate + 'T00:00:00.000Z'
    ? Result.succeed(shiftedDate)
    : failure({ _tag: 'IsoDateShiftResultOutOfRange', date, days, shifted })
}

export const marketCalendarQueryFromSession = (
  startSessionDate: string,
): Result.Result<MarketCalendarQuery, CycleCalendarQueryFailure> =>
  Result.mapError(
    Result.map(shiftIsoDate(startSessionDate, calendarRangeDays - 1), (end) => ({ start: startSessionDate, end })),
    (failure) => ({
      _tag: 'CycleCalendarQueryRangeOutOfRange',
      startSessionDate,
      offsetDays: calendarRangeDays - 1,
      cause: failure.cause,
    }),
  )

export const firstIntradayObservationAtMs = (
  session: Pick<MarketCalendarSession, 'openAt'>,
  executionPolicy: { readonly warmupAfterOpenMs: number },
): number =>
  Date.parse(session.openAt) +
  Math.max(executionPolicy.warmupAfterOpenMs, intradayMinimumCompletedHistoryMs) +
  intradayDecisionDelaySeconds * 1_000

export const selectIntradayExecutionSession = (
  observation: MarketHours,
  executionPolicy: Extract<
    CycleExecutionPolicy,
    { readonly schemaVersion: 'bayn.autonomous-cycle-execution-policy.v3' }
  >,
  observedAt: string,
): MarketCalendarSession | undefined => {
  if (isContinuousMarket(observation)) {
    const window = tradingWindow(observation, observedAt, { ...continuousExecutionPolicy, sessionEntryCutoffMs: 0 })
    return Result.isSuccess(window) && window.success !== null ? window.success : undefined
  }
  const observedAtMillis = Date.parse(observedAt)
  if (!Number.isFinite(observedAtMillis)) return undefined

  return observation.sessions.reduce<MarketCalendarSession | undefined>((selected, session) => {
    const cutoffAtMillis = Date.parse(session.closeAt) - executionPolicy.submissionCutoffBeforeCloseMs
    const hasExecutableWindow = firstIntradayObservationAtMs(session, executionPolicy) < cutoffAtMillis
    if (!Number.isFinite(cutoffAtMillis) || !hasExecutableWindow || observedAtMillis >= cutoffAtMillis) return selected
    return selected === undefined || session.date < selected.date ? session : selected
  }, undefined)
}

export interface IntradayCycleCandidate {
  readonly cycleBindingId: string
  readonly strategyName: 'jev'
  readonly strategyProtocolHash: string
  readonly accountId: string
  readonly executionPolicy: Extract<
    CycleExecutionPolicy,
    { readonly schemaVersion: 'bayn.autonomous-cycle-execution-policy.v3' }
  >
}

export const makeIntradayCycleDraft = (
  candidate: IntradayCycleCandidate,
  observation: Pick<MarketHours, 'schemaVersion' | 'source'>,
  executionSession: MarketCalendarSession,
  entryAttemptOrdinal: IntradayCycleEntryAttemptOrdinal = 1,
): Result.Result<CycleDraft, CycleConstructionFailure> =>
  Result.gen(function* () {
    const executionCalendar = yield* makeExecutionCalendarObservation({
      schemaVersion: observation.schemaVersion,
      source: observation.source,
      date: executionSession.date,
      openAt: executionSession.openAt,
      closeAt: executionSession.closeAt,
    })
    const identity = yield* makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v4',
      strategyName: candidate.strategyName,
      qualificationRunId: candidate.cycleBindingId,
      strategyProtocolHash: candidate.strategyProtocolHash,
      accountId: candidate.accountId,
      entryAttemptOrdinal,
      executionSessionDate: executionCalendar.executionSessionDate,
      executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
      executionCalendarSource: executionCalendar.executionCalendarSource,
      executionCalendarHash: executionCalendar.executionCalendarHash,
      executionPolicy: candidate.executionPolicy,
    })
    const window = yield* makeIntradayCycleWindow(executionCalendar, candidate.executionPolicy)
    return yield* makeCycleDraft(identity, window)
  })

export const nextIntradayEntryAttemptOrdinal = (
  cycle: AutonomousCycle,
  observedAt: string,
  submissionCutoffAt: string,
  recoveredBlockedCycle = false,
): IntradayCycleEntryAttemptOrdinal | undefined => {
  if (
    (cycle.state !== CycleState.Completed &&
      cycle.state !== CycleState.NoTrade &&
      !(cycle.state === CycleState.Blocked && recoveredBlockedCycle)) ||
    cycle.terminalAt === undefined ||
    cycle.window.schemaVersion !== 'bayn.autonomous-cycle-window.v3' ||
    observedAt >= submissionCutoffAt
  )
    return undefined
  const currentAttempt =
    cycle.identity.schemaVersion === 'bayn.autonomous-cycle-identity.v4'
      ? cycle.identity.entryAttemptOrdinal
      : undefined
  const rearmAt = Date.parse(cycle.terminalAt) + intradayEntryRearmDelayMs
  return currentAttempt !== undefined &&
    currentAttempt < 2_147_483_647 &&
    Number.isFinite(rearmAt) &&
    Date.parse(observedAt) >= rearmAt
    ? currentAttempt + 1
    : undefined
}

/**
 * An authority rollover or expired entry lease can leave an unused cycle without a decision. Reconstruct its
 * original draft under the current approved context before allowing a distinct attempt; never reinterpret a changed
 * strategy, account, mandate, calendar or execution policy. The caller must separately prove an absent decision and
 * current execution authority. The ordinary rearm cooldown, cutoff and fresh admission checks still apply.
 */
export const canRearmUnusedCycle = (
  cycle: AutonomousCycle,
  candidate: IntradayCycleCandidate,
  observation: MarketHours,
  executionSession: MarketCalendarSession,
  observedAt: string,
): boolean => {
  if (
    cycle.state !== CycleState.Blocked ||
    cycle.bindings.snapshotId !== undefined ||
    cycle.bindings.decisionHash !== undefined ||
    cycle.terminalAt === undefined
  )
    return false
  const expiredContinuousLease =
    cycle.window.executionCalendarSchemaVersion === continuousMarketHours.schemaVersion &&
    cycle.terminalReason === CycleTerminalReason.MissedSubmission &&
    cycle.terminalAt >= cycle.window.submissionCutoffAt &&
    observedAt >= cycle.window.submissionCutoffAt
  const preSubmissionRollover =
    cycle.terminalReason === CycleTerminalReason.ProvenanceMismatch && cycle.terminalAt < cycle.window.submissionOpenAt
  const unusedEntryExpired =
    cycle.terminalReason === CycleTerminalReason.UnusedEntryExpired &&
    Date.parse(cycle.terminalAt) >= unusedEntryExpiresAt(cycle) &&
    Date.parse(observedAt) >= unusedEntryExpiresAt(cycle)
  if (!expiredContinuousLease && !unusedEntryExpired && !preSubmissionRollover) return false
  const useOriginalWindow =
    expiredContinuousLease ||
    unusedEntryExpired ||
    cycle.window.executionCalendarSchemaVersion !== observation.schemaVersion
  const originalSession = useOriginalWindow
    ? {
        date: cycle.identity.executionSessionDate,
        openAt: cycle.window.executionOpenAt,
        closeAt: cycle.window.executionCloseAt,
      }
    : executionSession
  const originalDraft = makeIntradayCycleDraft(
    candidate,
    useOriginalWindow
      ? { schemaVersion: cycle.window.executionCalendarSchemaVersion, source: cycle.window.executionCalendarSource }
      : observation,
    originalSession,
    cycle.identity.entryAttemptOrdinal,
  )
  if (Result.isFailure(originalDraft)) return false
  return (
    cycle.identity.schemaVersion === 'bayn.autonomous-cycle-identity.v4' &&
    cycleDraftMatches(cycleDraftOf(cycle), originalDraft.success)
  )
}
