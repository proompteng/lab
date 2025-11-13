import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { Effect } from 'effect'
import type { LogFields, LogLevel, Logger } from '../observability/logger'
import type { Counter } from '../observability/metrics'

import type { DataConverter } from '../common/payloads'
import { encodeValuesToPayloads } from '../common/payloads/converter'
import { sleep } from '../common/sleep'
import { PayloadsSchema } from '../proto/temporal/api/common/v1/message_pb'
import { RecordActivityTaskHeartbeatRequestSchema } from '../proto/temporal/api/workflowservice/v1/request_response_pb'
import type { ActivityContext } from '../worker/activity-context'
import type { WorkflowServiceClient } from '../worker/runtime'
import type { WorkflowRetryPolicyInput } from '../workflow/determinism'

const MIN_HEARTBEAT_INTERVAL_MS = 250
const DEFAULT_HEARTBEAT_JITTER_RATIO = 0.2
const DEFAULT_ACTIVITY_RETRY_INITIAL_INTERVAL_MS = 1_000
const DEFAULT_ACTIVITY_RETRY_BACKOFF = 2
const DEFAULT_ACTIVITY_RETRY_MAX_INTERVAL_MULTIPLIER = 100
const RETRIABLE_HEARTBEAT_CODES = new Set<Code>([
  Code.Unavailable,
  Code.ResourceExhausted,
  Code.Internal,
  Code.Aborted,
  Code.DeadlineExceeded,
])

export interface ActivityRetryState {
  readonly attempt: number
  readonly retryCount: number
  readonly nextDelayMs: number
}

export interface ActivityLifecycleConfig {
  readonly heartbeatIntervalMs: number
  readonly heartbeatRpcTimeoutMs: number
  readonly heartbeatRetry: {
    readonly initialIntervalMs: number
    readonly maxIntervalMs: number
    readonly backoffCoefficient: number
    readonly maxAttempts: number
    readonly jitterRatio?: number
  }
  readonly observability?: ActivityLifecycleObservability
}

export interface ActivityLifecycleObservability {
  readonly logger: Logger
  readonly heartbeatRetryCounter: Counter
  readonly heartbeatFailureCounter: Counter
}

export interface ActivityHeartbeatRegistrationOptions {
  readonly context: ActivityContext
  readonly workflowService: WorkflowServiceClient
  readonly taskToken: Uint8Array
  readonly identity: string
  readonly namespace: string
  readonly dataConverter: DataConverter
  readonly abortController: AbortController
}

export interface ActivityHeartbeatRegistration {
  readonly heartbeat: (details: unknown[]) => Effect.Effect<void, unknown, never>
  readonly shutdown: Effect.Effect<void, never, never>
}

export interface ActivityLifecycle {
  readonly registerHeartbeat: (
    options: ActivityHeartbeatRegistrationOptions,
  ) => Effect.Effect<ActivityHeartbeatRegistration, unknown, never>
  readonly nextRetryDelay: (
    retry: WorkflowRetryPolicyInput | undefined,
    state: ActivityRetryState,
  ) => Effect.Effect<ActivityRetryState | undefined, never, never>
}

export const makeActivityLifecycle = (
  config: ActivityLifecycleConfig,
): Effect.Effect<ActivityLifecycle, never, never> =>
  Effect.sync(() => {
    const registerHeartbeat: ActivityLifecycle['registerHeartbeat'] = (options) =>
      Effect.try(() => {
        const driver = new ActivityHeartbeatDriver(config, options, config.observability)
        return {
          heartbeat: (details) => Effect.tryPromise(async () => await driver.enqueue(details)),
          shutdown: Effect.tryPromise(async () => {
            await driver.shutdown()
          }).pipe(Effect.catchAll(() => Effect.void)),
        }
      })

    const nextRetryDelay: ActivityLifecycle['nextRetryDelay'] = (retry, state) =>
      Effect.sync(() => {
        if (!retry) {
          return undefined
        }
        const nextAttempt = state.attempt + 1
        const maxAttempts = retry.maximumAttempts ?? 0
        if (maxAttempts === 1) {
          return undefined
        }
        if (maxAttempts > 0 && nextAttempt > maxAttempts) {
          return undefined
        }
        const initialInterval = retry.initialIntervalMs ?? DEFAULT_ACTIVITY_RETRY_INITIAL_INTERVAL_MS
        const backoffCoefficient = retry.backoffCoefficient ?? DEFAULT_ACTIVITY_RETRY_BACKOFF
        const maxInterval = retry.maximumIntervalMs ?? initialInterval * DEFAULT_ACTIVITY_RETRY_MAX_INTERVAL_MULTIPLIER
        const retryCount = state.retryCount + 1
        const attemptBasedExponent = Math.max(state.attempt - 1, 0)
        const exponentialDelay = initialInterval * backoffCoefficient ** attemptBasedExponent
        const nextDelayMs = Math.min(exponentialDelay, maxInterval)
        return {
          attempt: nextAttempt,
          retryCount,
          nextDelayMs,
        }
      })

    return {
      registerHeartbeat,
      nextRetryDelay,
    }
  })

