import { Effect } from 'effect'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogFields {
  readonly [key: string]: unknown
}

export interface LogRecord {
  readonly timestamp: string
  readonly level: LogLevel
  readonly message: string
  readonly fields: LogFields
}

export interface LoggerSink {
  readonly write: (record: LogRecord) => Effect.Effect<void, never, never>
}

export interface LoggerOptions {
  /**
   * Minimum severity that should be written to sinks. Defaults to `info`.
   */
  readonly level?: LogLevel
  /**
   * Console formatter. `json` produces a single-line JSON payload, `pretty` produces a human-readable string.
   */
  readonly format?: 'json' | 'pretty'
  /**
   * Additional fields appended to every log entry.
   */
  readonly fields?: LogFields
  /**
   * Custom sinks for structured log consumption (e.g. pino transport, Loki, etc.).
   * When omitted the logger writes to `process.stdout` / `process.stderr`.
   */
  readonly sinks?: ReadonlyArray<LoggerSink>
  /**
   * Override timestamp factory – primarily for tests.
   */
  readonly timestamp?: () => string
}

export interface Logger {
  readonly level: LogLevel
  readonly log: (level: LogLevel, message: string, fields?: LogFields) => Effect.Effect<void, never, never>
  readonly debug: (message: string, fields?: LogFields) => Effect.Effect<void, never, never>
  readonly info: (message: string, fields?: LogFields) => Effect.Effect<void, never, never>
  readonly warn: (message: string, fields?: LogFields) => Effect.Effect<void, never, never>
  readonly error: (message: string, fields?: LogFields) => Effect.Effect<void, never, never>
  /**
   * Returns a derived logger that automatically appends `fields` to every entry.
   */
  readonly with: (fields: LogFields) => Logger
}

const LOG_LEVEL_ORDER: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']
const LOG_LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export const DEFAULT_LOG_LEVEL: LogLevel = 'info'

export const normalizeLogLevel = (value: string | undefined | null): LogLevel => {
  if (!value) {
    return DEFAULT_LOG_LEVEL
  }
  const normalized = value.trim().toLowerCase()
  if (LOG_LEVEL_ORDER.includes(normalized as LogLevel)) {
    return normalized as LogLevel
  }
  return DEFAULT_LOG_LEVEL
}

interface LoggerContext {
  readonly level: LogLevel
  readonly baseFields: LogFields
  readonly sinks: ReadonlyArray<LoggerSink>
  readonly timestamp: () => string
}

class LoggerImpl implements Logger {
  readonly #context: LoggerContext

  constructor(context: LoggerContext) {
    this.#context = context
  }

  get level(): LogLevel {
    return this.#context.level
  }

  log(level: LogLevel, message: string, fields?: LogFields): Effect.Effect<void, never, never> {
    if (!shouldLog(level, this.#context.level)) {
      return Effect.void
    }

    const record: LogRecord = {
      level,
      message,
      timestamp: this.#context.timestamp(),
      fields: mergeFields(this.#context.baseFields, fields),
    }

    return Effect.forEach(this.#context.sinks, (sink) => sink.write(record), {
      concurrency: 'inherit',
      discard: true,
    })
  }

  debug(message: string, fields?: LogFields): Effect.Effect<void, never, never> {
    return this.log('debug', message, fields)
  }

  info(message: string, fields?: LogFields): Effect.Effect<void, never, never> {
    return this.log('info', message, fields)
  }

  warn(message: string, fields?: LogFields): Effect.Effect<void, never, never> {
    return this.log('warn', message, fields)
  }

  error(message: string, fields?: LogFields): Effect.Effect<void, never, never> {
    return this.log('error', message, fields)
  }

  with(fields: LogFields): Logger {
    return new LoggerImpl({
      ...this.#context,
      baseFields: mergeFields(this.#context.baseFields, fields),
    })
  }
}

const shouldLog = (entryLevel: LogLevel, threshold: LogLevel): boolean =>
  LOG_LEVEL_WEIGHT[entryLevel] >= LOG_LEVEL_WEIGHT[threshold]

const mergeFields = (base: LogFields, patch?: LogFields): LogFields => {
  if (!patch || Object.keys(patch).length === 0) {
    return { ...base }
  }
  return { ...base, ...patch }
}

const defaultTimestamp = (): string => new Date().toISOString()

const makeConsoleSink = (format: 'json' | 'pretty'): LoggerSink => ({
  write(record) {
    return Effect.sync(() => {
      const payload = {
        timestamp: record.timestamp,
        level: record.level,
        message: record.message,
        ...record.fields,
      }

      if (format === 'json') {
        const serialized = JSON.stringify(payload)
        forwardToConsole(record.level, serialized)
        return
      }

      const { message, level, timestamp, ...rest } = payload
      const fields = Object.keys(rest).length > 0 ? JSON.stringify(rest) : ''
      const formatted = `[${timestamp}] ${level.toUpperCase()} ${message}${fields ? ` ${fields}` : ''}`
      forwardToConsole(record.level, formatted)
    })
  },
})

const forwardToConsole = (level: LogLevel, payload: string) => {
  switch (level) {
    case 'debug':
    case 'info':
      console.log(payload)
      break
    case 'warn':
      console.warn(payload)
      break
    case 'error':
      console.error(payload)
      break
  }
}

export const createLogger = (options: LoggerOptions = {}): Logger => {
  const level = options.level ?? DEFAULT_LOG_LEVEL
  const sinkList =
    options.sinks && options.sinks.length > 0 ? options.sinks : [makeConsoleSink(options.format ?? 'json')]

  return new LoggerImpl({
    level,
    sinks: sinkList,
    baseFields: { ...(options.fields ?? {}) },
    timestamp: options.timestamp ?? defaultTimestamp,
  })
}

export const makeConsoleLogger = (options?: LoggerOptions): Logger => createLogger(options)
