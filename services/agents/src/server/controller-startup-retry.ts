export type ControllerStartupRetryHandle = {
  start: () => void
  cancel: () => void
  pending: () => boolean
}

type ControllerStartupRetryLogger = Pick<typeof console, 'warn'>

export type ControllerStartupRetryOptions = {
  name: string
  start: () => Promise<void> | void
  isStarted: () => boolean
  isEnabled?: () => boolean
  shouldRetry?: (error: unknown) => boolean
  minDelayMs?: number
  maxDelayMs?: number
  multiplier?: number
  logger?: ControllerStartupRetryLogger
}

const DEFAULT_MIN_DELAY_MS = 10_000
const DEFAULT_MAX_DELAY_MS = 60_000
const DEFAULT_MULTIPLIER = 2

const normalizeDelay = (value: number | undefined, fallback: number) =>
  value === undefined || !Number.isFinite(value) || value < 0 ? fallback : Math.floor(value)

const normalizeMultiplier = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value) || value < 1 ? DEFAULT_MULTIPLIER : value

const reasonForLog = (reason: unknown) => {
  if (reason instanceof Error) return reason.message
  if (reason === undefined || reason === null) return 'controller did not report started'

  switch (typeof reason) {
    case 'string':
      return reason
    case 'number':
    case 'boolean':
    case 'bigint':
      return reason.toString()
    case 'symbol':
      return reason.description ? `Symbol(${reason.description})` : 'Symbol()'
    case 'function':
      return `[function ${reason.name || 'anonymous'}]`
    case 'object':
      try {
        return JSON.stringify(reason) ?? 'unserializable controller startup reason'
      } catch {
        return 'unserializable controller startup reason'
      }
  }
}

export const createControllerStartupRetry = (options: ControllerStartupRetryOptions): ControllerStartupRetryHandle => {
  const minDelayMs = normalizeDelay(options.minDelayMs, DEFAULT_MIN_DELAY_MS)
  const maxDelayMs = Math.max(minDelayMs, normalizeDelay(options.maxDelayMs, DEFAULT_MAX_DELAY_MS))
  const multiplier = normalizeMultiplier(options.multiplier)
  const logger = options.logger ?? console

  let attempt = 0
  let generation = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const enabled = () => options.isEnabled?.() ?? true

  const clearRetryTimer = () => {
    if (!retryTimer) return
    clearTimeout(retryTimer)
    retryTimer = null
  }

  const delayForAttempt = (attemptNumber: number) =>
    Math.min(maxDelayMs, Math.floor(minDelayMs * multiplier ** Math.max(0, attemptNumber - 1)))

  const scheduleRetry = (reason: unknown) => {
    if (!enabled() || options.isStarted() || retryTimer) return
    attempt += 1
    const delayMs = delayForAttempt(attempt)
    const scheduledGeneration = generation
    logger.warn(`[agents] ${options.name} startup retry scheduled`, {
      attempt,
      delayMs,
      reason: reasonForLog(reason),
    })
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (generation !== scheduledGeneration) return
      start()
    }, delayMs)
  }

  const start = () => {
    generation += 1
    const runGeneration = generation
    clearRetryTimer()

    if (!enabled() || options.isStarted()) {
      attempt = 0
      return
    }

    Promise.resolve()
      .then(() => options.start())
      .then(() => {
        if (generation !== runGeneration) return
        if (options.isStarted()) {
          attempt = 0
          return
        }
        scheduleRetry('controller did not report started')
      })
      .catch((error) => {
        if (generation !== runGeneration) return
        if (options.shouldRetry && !options.shouldRetry(error)) {
          logger.warn(`[agents] ${options.name} startup retry stopped after non-retryable error`, {
            reason: reasonForLog(error),
          })
          return
        }
        scheduleRetry(error)
      })
  }

  return {
    start,
    cancel: () => {
      generation += 1
      attempt = 0
      clearRetryTimer()
    },
    pending: () => retryTimer !== null,
  }
}
