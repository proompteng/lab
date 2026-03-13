export type LogLevel = 'info' | 'warn' | 'error'

export type Logger = {
  log: (level: LogLevel, action: string, fields?: Record<string, unknown>) => void
  child: (baseFields: Record<string, unknown>) => Logger
}

const stringifyValue = (value: unknown): string => {
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}

const buildMessage = (action: string, fields: Record<string, unknown>): string => {
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${stringifyValue(value)}`)
    .join(' ')
  return suffix.length > 0 ? `${action} ${suffix}` : action
}

export const createLogger = (baseFields: Record<string, unknown> = {}): Logger => {
  const emit = (level: LogLevel, action: string, fields: Record<string, unknown> = {}) => {
    const payload = {
      ts: new Date().toISOString(),
      level,
      action,
      message: buildMessage(action, { ...baseFields, ...fields }),
      ...baseFields,
      ...fields,
    }
    const line = JSON.stringify(payload)
    if (level === 'error') {
      console.error(line)
      return
    }
    if (level === 'warn') {
      console.warn(line)
      return
    }
    console.log(line)
  }

  return {
    log: emit,
    child: (fields) => createLogger({ ...baseFields, ...fields }),
  }
}
