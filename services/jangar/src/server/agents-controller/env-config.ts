import { asRecord } from '~/server/primitives-http'

export const parseBooleanEnv = (value: string | undefined, fallback: boolean) => {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

export const parseNumberEnv = (value: string | undefined, fallback: number, min = 0) => {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < min) return fallback
  return parsed
}

export const parseOptionalNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export const parseJsonEnv = (name: string) => {
  const raw = process.env[name]
  if (!raw) return null
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[jangar] invalid ${name} JSON: ${message}`)
    return null
  }
}

export const parseEnvRecord = (name: string) => asRecord(parseJsonEnv(name))

export const parseEnvArray = (name: string) => {
  const parsed = parseJsonEnv(name)
  return Array.isArray(parsed) ? parsed : null
}

export const parseStringList = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : []

export const parseEnvList = (name: string) => {
  const raw = process.env[name]
  if (!raw) return []
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

export const normalizeStringList = (values: unknown[]) =>
  values
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

export const parseEnvStringList = (name: string) => {
  const parsed = parseEnvArray(name)
  if (Array.isArray(parsed)) return normalizeStringList(parsed)
  return parseEnvList(name)
}
