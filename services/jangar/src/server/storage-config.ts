import { tmpdir } from 'node:os'
import { join } from 'node:path'

type EnvSource = Record<string, string | undefined>

const DEFAULT_REDIS_CHAT_PREFIX = 'openwebui:chat'
const DEFAULT_REDIS_RENDER_PREFIX = 'jangar:openwebui:render'
const DEFAULT_REDIS_TRANSCRIPT_PREFIX = 'openwebui:transcript'
const DEFAULT_WORKTREE_PREFIX = 'openwebui:worktree'
const DEFAULT_CLICKHOUSE_PORT = 8443
const DEFAULT_CLICKHOUSE_DATABASE = 'torghut'
const DEFAULT_CLICKHOUSE_TIMEOUT_MS = 10_000

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const normalizePrefix = (value: string | undefined, fallback: string) =>
  (normalizeNonEmpty(value) ?? fallback).replace(/:+$/, '')

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  const normalized = normalizeNonEmpty(value)?.toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

export type DatabaseConfig = {
  url: string | null
  sslMode: string | null
  caCertPath: string | null
  connectTimeoutMs: number
  queryTimeoutMs: number
}

export type RedisConfig = {
  url: string | null
  chatKeyPrefix: string
  transcriptKeyPrefix: string
  renderKeyPrefix: string
  renderDirectory: string
  renderStoreMode: string | null
  renderStoreDebug: boolean
  worktreeKeyPrefix: string
}

export type ClickHouseConfig = {
  host: string | null
  user: string | null
  password: string
  port: number
  database: string
  secure: boolean
  timeoutMs: number
}

export const resolveDatabaseConfig = (env: EnvSource = process.env): DatabaseConfig => ({
  url: normalizeNonEmpty(env.DATABASE_URL),
  sslMode: normalizeNonEmpty(env.PGSSLMODE),
  caCertPath: normalizeNonEmpty(env.PGSSLROOTCERT) ?? normalizeNonEmpty(env.JANGAR_DB_CA_CERT),
  connectTimeoutMs: parsePositiveInt(env.PGCONNECT_TIMEOUT_MS, 10_000),
  queryTimeoutMs: parsePositiveInt(env.PGQUERY_TIMEOUT_MS, 30_000),
})

export const resolveRedisConfig = (env: EnvSource = process.env): RedisConfig => {
  const renderKeyPrefix = normalizePrefix(env.JANGAR_OPENWEBUI_RENDER_KEY_PREFIX, DEFAULT_REDIS_RENDER_PREFIX)
  return {
    url: normalizeNonEmpty(env.JANGAR_REDIS_URL),
    chatKeyPrefix: normalizePrefix(env.JANGAR_CHAT_KEY_PREFIX, DEFAULT_REDIS_CHAT_PREFIX),
    transcriptKeyPrefix: normalizePrefix(env.JANGAR_TRANSCRIPT_KEY_PREFIX, DEFAULT_REDIS_TRANSCRIPT_PREFIX),
    renderKeyPrefix,
    renderDirectory: normalizeNonEmpty(env.JANGAR_OPENWEBUI_RENDER_DIRECTORY) ?? join(tmpdir(), renderKeyPrefix),
    renderStoreMode: normalizeNonEmpty(env.JANGAR_OPENWEBUI_RENDER_STORE_MODE),
    renderStoreDebug: parseBoolean(env.JANGAR_DEBUG_OPENWEBUI_RENDER_STORE, false),
    worktreeKeyPrefix: normalizePrefix(env.JANGAR_WORKTREE_KEY_PREFIX, DEFAULT_WORKTREE_PREFIX),
  }
}

export const resolveClickHouseConfig = (env: EnvSource = process.env): ClickHouseConfig => ({
  host: normalizeNonEmpty(env.CH_HOST),
  user: normalizeNonEmpty(env.CH_USER),
  password: env.CH_PASSWORD ?? '',
  port: parsePositiveInt(env.CH_PORT, DEFAULT_CLICKHOUSE_PORT),
  database: normalizeNonEmpty(env.CH_DATABASE) ?? DEFAULT_CLICKHOUSE_DATABASE,
  secure: parseBoolean(env.CH_SECURE, true),
  timeoutMs: parsePositiveInt(env.CH_TIMEOUT_MS, DEFAULT_CLICKHOUSE_TIMEOUT_MS),
})

export const validateStorageConfig = (
  env: EnvSource = process.env,
  options?: { enforceProductionDatabase?: boolean },
) => {
  const database = resolveDatabaseConfig(env)
  if (options?.enforceProductionDatabase && !database.url) {
    throw new Error('DATABASE_URL is required for Jangar production runtime')
  }

  const clickhouse = resolveClickHouseConfig(env)
  if (clickhouse.host && !clickhouse.user) {
    throw new Error('CH_USER is required when CH_HOST is configured')
  }

  resolveRedisConfig(env)
}