type PendingHeartbeat = {
  details: unknown[]
  waiters: {
    resolve: () => void
    reject: (error: unknown) => void
  }[]
}

class ActivityHeartbeatDriver {
  readonly #config: ActivityLifecycleConfig
  readonly #options: ActivityHeartbeatRegistrationOptions
  readonly #observability?: ActivityLifecycleObservability
  readonly #intervalMs: number
  readonly #retryJitterRatio: number
  #pending: PendingHeartbeat | undefined
  #timer: NodeJS.Timeout | undefined
  #sending: Promise<void> | undefined
  #stopped = false
  #lastSentAt = 0

  constructor(
    config: ActivityLifecycleConfig,
    options: ActivityHeartbeatRegistrationOptions,
    observability?: ActivityLifecycleObservability,
  ) {
    this.#config = config
    this.#options = options
    this.#observability = observability
    this.#retryJitterRatio = config.heartbeatRetry.jitterRatio ?? DEFAULT_HEARTBEAT_JITTER_RATIO
    this.#intervalMs = this.#computeInterval(options.context.info.heartbeatTimeoutMs)
    const onAbort = () => {
      this.#stopImmediately()
    }
    options.abortController.signal.addEventListener('abort', onAbort, { once: true })
  }

  enqueue(details: unknown[]): Promise<void> {
    if (this.#stopped) {
      return Promise.reject(createAbortError('Activity heartbeat requested after shutdown'))
    }
    if (this.#options.abortController.signal.aborted) {
      return Promise.reject(this.#options.abortController.signal.reason ?? createAbortError('Activity cancelled'))
    }
    return new Promise((resolve, reject) => {
      const payload = details ?? []
      if (this.#pending) {
        this.#pending.details = payload
        this.#pending.waiters.push({ resolve, reject })
      } else {
        this.#pending = { details: payload, waiters: [{ resolve, reject }] }
      }
      this.#scheduleFlush()
    })
  }

  async shutdown(): Promise<void> {
    this.#stopped = true
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    this.#rejectPending(createAbortError('Activity heartbeat stopped'))
    if (this.#sending) {
      try {
        await this.#sending
      } catch {
        // Ignore flush errors during shutdown.
      }
    }
  }

  #scheduleFlush(): void {
    if (this.#stopped || !this.#pending) {
      return
    }
    const now = Date.now()
    const elapsed = now - this.#lastSentAt
    if (!this.#sending && elapsed >= this.#intervalMs) {
      this.#startFlush()
      return
    }
    const remaining = Math.max(this.#intervalMs - elapsed, MIN_HEARTBEAT_INTERVAL_MS)
    if (this.#timer) {
      clearTimeout(this.#timer)
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      if (!this.#sending) {
        this.#startFlush()
      }
    }, remaining)
  }

  #startFlush(): void {
    const pendingFlush = this.#flush()
    this.#sending = pendingFlush
    void pendingFlush
      .catch((error) => {
        this.#recordHeartbeatFailure(error)
      })
      .finally(() => {
        if (this.#sending === pendingFlush) {
          this.#sending = undefined
        }
        if (this.#pending && !this.#stopped) {
          this.#scheduleFlush()
        }
      })
  }

