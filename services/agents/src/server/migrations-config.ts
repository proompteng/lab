type EnvSource = Record<string, string | undefined>

export type AgentsMigrationsMode = 'auto' | 'skip'

export type AgentsMigrationsConfig = {
  mode: AgentsMigrationsMode
  allowUnorderedMigrations: boolean
  skipMigrations: boolean
}

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const readAgentsEnv = (env: EnvSource, agentsName: string, legacyJangarName?: string) =>
  normalizeNonEmpty(env[agentsName]) ?? (legacyJangarName ? normalizeNonEmpty(env[legacyJangarName]) : null)

export const resolveAgentsMigrationsConfig = (env: EnvSource = process.env): AgentsMigrationsConfig => {
  const rawMode = readAgentsEnv(env, 'AGENTS_MIGRATIONS', 'JANGAR_MIGRATIONS')?.toLowerCase()
  const mode: AgentsMigrationsMode =
    rawMode && ['skip', 'disabled', 'false', '0', 'off'].includes(rawMode) ? 'skip' : 'auto'
  const unorderedRaw = readAgentsEnv(
    env,
    'AGENTS_ALLOW_UNORDERED_MIGRATIONS',
    'JANGAR_ALLOW_UNORDERED_MIGRATIONS',
  )?.toLowerCase()
  const allowUnorderedMigrations = !unorderedRaw || !['false', '0', 'off', 'disabled', 'no'].includes(unorderedRaw)
  return {
    mode,
    allowUnorderedMigrations,
    skipMigrations: env.AGENTS_SKIP_MIGRATIONS === '1' || env.JANGAR_SKIP_MIGRATIONS === '1' || mode === 'skip',
  }
}

export const validateAgentsMigrationsConfig = (env: EnvSource = process.env) => {
  resolveAgentsMigrationsConfig(env)
}
