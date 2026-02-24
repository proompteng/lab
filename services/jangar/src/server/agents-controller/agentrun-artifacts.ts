import { asRecord } from '~/server/primitives-http'

export const DEFAULT_AGENTRUN_ARTIFACTS_MAX = 50
export const AGENTRUN_ARTIFACT_URL_MAX_LENGTH = 2048

export type AgentRunArtifactsLimitConfig = {
  maxEntries: number
  strict: boolean
  urlMaxLength: number
}

export type AgentRunArtifactsLimitResult = {
  artifacts: Array<Record<string, unknown>>
  trimmedCount: number
  strippedUrlCount: number
  droppedCount: number
  strictViolation: boolean
  reasons: string[]
}

const parseBooleanEnv = (value: string | undefined, fallback: boolean) => {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

const parseOptionalNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const normalizeArtifactString = (value: unknown) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export const resolveAgentRunArtifactsLimitConfig = (
  overrides: Partial<AgentRunArtifactsLimitConfig> = {},
): AgentRunArtifactsLimitConfig => {
  const parsedMax = parseOptionalNumber(process.env.JANGAR_AGENTRUN_ARTIFACTS_MAX)
  const maxFromEnv =
    parsedMax === undefined || !Number.isFinite(parsedMax) || parsedMax < 0 ? DEFAULT_AGENTRUN_ARTIFACTS_MAX : parsedMax

  const maxEntries = Math.min(
    DEFAULT_AGENTRUN_ARTIFACTS_MAX,
    Math.max(0, Math.floor(overrides.maxEntries ?? maxFromEnv)),
  )
  const strict = overrides.strict ?? parseBooleanEnv(process.env.JANGAR_AGENTRUN_ARTIFACTS_STRICT, false)
  return {
    maxEntries,
    strict,
    urlMaxLength: overrides.urlMaxLength ?? AGENTRUN_ARTIFACT_URL_MAX_LENGTH,
  }
}

export const limitAgentRunStatusArtifacts = (
  raw: unknown,
  config: AgentRunArtifactsLimitConfig,
): AgentRunArtifactsLimitResult => {
  const artifacts = Array.isArray(raw) ? raw : []
  const parsed: Array<Record<string, unknown>> = []
  let strippedUrlCount = 0
  let droppedCount = 0
  let strictViolation = false
  const reasons = new Set<string>()

  for (const item of artifacts) {
    const record = asRecord(item)
    if (!record) continue
    const name = normalizeArtifactString(record.name)
    if (!name) {
      droppedCount += 1
      reasons.add('MissingName')
      continue
    }
    const path = normalizeArtifactString(record.path)
    const key = normalizeArtifactString(record.key)
    const url = normalizeArtifactString(record.url)

    const next: Record<string, unknown> = { name }
    if (path) next.path = path
    if (key) next.key = key

    if (url) {
      const isInline = url.startsWith('data:')
      const tooLong = url.length > config.urlMaxLength
      if (isInline || tooLong) {
        strippedUrlCount += 1
        reasons.add(isInline ? 'InlineUrlDisallowed' : 'UrlTooLong')
        if (config.strict) strictViolation = true
      } else {
        next.url = url
      }
    }

    parsed.push(next)
  }

  if (parsed.length <= config.maxEntries) {
    return {
      artifacts: parsed,
      trimmedCount: 0,
      strippedUrlCount,
      droppedCount,
      strictViolation,
      reasons: Array.from(reasons),
    }
  }

  const overflow = config.maxEntries === 0 ? parsed.length : parsed.length - config.maxEntries
  reasons.add('TooManyArtifacts')
  if (config.strict) strictViolation = true

  return {
    artifacts: overflow > 0 ? parsed.slice(overflow) : parsed,
    trimmedCount: Math.max(0, overflow),
    strippedUrlCount,
    droppedCount,
    strictViolation,
    reasons: Array.from(reasons),
  }
}

export const buildArtifactsLimitMessage = (result: AgentRunArtifactsLimitResult) => {
  const parts: string[] = []
  if (result.trimmedCount > 0) {
    parts.push(`dropped ${result.trimmedCount} oldest artifact(s)`)
  }
  if (result.strippedUrlCount > 0) {
    parts.push(`stripped ${result.strippedUrlCount} artifact url(s)`)
  }
  if (result.droppedCount > 0) {
    parts.push(`dropped ${result.droppedCount} invalid artifact(s)`)
  }
  const reasons = result.reasons.length > 0 ? ` (${result.reasons.join(', ')})` : ''
  if (parts.length === 0) return `artifacts within limits${reasons}`
  return `${parts.join(', ')}${reasons}`
}
