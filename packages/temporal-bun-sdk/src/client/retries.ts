import { Code, ConnectError } from '@connectrpc/connect'
import { Effect, Schedule } from 'effect'

export interface RetryPolicy {
  readonly maxAttempts: number
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly backoffCoefficient: number
  readonly retryableStatusCodes: Code[]
}

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 200,
  maxDelayMs: 5_000,
  backoffCoefficient: 2,
  retryableStatusCodes: [Code.Unavailable, Code.DeadlineExceeded, Code.Internal, Code.ResourceExhausted],
}

export const withTemporalRetry = <A, E>(
  effect: Effect.Effect<A, E, never>,
  policy: RetryPolicy = defaultRetryPolicy,
): Effect.Effect<A, E, never> =>
  effect.pipe(
    Effect.retry(
      Schedule.exponential(policy.initialDelayMs).pipe(
        Schedule.whileOutput((delay) => delay <= policy.maxDelayMs),
        Schedule.whileInput((error: unknown, attempt) => {
          if (attempt >= policy.maxAttempts) {
            return false
          }
          if (!(error instanceof ConnectError)) {
            return false
          }
          return policy.retryableStatusCodes.includes(error.code)
        }),
      ),
    ),
    // TODO(TBS-005): Emit retry diagnostics to observability layer.
  )
