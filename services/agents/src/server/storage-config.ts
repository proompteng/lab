type EnvSource = Record<string, string | undefined>

const DEFAULT_DATABASE_POOL_MAX = 4

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

const readAgentsEnv = (env: EnvSource, agentsName: string, legacyJangarName?: string) =>
  normalizeNonEmpty(env[agentsName]) ?? (legacyJangarName ? normalizeNonEmpty(env[legacyJangarName]) : null)

export type AgentsDatabaseConfig = {
  url: string | null
  sslMode: string | null
  caCertPath: string | null
  poolMax: number
  connectTimeoutMs: number
  queryTimeoutMs: number
}

export const resolveAgentsDatabaseConfig = (env: EnvSource = process.env): AgentsDatabaseConfig => ({
  url: normalizeNonEmpty(env.DATABASE_URL),
  sslMode: normalizeNonEmpty(env.PGSSLMODE),
  caCertPath: normalizeNonEmpty(env.PGSSLROOTCERT) ?? readAgentsEnv(env, 'AGENTS_DB_CA_CERT', 'JANGAR_DB_CA_CERT'),
  poolMax: parsePositiveInt(
    readAgentsEnv(env, 'AGENTS_DB_POOL_MAX', 'JANGAR_DB_POOL_MAX') ?? env.PGPOOL_MAX,
    DEFAULT_DATABASE_POOL_MAX,
  ),
  connectTimeoutMs: parsePositiveInt(env.PGCONNECT_TIMEOUT_MS, 10_000),
  queryTimeoutMs: parsePositiveInt(env.PGQUERY_TIMEOUT_MS, 30_000),
})

export const validateAgentsStorageConfig = (
  env: EnvSource = process.env,
  options?: { enforceProductionDatabase?: boolean },
) => {
  const database = resolveAgentsDatabaseConfig(env)
  if (options?.enforceProductionDatabase && !database.url) {
    throw new Error('DATABASE_URL is required for Agents production runtime')
  }
}
