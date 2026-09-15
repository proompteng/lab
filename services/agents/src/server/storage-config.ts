import { normalizeEnvValue, parsePositiveIntEnv, readAgentsEnv, type EnvSource } from './runtime-env'

const DEFAULT_DATABASE_POOL_MAX = 4

export type AgentsDatabaseConfig = {
  url: string | null
  sslMode: string | null
  caCertPath: string | null
  poolMax: number
  connectTimeoutMs: number
  queryTimeoutMs: number
}

export const resolveAgentsDatabaseConfig = (env: EnvSource = process.env): AgentsDatabaseConfig => ({
  url: normalizeEnvValue(env.DATABASE_URL),
  sslMode: normalizeEnvValue(env.PGSSLMODE),
  caCertPath: normalizeEnvValue(env.PGSSLROOTCERT) ?? readAgentsEnv(env, 'AGENTS_DB_CA_CERT'),
  poolMax: parsePositiveIntEnv(readAgentsEnv(env, 'AGENTS_DB_POOL_MAX') ?? env.PGPOOL_MAX, DEFAULT_DATABASE_POOL_MAX),
  connectTimeoutMs: parsePositiveIntEnv(env.PGCONNECT_TIMEOUT_MS, 10_000),
  queryTimeoutMs: parsePositiveIntEnv(env.PGQUERY_TIMEOUT_MS, 30_000),
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
