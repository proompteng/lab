import { Code, ConnectError } from '@connectrpc/connect'
import { Effect, Random } from 'effect'
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
  maxAttempts: 32,
  initialDelayMs: 200,
  maxDelayMs: 10_000,
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

const unwrapRetryError = (error: unknown): unknown => {
  if (error && typeof error === 'object') {
    const candidate = error as { _tag?: string; cause?: unknown; error?: unknown }
    if (error instanceof Error && error.name === 'TemporalTlsHandshakeError') {
      return error
    }
    // Effect.tryPromise failures arrive as UnknownError; surface the underlying cause when present.
    if (candidate._tag === 'UnknownError') {
      return candidate.cause ?? candidate.error ?? error
    }
    if ('cause' in candidate && candidate.cause) {
      return candidate.cause as unknown
    }
  }
  return error
}

const isRetryHintedUnknown = (error: ConnectError): boolean =>
  error.code === Code.Unknown && /\bplease retry\b|temporarily unavailable|try again/i.test(error.message)

const shouldRetryError = (policy: TemporalRpcRetryPolicy) => {
  const retryable = new Set(policy.retryableStatusCodes.length ? policy.retryableStatusCodes : DEFAULT_RETRYABLE_CODES)

  return (error: unknown): boolean => {
    const underlying = unwrapRetryError(error)
    if (underlying instanceof ConnectError) {
      if (underlying.code === Code.Canceled) {
        return false
      }
      if (isRetryHintedUnknown(underlying)) {
        return true
      }
      return retryable.has(underlying.code)
    }
    // Treat generic errors as transient for interceptor-driven retries; bounded by maxAttempts.
    if (underlying instanceof Error) {
      if (underlying.name === 'AbortError') {
        return false
      }
      if (underlying.name === 'TemporalTlsHandshakeError') {
        return false
      }
      return true
    }
    return false
  }
}

const makeRetrySchedule = (policy: TemporalRpcRetryPolicy): Schedule.Schedule<Duration.Duration, unknown, never> => {
  const jitter = clampJitter(policy.jitterFactor)
  return Schedule.exponential(Duration.millis(policy.initialDelayMs), policy.backoffCoefficient).pipe(
    Schedule.modifyDelay(({ duration }) => {
      const capped = Math.min(Duration.toMillis(duration), policy.maxDelayMs)
      return jitter === 0
        ? Effect.succeed(Duration.millis(capped))
        : Effect.map(Random.next, (random) => Duration.millis(capped * (1 - jitter + 2 * jitter * random)))
    }),
    Schedule.upTo({ times: Math.max(0, Math.trunc(policy.maxAttempts) - 1) }),
  )
}

export const withTemporalRetry = <A, E>(
  effect: EffectType<A, E, never>,
  policy: TemporalRpcRetryPolicy = defaultRetryPolicy,
): EffectType<A, E, never> => {
  const schedule = makeRetrySchedule(policy)
  return Effect.retry(effect, { schedule, while: shouldRetryError(policy) })
}
