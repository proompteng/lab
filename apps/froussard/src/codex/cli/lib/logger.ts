import { createWriteStream, type WriteStream } from 'node:fs'
import { ensureFileDirectory } from './fs'

export interface CodexLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  flush: () => Promise<void>
  logPath?: string
}

export interface CreateCodexLoggerOptions {
  logPath?: string
  context?: Record<string, string | undefined>
}

export const consoleLogger: CodexLogger = {
  info: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => console.debug(...args),
  flush: async () => {},
}

export const createCodexLogger = async ({ logPath, context }: CreateCodexLoggerOptions = {}): Promise<CodexLogger> => {
  const sanitizedContext = sanitizeContext(context)
  let stream: WriteStream | undefined

  if (logPath) {
    await ensureFileDirectory(logPath)
    stream = createWriteStream(logPath, { flags: 'w' })
  }

  const writeEntry = (level: LogLevel, args: unknown[]) => {
    if (!stream) {
      return
    }

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message: formatLogMessage(args),
      ...sanitizedContext,
    }

    writeLine(stream, JSON.stringify(entry)).catch((error: Error) => {
      console.error('Failed to write Codex log entry', error)
    })
  }

  const logWithLevel = (level: LogLevel, consoleFn: (...args: unknown[]) => void, args: unknown[]) => {
    consoleFn(...args)
    writeEntry(level, args)
  }

  const flush = async () => {
    if (!stream) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      stream?.end((error: Error | null | undefined) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
    stream = undefined
  }

  return {
    info: (...args: unknown[]) => logWithLevel('info', console.log, args),
    warn: (...args: unknown[]) => logWithLevel('warn', console.warn, args),
    error: (...args: unknown[]) => logWithLevel('error', console.error, args),
    debug: (...args: unknown[]) => logWithLevel('debug', console.debug, args),
    flush,
    logPath,
  }
}

type LogLevel = 'info' | 'warn' | 'error' | 'debug'

const writeLine = (stream: WriteStream, content: string) => {
  return new Promise<void>((resolve, reject) => {
    stream.write(`${content}\n`, (error: Error | null | undefined) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

const sanitizeContext = (context?: Record<string, string | undefined>): Record<string, string> => {
  if (!context) {
    return {}
  }

  const entries: Record<string, string> = {}

  for (const [key, value] of Object.entries(context)) {
    if (!key) {
      continue
    }
    if (value === undefined || value === null) {
      continue
    }
    const sanitizedKey = key.trim().replace(/[^A-Za-z0-9_]/g, '_')
    if (!sanitizedKey) {
      continue
    }
    const normalizedValue = `${value}`.trim()
    if (!normalizedValue || normalizedValue === 'null') {
      continue
    }
    entries[sanitizedKey] = normalizedValue
  }

  return entries
}

const formatLogMessage = (args: unknown[]) => {
  return args
    .map((value) => {
      if (value instanceof Error) {
        return value.stack ?? value.message
      }
      if (typeof value === 'object' && value !== null) {
        try {
          return JSON.stringify(value)
        } catch {
          return String(value)
        }
      }
      return String(value)
    })
    .join(' ')
}