  async #flush(): Promise<void> {
    if (!this.#pending || this.#stopped) {
      return
    }
    const batch = this.#pending
    this.#pending = undefined
    try {
      await this.#send(batch.details)
      this.#lastSentAt = Date.now()
      batch.waiters.forEach(({ resolve }) => {
        resolve()
      })
    } catch (error) {
      batch.waiters.forEach(({ reject }) => {
        reject(error)
      })
      throw error
    }
  }

  async #send(details: unknown[]): Promise<void> {
    const payloads = (await encodeValuesToPayloads(this.#options.dataConverter, details)) ?? []
    const request = create(RecordActivityTaskHeartbeatRequestSchema, {
      taskToken: this.#options.taskToken,
      identity: this.#options.identity,
      namespace: this.#options.namespace,
      details: payloads.length > 0 ? create(PayloadsSchema, { payloads }) : undefined,
    })

    const response = await this.#executeWithRetry(async () => {
      return await this.#options.workflowService.recordActivityTaskHeartbeat(request, {
        timeoutMs: this.#config.heartbeatRpcTimeoutMs,
      })
    })

    this.#options.context.info.lastHeartbeatDetails = details
    this.#options.context.info.lastHeartbeatTime = new Date()

    if (response.cancelRequested && !this.#options.abortController.signal.aborted) {
      this.#options.context.info.cancellationReason = 'cancel-requested'
      this.#options.abortController.abort(createAbortError('Activity cancellation requested by Temporal'))
    }
  }

  async #executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0
    let delayMs = this.#config.heartbeatRetry.initialIntervalMs
    for (;;) {
      try {
        return await operation()
      } catch (error) {
        if (this.#options.abortController.signal.aborted) {
          throw this.#options.abortController.signal.reason ?? error
        }
        if (isHeartbeatNotFound(error)) {
          this.#options.context.info.cancellationReason = 'not-found'
          this.#options.abortController.abort(createAbortError('Activity heartbeat rejected: task not found'))
          throw error
        }
        if (!isRetriableHeartbeatError(error)) {
          throw error
        }
        attempt += 1
        if (attempt >= this.#config.heartbeatRetry.maxAttempts) {
          this.#recordHeartbeatFailure(error)
          throw error
        }
        const capped = Math.min(delayMs, this.#config.heartbeatRetry.maxIntervalMs)
        const jittered = applyJitter(capped, this.#retryJitterRatio)
        this.#trackHeartbeatRetry()
        await sleep(jittered)
        delayMs = Math.min(
          delayMs * this.#config.heartbeatRetry.backoffCoefficient,
          this.#config.heartbeatRetry.maxIntervalMs,
        )
      }
    }
  }

  #computeInterval(heartbeatTimeoutMs: number | undefined): number {
    if (!heartbeatTimeoutMs) {
      return Math.max(this.#config.heartbeatIntervalMs, MIN_HEARTBEAT_INTERVAL_MS)
    }
    const safeInterval = Math.max(Math.floor(heartbeatTimeoutMs * 0.8), MIN_HEARTBEAT_INTERVAL_MS)
    return Math.min(this.#config.heartbeatIntervalMs, safeInterval)
  }

  #stopImmediately(): void {
    this.#stopped = true
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    this.#rejectPending(createAbortError('Activity heartbeat stopped'))
  }

  #rejectPending(error: Error): void {
    const pending = this.#pending
    if (!pending) {
      return
    }
    this.#pending = undefined
    for (const waiter of pending.waiters) {
      waiter.reject(error)
    }
  }
}

const isRetriableHeartbeatError = (error: unknown): boolean => {
  if (!(error instanceof ConnectError)) {
    return false
  }
  return RETRIABLE_HEARTBEAT_CODES.has(error.code)
}

const isHeartbeatNotFound = (error: unknown): boolean => error instanceof ConnectError && error.code === Code.NotFound

const createAbortError = (message: string): Error => {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

const applyJitter = (delayMs: number, ratio: number): number => {
  if (ratio <= 0) {
    return delayMs
  }
  const minFactor = 1 - ratio / 2
  const maxFactor = 1 + ratio / 2
  const factor = minFactor + Math.random() * (maxFactor - minFactor)
  return Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.round(delayMs * factor))
}
