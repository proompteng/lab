import { Result } from 'effect'
import type { AutonomousCycle } from '../cycle/model'
import type { JevProtocol } from '../jev/protocol'
import { continuousExecutionPolicy, isContinuousMarket, regularEquitySessions, type MarketHours } from '../market-hours'
import type { ExecutionDecisionDocument } from '../shadow-decision-contract'
import { IntradayAlphaPhase } from '../strategy/intraday-alpha/constants'

import { utcInstantFromEpochMillis, utcInstantFromEpochMillisResult } from '../time'

export interface ExecutionCycleCloseWindow {
  readonly startAt: string
  readonly submitCutoffAt: string
  readonly expiresAt: string
}

export interface ExecutionCycleCloseWindowFacts {
  readonly executionCalendarSchemaVersion: MarketHours['schemaVersion']
  readonly observedAt: string
  readonly executionCloseAt: string
  readonly recoveryExpiresAt: string | null
  /** Strategy-bound lead from the session close to the start of forced flattening. */
  readonly sessionCloseStartLeadMs: number
  /** Strategy-bound lead from the session close to the final close submission. */
  readonly sessionCloseSubmitLeadMs: number
}

export type ExecutionCycleCloseWindowFailure = {
  readonly _tag: 'ExecutionCycleCloseWindowInvalid'
  readonly reason: string
}

const decodeInstant = (value: string, field: string): Result.Result<string, ExecutionCycleCloseWindowFailure> =>
  Result.mapError(
    utcInstantFromEpochMillisResult(Date.parse(value)),
    (): ExecutionCycleCloseWindowFailure => ({
      _tag: 'ExecutionCycleCloseWindowInvalid',
      reason: `${field} is invalid`,
    }),
  )

const decodeLead = (value: number, field: string): Result.Result<number, ExecutionCycleCloseWindowFailure> => {
  return Number.isSafeInteger(value) && value >= 0
    ? Result.succeed(value)
    : Result.fail({
        _tag: 'ExecutionCycleCloseWindowInvalid',
        reason: `${field} must be a nonnegative safe integer`,
      })
}

/** The same RTH deadline gates both native protection release and the position-mark fallback. */
export const executionCycleCloseSchedule = (
  cycle: AutonomousCycle,
  document: ExecutionDecisionDocument,
  protocol: Pick<JevProtocol, 'flattenBeforeCloseMinutes' | 'hardFlatBeforeCloseMinutes'>,
) => {
  const calendar = document.executionSession?.calendar
  const regular =
    calendar === undefined || isContinuousMarket(calendar)
      ? undefined
      : regularEquitySessions(calendar).find(({ date }) => date === cycle.identity.executionSessionDate)
  const executionCloseAt =
    regular !== undefined && regular.closeAt < cycle.window.executionCloseAt
      ? regular.closeAt
      : cycle.window.executionCloseAt
  const target = document.strategyDecision
  const sessionCloseSubmitLeadMs = protocol.hardFlatBeforeCloseMinutes * 60_000
  let sessionCloseStartLeadMs = protocol.flattenBeforeCloseMinutes * 60_000
  if (target?.schemaVersion === 'bayn.intraday-alpha-target.v2' && regular !== undefined) {
    const flattenMinute =
      target.phase === IntradayAlphaPhase.NoiseAreaTrend
        ? target.policy.noiseArea.flattenMinuteFromOpen
        : target.phase === IntradayAlphaPhase.MorningOrb
          ? target.policy.morningOrb.hardExitMinuteFromOpen
          : target.policy.middayReversion.flattenMinuteFromOpen
    const flattenAt = Date.parse(regular.openAt) + flattenMinute * 60_000
    const minimumLeadMs =
      target.phase === IntradayAlphaPhase.NoiseAreaTrend
        ? Math.max(1, 390 - target.policy.noiseArea.flattenMinuteFromOpen) * 60_000
        : sessionCloseStartLeadMs
    sessionCloseStartLeadMs = Math.max(minimumLeadMs, Date.parse(executionCloseAt) - flattenAt)
  }
  return {
    executionCalendarSchemaVersion: cycle.window.executionCalendarSchemaVersion,
    executionCloseAt,
    sessionCloseStartLeadMs,
    sessionCloseSubmitLeadMs,
  }
}

export const resolveExecutionCycleCloseWindow = (
  facts: ExecutionCycleCloseWindowFacts,
): Result.Result<ExecutionCycleCloseWindow, ExecutionCycleCloseWindowFailure> =>
  Result.gen(function* () {
    const executionCloseAt = yield* decodeInstant(facts.executionCloseAt, 'execution close instant')

    const observedAt = yield* decodeInstant(facts.observedAt, 'close observation instant')
    const closeAt = Date.parse(executionCloseAt)
    const sessionStartLeadMs = yield* decodeLead(facts.sessionCloseStartLeadMs, 'session close start lead')
    const startLeadMs =
      facts.executionCalendarSchemaVersion === 'bayn.continuous-market-hours.v1'
        ? continuousExecutionPolicy.closeRecoveryMs
        : sessionStartLeadMs
    const submitLeadMs = yield* decodeLead(facts.sessionCloseSubmitLeadMs, 'session close submit lead')
    if (startLeadMs <= submitLeadMs) {
      return yield* Result.fail({
        _tag: 'ExecutionCycleCloseWindowInvalid' as const,
        reason: 'session close start lead must be greater than the submit lead',
      })
    }
    const sessionStartAt = yield* Result.mapError(
      utcInstantFromEpochMillisResult(closeAt - startLeadMs),
      (): ExecutionCycleCloseWindowFailure => ({
        _tag: 'ExecutionCycleCloseWindowInvalid',
        reason: 'execution close instant is invalid',
      }),
    )
    const sessionSubmitCutoffAt = yield* Result.mapError(
      utcInstantFromEpochMillisResult(closeAt - submitLeadMs),
      (): ExecutionCycleCloseWindowFailure => ({
        _tag: 'ExecutionCycleCloseWindowInvalid',
        reason: 'execution close instant is invalid',
      }),
    )
    const recovery = facts.recoveryExpiresAt !== null && observedAt >= executionCloseAt
    if (recovery && submitLeadMs >= continuousExecutionPolicy.closeRecoveryMs)
      return yield* Result.fail({
        _tag: 'ExecutionCycleCloseWindowInvalid' as const,
        reason: 'close recovery must retain a bounded submission window',
      })
    const expiresAt = recovery
      ? yield* decodeInstant(facts.recoveryExpiresAt ?? executionCloseAt, 'recovery close expiry')
      : executionCloseAt
    if (
      recovery &&
      (expiresAt <= observedAt ||
        Date.parse(expiresAt) > Date.parse(observedAt) + continuousExecutionPolicy.closeRecoveryMs)
    )
      return yield* Result.fail({
        _tag: 'ExecutionCycleCloseWindowInvalid' as const,
        reason: 'close recovery lease exceeds its bounded lifetime',
      })
    return {
      startAt: sessionStartAt,
      submitCutoffAt: recovery ? new Date(Date.parse(expiresAt) - submitLeadMs).toISOString() : sessionSubmitCutoffAt,
      expiresAt,
    }
  })

export const boundExecutionCycleCloseWindow = (
  window: ExecutionCycleCloseWindow,
  document: { readonly expiresAt: string },
): ExecutionCycleCloseWindow => ({
  ...window,
  expiresAt: document.expiresAt,
  submitCutoffAt: utcInstantFromEpochMillis(
    Date.parse(document.expiresAt) - (Date.parse(window.expiresAt) - Date.parse(window.submitCutoffAt)),
  ),
})
