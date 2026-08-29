import { DateTime, Option, Result } from 'effect'

import type { MarketCalendarObservation, MarketCalendarQuery, MarketCalendarSession } from '../../broker/alpaca'
import { defaultIntradayMomentumProtocolDocument } from '../../strategy/intraday-momentum/protocol'
import {
  makeCycleDraft,
  makeCycleIdentity,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
  type CycleConstructionFailure,
} from '../construction'
import type { CycleDraft, CycleExecutionPolicy } from '../model'

const calendarRangeDays = 31
const millisecondsPerDay = 86_400_000

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

export const selectIntradayExecutionSession = (
  observation: MarketCalendarObservation,
  executionPolicy: Extract<
    CycleExecutionPolicy,
    { readonly schemaVersion: 'bayn.autonomous-cycle-execution-policy.v3' }
  >,
  observedAt: string,
): MarketCalendarSession | undefined => {
  const observedAtMillis = Date.parse(observedAt)
  if (!Number.isFinite(observedAtMillis)) return undefined

  return observation.sessions.reduce<MarketCalendarSession | undefined>((selected, session) => {
    const openAtMillis = Date.parse(session.openAt)
    const cutoffAtMillis = Date.parse(session.closeAt) - executionPolicy.submissionCutoffBeforeCloseMs
    const hasExecutableWindow =
      openAtMillis +
        executionPolicy.warmupAfterOpenMs +
        defaultIntradayMomentumProtocolDocument.decisionDelaySeconds * 1_000 <
      cutoffAtMillis
    if (!Number.isFinite(cutoffAtMillis) || !hasExecutableWindow || observedAtMillis >= cutoffAtMillis) return selected
    return selected === undefined || session.date < selected.date ? session : selected
  }, undefined)
}

export interface IntradayCycleCandidate {
  readonly cycleBindingId: string
  readonly strategyName: 'intraday-momentum'
  readonly strategyProtocolHash: string
  readonly accountId: string
  readonly executionPolicy: Extract<
    CycleExecutionPolicy,
    { readonly schemaVersion: 'bayn.autonomous-cycle-execution-policy.v3' }
  >
}

export const makeIntradayCycleDraft = (
  candidate: IntradayCycleCandidate,
  observation: MarketCalendarObservation,
  executionSession: MarketCalendarSession,
): Result.Result<CycleDraft, CycleConstructionFailure> =>
  Result.gen(function* () {
    const executionCalendar = yield* makeExecutionCalendarObservation({
      schemaVersion: observation.schemaVersion,
      source: observation.source,
      ...executionSession,
    })
    const identity = yield* makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v3',
      strategyName: candidate.strategyName,
      qualificationRunId: candidate.cycleBindingId,
      strategyProtocolHash: candidate.strategyProtocolHash,
      accountId: candidate.accountId,
      executionSessionDate: executionCalendar.executionSessionDate,
      executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
      executionCalendarSource: executionCalendar.executionCalendarSource,
      executionCalendarHash: executionCalendar.executionCalendarHash,
      executionPolicy: candidate.executionPolicy,
    })
    const window = yield* makeIntradayCycleWindow(executionCalendar, candidate.executionPolicy)
    return yield* makeCycleDraft(identity, window)
  })
