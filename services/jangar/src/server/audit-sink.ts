import type { AuditEventRecord } from '~/server/primitives-store'

type AuditSinkType = 'none' | 'stdout' | 'http'

type AuditHttpSinkConfig = {
  url: string
  headers: Record<string, string>
  timeoutMs: number
}

type AuditSinkConfig = { type: 'none' } | { type: 'stdout' } | { type: 'http'; http: AuditHttpSinkConfig }

const DEFAULT_HTTP_TIMEOUT_MS = 2000

const normalizeString = (value: string | undefined) => {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

const parseOptionalJsonRecord = (value: string | undefined) => {
  const trimmed = normalizeString(value)
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const output: Record<string, string> = {}
    for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (raw == null) continue
      output[key] = typeof raw === 'string' ? raw : JSON.stringify(raw)
    }
    return output
  } catch {
    return {}
  }
}

const parseOptionalInt = (value: string | undefined) => {
  const trimmed = normalizeString(value)
  if (!trimmed) return null
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

let cachedConfig: AuditSinkConfig | null = null

const resolveConfig = (): AuditSinkConfig => {
  if (cachedConfig) return cachedConfig

  const rawType = normalizeString(process.env.JANGAR_AUDIT_SINK_TYPE)?.toLowerCase() ?? 'none'
  const type: AuditSinkType = rawType === 'stdout' || rawType === 'http' ? rawType : 'none'

  if (type === 'stdout') {
    cachedConfig = { type: 'stdout' }
    return cachedConfig
  }

  if (type === 'http') {
    const url = normalizeString(process.env.JANGAR_AUDIT_SINK_HTTP_URL)
    if (!url) {
      cachedConfig = { type: 'none' }
      return cachedConfig
    }
    const timeoutMs = parseOptionalInt(process.env.JANGAR_AUDIT_SINK_HTTP_TIMEOUT_MS) ?? DEFAULT_HTTP_TIMEOUT_MS
    const extraHeaders = parseOptionalJsonRecord(process.env.JANGAR_AUDIT_SINK_HTTP_HEADERS_JSON)
    cachedConfig = {
      type: 'http',
      http: {
        url,
        headers: { ...extraHeaders },
        timeoutMs,
      },
    }
    return cachedConfig
  }

  cachedConfig = { type: 'none' }
  return cachedConfig
}

export const emitAuditEventToOptionalSink = async (event: AuditEventRecord) => {
  const config = resolveConfig()
  if (config.type === 'none') return

  if (config.type === 'stdout') {
    console.info('[jangar][audit]', {
      id: event.id,
      entityType: event.entityType,
      entityId: event.entityId,
      eventType: event.eventType,
      createdAt: event.createdAt instanceof Date ? event.createdAt.toISOString() : String(event.createdAt),
      ...event.payload,
    })
    return
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.http.timeoutMs)
  try {
    await fetch(config.http.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...config.http.headers,
      },
      body: JSON.stringify({
        id: event.id,
        entityType: event.entityType,
        entityId: event.entityId,
        eventType: event.eventType,
        createdAt: event.createdAt instanceof Date ? event.createdAt.toISOString() : String(event.createdAt),
        payload: event.payload,
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

export const __test__ = {
  resetConfigCache: () => {
    cachedConfig = null
  },
}
