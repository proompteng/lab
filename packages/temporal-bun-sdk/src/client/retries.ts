import type { Effect as EffectType } from 'effect/Effect'

export interface RetryPolicy {
  readonly maxAttempts: number
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly backoffCoefficient: number
  readonly retryableStatusCodes: number[]
}

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 200,
  maxDelayMs: 5_000,
  backoffCoefficient: 2,
  retryableStatusCodes: [],
}

export const withTemporalRetry = <A, E>(
  effect: EffectType<A, E, never>,
  _policy: RetryPolicy = defaultRetryPolicy,
): EffectType<A, E, never> => effect
