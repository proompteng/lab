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
  /** Global end of entry authority and start of forced flattening. */
  readonly mandateForceCloseAt?: string
  readonly mandateCloseSubmitCutoffAt?: string
  readonly mandateCloseExpiresAt?: string
}

export type ExecutionCycleCloseWindowFailure = {
  readonly _tag: 'ExecutionCycleCloseWindowInvalid'
  readonly reason: string
}

const earlierInstant = (left: string, right: string): string => (left < right ? left : right)

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
): Result.Result<ExecutionCycleCloseWindow | undefined, ExecutionCycleCloseWindowFailure> =>
  Result.gen(function* () {
    if (
      facts.mandateForceCloseAt === undefined ||
      facts.mandateCloseSubmitCutoffAt === undefined ||
      facts.mandateCloseExpiresAt === undefined
    ) {
      return undefined
    }
    const mandateForceCloseAt = yield* decodeInstant(facts.mandateForceCloseAt, 'mandate force-close instant')
    const mandateCloseSubmitCutoffAt = yield* decodeInstant(
      facts.mandateCloseSubmitCutoffAt,
      'mandate close submit-cutoff instant',
    )
    const mandateCloseExpiresAt = yield* decodeInstant(facts.mandateCloseExpiresAt, 'mandate close expiry instant')
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
    const window = {
      startAt: earlierInstant(mandateForceCloseAt, sessionStartAt),
      submitCutoffAt: earlierInstant(mandateCloseSubmitCutoffAt, sessionSubmitCutoffAt),
      expiresAt: earlierInstant(mandateCloseExpiresAt, executionCloseAt),
    }

    return window.startAt < window.submitCutoffAt && window.submitCutoffAt <= window.expiresAt
      ? window
      : yield* Result.fail({
          _tag: 'ExecutionCycleCloseWindowInvalid' as const,
          reason: 'execution close window must contain ordered start, submit-cutoff, and expiry instants',
        })
  })
