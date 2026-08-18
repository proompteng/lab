import { Result } from 'effect'

import { isEverySessionCycleCadence, type CycleCadence } from '../cycle/runner/model'
import { utcInstantFromEpochMillisResult } from '../time'

export const everySessionCloseStartLeadMs = 60 * 60_000
export const everySessionCloseSubmitLeadMs = 15 * 60_000

export interface ExecutionCycleCloseWindow {
  readonly startAt: string
  readonly submitCutoffAt: string
  readonly expiresAt: string
}

export interface ExecutionCycleCloseWindowFacts {
  readonly cadence?: CycleCadence
  readonly executionCloseAt: string
  readonly mandateCutoffAt?: string
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

export const resolveExecutionCycleCloseWindow = (
  facts: ExecutionCycleCloseWindowFacts,
): Result.Result<ExecutionCycleCloseWindow | undefined, ExecutionCycleCloseWindowFailure> =>
  Result.gen(function* () {
    if (
      facts.mandateCutoffAt === undefined ||
      facts.mandateCloseSubmitCutoffAt === undefined ||
      facts.mandateCloseExpiresAt === undefined
    ) {
      return undefined
    }
    const mandateCutoffAt = yield* decodeInstant(facts.mandateCutoffAt, 'mandate cutoff instant')
    const mandateCloseSubmitCutoffAt = yield* decodeInstant(
      facts.mandateCloseSubmitCutoffAt,
      'mandate close submit-cutoff instant',
    )
    const mandateCloseExpiresAt = yield* decodeInstant(facts.mandateCloseExpiresAt, 'mandate close expiry instant')
    const executionCloseAt = yield* decodeInstant(facts.executionCloseAt, 'execution close instant')

    const window = isEverySessionCycleCadence(facts.cadence)
      ? yield* Result.gen(function* () {
          const closeAt = Date.parse(executionCloseAt)
          const sessionStartAt = yield* Result.mapError(
            utcInstantFromEpochMillisResult(closeAt - everySessionCloseStartLeadMs),
            (): ExecutionCycleCloseWindowFailure => ({
              _tag: 'ExecutionCycleCloseWindowInvalid',
              reason: 'execution close instant is invalid',
            }),
          )
          const sessionSubmitCutoffAt = yield* Result.mapError(
            utcInstantFromEpochMillisResult(closeAt - everySessionCloseSubmitLeadMs),
            (): ExecutionCycleCloseWindowFailure => ({
              _tag: 'ExecutionCycleCloseWindowInvalid',
              reason: 'execution close instant is invalid',
            }),
          )
          return {
            startAt: earlierInstant(mandateCutoffAt, sessionStartAt),
            submitCutoffAt: earlierInstant(mandateCloseSubmitCutoffAt, sessionSubmitCutoffAt),
            expiresAt: earlierInstant(mandateCloseExpiresAt, executionCloseAt),
          }
        })
      : {
          startAt: mandateCutoffAt,
          submitCutoffAt: mandateCloseSubmitCutoffAt,
          expiresAt: mandateCloseExpiresAt,
        }

    return window.startAt < window.submitCutoffAt && window.submitCutoffAt <= window.expiresAt
      ? window
      : yield* Result.fail({
          _tag: 'ExecutionCycleCloseWindowInvalid' as const,
          reason: 'execution close window must contain ordered start, submit-cutoff, and expiry instants',
        })
  })
