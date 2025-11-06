import { Effect } from 'effect'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogFields {
  readonly [key: string]: unknown
}

export interface Logger {
  readonly log: (level: LogLevel, message: string, fields?: LogFields) => Effect.Effect<void, never, never>
}

export const makeConsoleLogger = (): Logger => ({
  log(level, message, fields) {
    // TODO(TBS-004): Integrate with structured logging sinks and add bunyan/pino compatible adapters.
    return Effect.sync(() => {
      const payload = fields ? `${message} ${JSON.stringify(fields)}` : message
      switch (level) {
        case 'debug':
          console.debug(payload)
          break
        case 'info':
          console.info(payload)
          break
        case 'warn':
          console.warn(payload)
          break
        case 'error':
          console.error(payload)
          break
      }
    })
  },
})
