import { Result } from 'effect'

import { utcInstantFromEpochMillisResult } from '../time'

export const everySessionCloseStartLeadMs = 60 * 60_000
export const everySessionCloseSubmitLeadMs = 15 * 60_000

export interface ExecutionCycleCloseWindow {
  readonly startAt: string
  readonly submitCutoffAt: string
  readonly expiresAt: string
}

export interface ExecutionCycleCloseWindowFacts {
  readonly executionCloseAt: string
  /** Strategy-bound lead from the session close to the start of forced flattening. */
  readonly sessionCloseStartLeadMs?: number
  /** Strategy-bound lead from the session close to the final close submission. */
  readonly sessionCloseSubmitLeadMs?: number
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

const decodeLead = (
  value: number | undefined,
  fallback: number,
  field: string,
): Result.Result<number, ExecutionCycleCloseWindowFailure> => {
  const lead = value ?? fallback
  return Number.isSafeInteger(lead) && lead > 0
    ? Result.succeed(lead)
    : Result.fail({
        _tag: 'ExecutionCycleCloseWindowInvalid',
        reason: `${field} must be a positive safe integer`,
      })
}

export const resolveExecutionCycleCloseWindow = (
  facts: ExecutionCycleCloseWindowFacts,
): Result.Result<ExecutionCycleCloseWindow, ExecutionCycleCloseWindowFailure> =>
  Result.gen(function* () {
    const executionCloseAt = yield* decodeInstant(facts.executionCloseAt, 'execution close instant')

    const closeAt = Date.parse(executionCloseAt)
    const startLeadMs = yield* decodeLead(
      facts.sessionCloseStartLeadMs,
      everySessionCloseStartLeadMs,
      'session close start lead',
    )
    const submitLeadMs = yield* decodeLead(
      facts.sessionCloseSubmitLeadMs,
      everySessionCloseSubmitLeadMs,
      'session close submit lead',
    )
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
    return {
      startAt: sessionStartAt,
      submitCutoffAt: sessionSubmitCutoffAt,
      expiresAt: executionCloseAt,
    }
  })
