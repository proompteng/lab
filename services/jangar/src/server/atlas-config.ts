import { resolveDatabaseConfig } from './storage-config'

type EnvSource = Record<string, string | undefined>

const DEFAULT_TIMEOUT_MS = 25_000

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const normalized = value?.trim()
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

export type AtlasRuntimeConfig = {
  searchTimeoutMs: number
  codeSearchTimeoutMs: number
  localMode: boolean
  databaseConfigured: boolean
}

export const resolveAtlasRuntimeConfig = (env: EnvSource = process.env): AtlasRuntimeConfig => ({
  searchTimeoutMs: parsePositiveInt(env.ATLAS_SEARCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  codeSearchTimeoutMs: parsePositiveInt(env.ATLAS_CODE_SEARCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  localMode: parseBoolean(env.ATLAS_LOCAL_MODE, false),
  databaseConfigured: Boolean(resolveDatabaseConfig(env).url),
})

export const validateAtlasRuntimeConfig = (env: EnvSource = process.env) => {
  resolveAtlasRuntimeConfig(env)
}
