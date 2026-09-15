export enum DiagLogLevel {
  NONE = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4,
}

export interface DiagLogger {
  error?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  info?: (...args: unknown[]) => void
  debug?: (...args: unknown[]) => void
}

export class DiagConsoleLogger implements DiagLogger {
  error(...args: unknown[]): void {
    console.error(...args)
  }

  warn(...args: unknown[]): void {
    console.warn(...args)
  }

  info(...args: unknown[]): void {
    console.info(...args)
  }

  debug(...args: unknown[]): void {
    console.debug(...args)
  }
}

type DiagState = {
  logger: DiagLogger
  level: DiagLogLevel
}

const state: DiagState = {
  logger: new DiagConsoleLogger(),
  level: DiagLogLevel.ERROR,
}

const shouldLog = (level: DiagLogLevel) => state.level >= level && state.level !== DiagLogLevel.NONE

export const diag = {
  setLogger(logger: DiagLogger, level: DiagLogLevel = DiagLogLevel.INFO) {
    state.logger = logger
    state.level = level
  },
  error(...args: unknown[]) {
    if (shouldLog(DiagLogLevel.ERROR)) {
      state.logger.error?.(...args)
    }
  },
  warn(...args: unknown[]) {
    if (shouldLog(DiagLogLevel.WARN)) {
      state.logger.warn?.(...args)
    }
  },
  info(...args: unknown[]) {
    if (shouldLog(DiagLogLevel.INFO)) {
      state.logger.info?.(...args)
    }
  },
  debug(...args: unknown[]) {
    if (shouldLog(DiagLogLevel.DEBUG)) {
      state.logger.debug?.(...args)
    }
  },
}
