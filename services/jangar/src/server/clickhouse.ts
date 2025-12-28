export type ClickHouseConfig = {
  host: string
  port: number
  user: string
  password: string
  database: string
  secure: boolean
  timeoutMs: number
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string }

const DEFAULT_PORT = 8123
const DEFAULT_DATABASE = 'default'
const DEFAULT_TIMEOUT_MS = 15000

const normalizeEnv = (value: string | undefined) => (value ?? '').trim()

const parseBoolean = (value: string | undefined) => {
  const normalized = normalizeEnv(value).toLowerCase()
  if (!normalized) return false
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  throw new Error('CH_SECURE must be true or false')
}

const parsePositiveInt = (value: string | undefined, field: string, fallback: number) => {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`)
  }
  return parsed
}

export const resolveClickHouseConfig = (): ValidationResult<ClickHouseConfig> => {
  try {
    const host = normalizeEnv(process.env.CH_HOST)
    if (!host) return { ok: false, message: 'CH_HOST is not configured' }

    const user = normalizeEnv(process.env.CH_USER)
    if (!user) return { ok: false, message: 'CH_USER is not configured' }

    const password = process.env.CH_PASSWORD ?? ''
    if (!password) return { ok: false, message: 'CH_PASSWORD is not configured' }

    const port = parsePositiveInt(process.env.CH_PORT, 'CH_PORT', DEFAULT_PORT)
    const database = normalizeEnv(process.env.CH_DATABASE) || DEFAULT_DATABASE
    const secure = parseBoolean(process.env.CH_SECURE)
    const timeoutMs = parsePositiveInt(process.env.CH_TIMEOUT_MS, 'CH_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)

    return {
      ok: true,
      value: {
        host,
        port,
        user,
        password,
        database,
        secure,
        timeoutMs,
      },
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Invalid ClickHouse configuration',
    }
  }
}

export type ClickHouseParamValue = string | number | boolean | Date
export type ClickHouseParams = Record<string, ClickHouseParamValue>

export type ClickHouseClient = {
  queryJson: <T = Record<string, unknown>>(query: string, params?: ClickHouseParams) => Promise<T[]>
}

const encodeParamValue = (value: ClickHouseParamValue) => {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? '1' : '0'
  return String(value)
}

const ensureJsonFormat = (query: string) => {
  const trimmed = query.trim().replace(/;$/, '')
  if (/\bformat\s+json\b/i.test(trimmed)) return trimmed
  return `${trimmed}\nFORMAT JSON`
}

export const createClickHouseClient = (config: ClickHouseConfig): ClickHouseClient => {
  const protocol = config.secure ? 'https' : 'http'
  const baseUrl = `${protocol}://${config.host}:${config.port}/`
  const headers: Record<string, string> = {
    'content-type': 'text/plain; charset=utf-8',
    'x-clickhouse-user': config.user,
    'x-clickhouse-key': config.password,
  }

  const queryJson = async <T = Record<string, unknown>>(query: string, params?: ClickHouseParams) => {
    const searchParams = new URLSearchParams()
    searchParams.set('database', config.database)

    if (params) {
      for (const [name, param] of Object.entries(params)) {
        if (param === undefined) continue
        searchParams.set(`param_${name}`, encodeParamValue(param))
      }
    }

    const url = `${baseUrl}?${searchParams.toString()}`
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), config.timeoutMs)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: ensureJsonFormat(query),
        signal: controller.signal,
      })

      const bodyText = await response.text()
      if (!response.ok) {
        throw new Error(`ClickHouse request failed (${response.status}): ${bodyText}`)
      }

      let parsed: { data?: T[] }
      try {
        parsed = JSON.parse(bodyText) as { data?: T[] }
      } catch (_error) {
        throw new Error('ClickHouse response was not valid JSON')
      }

      if (!parsed.data || !Array.isArray(parsed.data)) {
        throw new Error('ClickHouse response missing data payload')
      }

      return parsed.data
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`ClickHouse request timed out after ${config.timeoutMs}ms`)
      }
      throw error
    } finally {
      clearTimeout(timeoutHandle)
    }
  }

  return { queryJson }
}

export type ClickHouseClientResult = { ok: true; client: ClickHouseClient } | { ok: false; message: string }

export const resolveClickHouseClient = (): ClickHouseClientResult => {
  const configResult = resolveClickHouseConfig()
  if (!configResult.ok) return { ok: false, message: configResult.message }
  return { ok: true, client: createClickHouseClient(configResult.value) }
}
