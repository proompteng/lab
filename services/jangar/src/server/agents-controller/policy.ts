import { asRecord, asString, readNested } from '~/server/primitives-http'

import { parseEnvStringList } from './env-config'

export type ImagePolicyCandidate = {
  image: string
  context?: string
}

type AuthSecretLike = {
  name: string
  key?: string
}

const CODEX_API_AUTH_MODES = new Set(['api', 'api_key', 'openai_api'])

const normalizeOptionalString = (value: unknown) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const findStringByKey = (value: unknown, keys: Set<string>, depth = 0): string | null => {
  if (depth > 6 || value === null || value === undefined) return null
  if (typeof value === 'string') {
    return normalizeOptionalString(value)
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findStringByKey(entry, keys, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  for (const [key, entry] of Object.entries(record)) {
    if (keys.has(key)) {
      const found = normalizeOptionalString(entry)
      if (found) return found
    }
  }
  for (const entry of Object.values(record)) {
    const found = findStringByKey(entry, keys, depth + 1)
    if (found) return found
  }
  return null
}

export const isAutonomousCodexProvider = (provider: Record<string, unknown>) => {
  const spec = asRecord(provider.spec) ?? provider
  const binary = asString(spec.binary) ?? ''
  const envTemplate = asRecord(spec.envTemplate) ?? {}
  const inputFiles = Array.isArray(spec.inputFiles) ? spec.inputFiles : []
  const providerPath = asString(envTemplate.AGENT_PROVIDER_PATH) ?? ''
  if (binary.includes('codex')) return true
  if (binary.includes('agent-runner') && providerPath.startsWith('/root/.codex/provider-')) return true
  return inputFiles.some((entry) => {
    const path = asString(readNested(entry, ['path'])) ?? ''
    return path.startsWith('/root/.codex/')
  })
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const matchesPattern = (value: string, pattern: string) => {
  if (pattern === '*') return true
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`)
  return regex.test(value)
}

export const matchesAnyPattern = (value: string, patterns: string[]) =>
  patterns.some((pattern) => matchesPattern(value, pattern))

export const normalizeLabelMap = (labels: Record<string, unknown>) => {
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(labels)) {
    if (!key) continue
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed) continue
    output[key] = trimmed
  }
  return output
}

export const validateLabelPolicy = (labels: Record<string, string>) => {
  const required = parseEnvStringList('JANGAR_AGENTS_CONTROLLER_LABELS_REQUIRED')
  const allowed = parseEnvStringList('JANGAR_AGENTS_CONTROLLER_LABELS_ALLOWED')
  const denied = parseEnvStringList('JANGAR_AGENTS_CONTROLLER_LABELS_DENIED')

  if (required.length > 0) {
    const missing = required.filter((key) => !labels[key])
    if (missing.length > 0) {
      return {
        ok: false as const,
        reason: 'MissingRequiredLabels',
        message: `missing required labels: ${missing.join(', ')}`,
      }
    }
  }

  const labelKeys = Object.keys(labels)
  if (denied.length > 0) {
    const blocked = labelKeys.filter((key) => matchesAnyPattern(key, denied))
    if (blocked.length > 0) {
      return {
        ok: false as const,
        reason: 'LabelBlocked',
        message: `labels blocked by controller policy: ${blocked.join(', ')}`,
      }
    }
  }

  if (allowed.length > 0) {
    const disallowed = labelKeys.filter((key) => !matchesAnyPattern(key, allowed))
    if (disallowed.length > 0) {
      return {
        ok: false as const,
        reason: 'LabelNotAllowed',
        message: `labels not allowed by controller policy: ${disallowed.join(', ')}`,
      }
    }
  }

  return { ok: true as const }
}

export const validateImagePolicy = (images: ImagePolicyCandidate[]) => {
  const allowed = parseEnvStringList('JANGAR_AGENTS_CONTROLLER_IMAGES_ALLOWED')
  const denied = parseEnvStringList('JANGAR_AGENTS_CONTROLLER_IMAGES_DENIED')
  if (images.length === 0) return { ok: true as const }

  for (const entry of images) {
    const { image, context } = entry
    if (denied.length > 0 && matchesAnyPattern(image, denied)) {
      return {
        ok: false as const,
        reason: 'ImageBlocked',
        message: context
          ? `image ${image} for ${context} is blocked by controller policy`
          : `image ${image} is blocked by controller policy`,
      }
    }
    if (allowed.length > 0 && !matchesAnyPattern(image, allowed)) {
      return {
        ok: false as const,
        reason: 'ImageNotAllowed',
        message: context
          ? `image ${image} for ${context} is not allowed by controller policy`
          : `image ${image} is not allowed by controller policy`,
      }
    }
  }

  return { ok: true as const }
}

export const validateAuthSecretPolicy = (allowedSecrets: string[], authSecret: AuthSecretLike | null) => {
  if (!authSecret) return { ok: true as const }
  if (allowedSecrets.length > 0 && !allowedSecrets.includes(authSecret.name)) {
    return {
      ok: false as const,
      reason: 'SecretNotAllowed',
      message: `auth secret ${authSecret.name} is not allowlisted by the Agent`,
    }
  }
  return { ok: true as const }
}

export const validateAutonomousCodexAuthSecret = (input: {
  provider: Record<string, unknown>
  authSecret: AuthSecretLike | null
  secret: Record<string, unknown> | null
  secretValue: string | null
}) => {
  if (!isAutonomousCodexProvider(input.provider)) {
    return { ok: true as const }
  }
  if (!input.authSecret) {
    return {
      ok: false as const,
      reason: 'MissingAuthSecretConfig',
      message: 'autonomous Codex providers require JANGAR_AGENTS_CONTROLLER_AUTH_SECRET_* configuration',
    }
  }
  if (!input.secret) {
    return {
      ok: false as const,
      reason: 'AuthSecretNotFound',
      message: `auth secret ${input.authSecret.name} not found`,
    }
  }
  const secretValue = normalizeOptionalString(input.secretValue)
  if (!secretValue) {
    return {
      ok: false as const,
      reason: 'InvalidAuthSecret',
      message: `auth secret ${input.authSecret.name} key ${input.authSecret.key ?? 'auth.json'} is empty`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(secretValue)
  } catch (error) {
    return {
      ok: false as const,
      reason: 'InvalidAuthSecret',
      message: `auth secret ${input.authSecret.name} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const record = asRecord(parsed)
  if (!record) {
    return {
      ok: false as const,
      reason: 'InvalidAuthSecret',
      message: `auth secret ${input.authSecret.name} must contain a JSON object`,
    }
  }

  const authMode = normalizeOptionalString(record.auth_mode)?.toLowerCase() ?? null
  if (authMode === 'chatgpt') {
    return {
      ok: false as const,
      reason: 'UnsupportedAuthMode',
      message: `auth secret ${input.authSecret.name} uses unsupported chatgpt auth_mode; autonomous Codex providers require API-backed credentials`,
    }
  }
  if (authMode && !CODEX_API_AUTH_MODES.has(authMode)) {
    return {
      ok: false as const,
      reason: 'UnsupportedAuthMode',
      message: `auth secret ${input.authSecret.name} uses unsupported auth_mode ${authMode}; expected API-backed credentials`,
    }
  }

  const apiKey = findStringByKey(record, new Set(['OPENAI_API_KEY', 'openai_api_key', 'apiKey', 'api_key']))
  if (!apiKey) {
    return {
      ok: false as const,
      reason: 'MissingOpenAIApiKey',
      message: `auth secret ${input.authSecret.name} must include OPENAI_API_KEY for autonomous Codex providers`,
    }
  }

  return { ok: true as const }
}
