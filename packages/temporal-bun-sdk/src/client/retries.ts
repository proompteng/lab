import { Code, ConnectError } from '@connectrpc/connect'
import { Effect } from 'effect'
import * as Duration from 'effect/Duration'
import type { Effect as EffectType } from 'effect/Effect'
import * as Schedule from 'effect/Schedule'

export interface TemporalRpcRetryPolicy {
  readonly maxAttempts: number
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly backoffCoefficient: number
  readonly jitterFactor: number
  readonly retryableStatusCodes: ReadonlyArray<number>
}

export type RetryPolicy = TemporalRpcRetryPolicy

const DEFAULT_RETRYABLE_CODES: number[] = [
  Code.Unavailable,
  Code.ResourceExhausted,
  Code.DeadlineExceeded,
  Code.Internal,
]

export const defaultRetryPolicy: TemporalRpcRetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 200,
  maxDelayMs: 5_000,
  backoffCoefficient: 2,
  jitterFactor: 0.2,
  retryableStatusCodes: [...DEFAULT_RETRYABLE_CODES],
}

const clampJitter = (factor: number): number => {
  if (Number.isNaN(factor) || factor < 0) {
    return 0
  }
  if (factor > 1) {
    return 1
  }
  return factor
}

const shouldRetryError = (policy: TemporalRpcRetryPolicy) => {
  const retryable = new Set(policy.retryableStatusCodes.length ? policy.retryableStatusCodes : DEFAULT_RETRYABLE_CODES)

  return (error: unknown): boolean => {
    if (!(error instanceof ConnectError)) {
      return false
    }
    return retryable.has(error.code)
  }
}

const makeRetrySchedule = (policy: TemporalRpcRetryPolicy): Schedule.Schedule<Duration.Duration, unknown, never> => {
  const backoff = Schedule.exponential(Duration.millis(policy.initialDelayMs), policy.backoffCoefficient)
  const capped = Schedule.delayed(backoff, (delay) => Duration.min(delay, Duration.millis(policy.maxDelayMs)))
  const jitter = clampJitter(policy.jitterFactor)
  const jittered = jitter === 0 ? capped : Schedule.jitteredWith({ min: 1 - jitter, max: 1 + jitter })(capped)
  const attempts = Math.max(0, Math.trunc(policy.maxAttempts) - 1)
  const limited = Schedule.intersect(Schedule.recurs(attempts))(jittered)
  const normalized = Schedule.map(limited, ([delay]) => delay)
  return Schedule.whileInput<unknown>(shouldRetryError(policy))(normalized)
}

export const withTemporalRetry = <A, E>(
  effect: EffectType<A, E, never>,
  policy: TemporalRpcRetryPolicy = defaultRetryPolicy,
): EffectType<A, E, never> => {
  const schedule = makeRetrySchedule(policy)
  return Effect.retry(effect as Effect.Effect<A, E, never>, schedule) as EffectType<A, E, never>
}
