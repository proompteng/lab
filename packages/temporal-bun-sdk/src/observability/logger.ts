import { Effect } from 'effect'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFormat = 'json' | 'pretty'

export interface LogFields {
  readonly [key: string]: unknown
}

export interface LogEntry {
  readonly timestamp: string
  readonly level: LogLevel
  readonly message: string
  readonly fields?: LogFields
}

export type LogFormatter = (entry: LogEntry) => string

export interface LogSink {
  readonly write: (entry: LogEntry) => void
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const formatPretty: LogFormatter = ({ timestamp, level, message, fields }) => {
  const payload = fields ? ` ${JSON.stringify(fields)}` : ''
  return `[${timestamp}] ${level.toUpperCase()} ${message}${payload}`
}

const formatJson: LogFormatter = ({ timestamp, level, message, fields }) =>
  JSON.stringify({ timestamp, level, message, fields })

export const logFormatters: Record<LogFormat, LogFormatter> = {
  json: formatJson,
  pretty: formatPretty,
}

const consoleMethodForLevel = (level: LogLevel): ((...args: unknown[]) => void) => {
  const method = console[level]
  if (typeof method === 'function') {
    return method.bind(console)
  }
  return console.log.bind(console)
}

const makeConsoleSink = (formatter: LogFormatter): LogSink => ({
  write(entry) {
    const formatted = formatter(entry)
    const writer = consoleMethodForLevel(entry.level)
    writer(formatted)
  },
})

export interface LoggerConfig {
  readonly sink?: LogSink
  readonly level?: LogLevel
  readonly format?: LogFormat
}

export interface Logger {
  readonly log: (level: LogLevel, message: string, fields?: LogFields) => Effect.Effect<void, never, never>
}

export const makeLogger = (config: LoggerConfig = {}): Logger => {
  const minimumLevel = config.level ?? 'info'
  const formatter = logFormatters[config.format ?? 'pretty']
  const sink = config.sink ?? makeConsoleSink(formatter)

  return {
    log(level, message, fields) {
      if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[minimumLevel]) {
        return Effect.void
      }
      const entry: LogEntry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        fields,
      }
      return Effect.sync(() => {
        sink.write(entry)
      })
    },
  }
}

export const makeConsoleLogger = (): Logger => makeLogger({ level: 'debug', format: 'pretty' })
