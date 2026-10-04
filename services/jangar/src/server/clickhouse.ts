import { resolveClickHouseConfig as resolveConfiguredClickHouseConfig } from './storage-config'

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

export const resolveClickHouseConfig = (): ValidationResult<ClickHouseConfig> => {
  try {
    const configured = resolveConfiguredClickHouseConfig()
    const host = configured.host?.trim() ?? ''
    if (!host) return { ok: false, message: 'CH_HOST is not configured' }

    const user = configured.user?.trim() ?? ''
    if (!user) return { ok: false, message: 'CH_USER is not configured' }

    const password = configured.password ?? ''
    if (!password) return { ok: false, message: 'CH_PASSWORD is not configured' }

    return {
      ok: true,
      value: {
        host,
        port: configured.port,
        user,
        password,
        database: configured.database,
        secure: configured.secure,
        timeoutMs: configured.timeoutMs,
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
      } catch {
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
