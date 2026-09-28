import type { AuditEventRecord } from './primitives-store'
import { normalizeEnvValue, readAgentsEnv, type EnvSource } from './runtime-env'

type AuditSinkType = 'none' | 'stdout' | 'http'

type AuditHttpSinkConfig = {
  url: string
  headers: Record<string, string>
  timeoutMs: number
}

type AuditSinkConfig = { type: 'none' } | { type: 'stdout' } | { type: 'http'; http: AuditHttpSinkConfig }

const DEFAULT_HTTP_TIMEOUT_MS = 2000

const parseOptionalJsonRecord = (value: string | undefined) => {
  const trimmed = normalizeEnvValue(value)
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
  const trimmed = normalizeEnvValue(value)
  if (!trimmed) return null
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

let cachedConfig: AuditSinkConfig | null = null

export const resolveAgentsAuditSinkConfig = (env: EnvSource = process.env): AuditSinkConfig => {
  const type = (readAgentsEnv(env, 'AGENTS_AUDIT_SINK_TYPE') ?? 'none').trim().toLowerCase() as AuditSinkType

  if (type === 'stdout') {
    return { type: 'stdout' }
  }

  if (type === 'http') {
    const url = readAgentsEnv(env, 'AGENTS_AUDIT_SINK_HTTP_URL')
    if (!url) return { type: 'none' }
    return {
      type: 'http',
      http: {
        url,
        headers: parseOptionalJsonRecord(readAgentsEnv(env, 'AGENTS_AUDIT_SINK_HTTP_HEADERS_JSON') ?? undefined),
        timeoutMs:
          parseOptionalInt(readAgentsEnv(env, 'AGENTS_AUDIT_SINK_HTTP_TIMEOUT_MS') ?? undefined) ??
          DEFAULT_HTTP_TIMEOUT_MS,
      },
    }
  }

  return { type: 'none' }
}

const resolveConfig = (): AuditSinkConfig => {
  if (cachedConfig) return cachedConfig
  cachedConfig = resolveAgentsAuditSinkConfig(process.env)
  return cachedConfig
}

export const emitAuditEventToOptionalSink = async (event: AuditEventRecord) => {
  const config = resolveConfig()
  if (config.type === 'none') return

  if (config.type === 'stdout') {
    console.info('[agents][audit]', {
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
