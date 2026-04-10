import { resolveAgentsControllerBehaviorConfig } from './runtime-config'

type LogLevel = 'info' | 'warn' | 'error'

type LogPayload = Record<string, unknown>

const COMPONENT = 'agents-controller'

const normalizeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

const writeLog = (level: LogLevel, event: string, payload: LogPayload = {}) => {
  const entry = {
    component: COMPONENT,
    event,
    ...payload,
  }
  const message = `[jangar][${COMPONENT}] ${event}`
  if (level === 'error') {
    console.error(message, entry)
    return
  }
  if (level === 'warn') {
    console.warn(message, entry)
    return
  }
  console.info(message, entry)
}

export const isAgentsControllerDebugLoggingEnabled = () => resolveAgentsControllerBehaviorConfig(process.env).debugLogs

export const logAgentsControllerInfo = (event: string, payload?: LogPayload) => {
  writeLog('info', event, payload)
}

export const logAgentsControllerWarn = (event: string, payload?: LogPayload) => {
  writeLog('warn', event, payload)
}

export const logAgentsControllerError = (event: string, payload?: LogPayload) => {
  writeLog('error', event, payload)
}

export const logAgentsControllerDebug = (event: string, payload?: LogPayload) => {
  if (!isAgentsControllerDebugLoggingEnabled()) return
  writeLog('info', event, payload)
}

export const toLogError = (error: unknown) => ({
  error: normalizeError(error),
})
