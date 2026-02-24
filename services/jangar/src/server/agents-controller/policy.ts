import { parseEnvStringList } from './env-config'

export type ImagePolicyCandidate = {
  image: string
  context?: string
}

type AuthSecretLike = {
  name: string
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
