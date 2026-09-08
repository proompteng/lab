import { normalizeEnvValue, readAgentsEnv, type EnvSource } from './runtime-env'

export type AgentsMigrationsMode = 'auto' | 'skip'

export type AgentsMigrationsConfig = {
  mode: AgentsMigrationsMode
  allowUnorderedMigrations: boolean
  skipMigrations: boolean
}

export const resolveAgentsMigrationsConfig = (env: EnvSource = process.env): AgentsMigrationsConfig => {
  const rawMode = readAgentsEnv(env, 'AGENTS_MIGRATIONS')?.toLowerCase()
  const mode: AgentsMigrationsMode =
    rawMode && ['skip', 'disabled', 'false', '0', 'off'].includes(rawMode) ? 'skip' : 'auto'
  const unorderedRaw = readAgentsEnv(env, 'AGENTS_ALLOW_UNORDERED_MIGRATIONS')?.toLowerCase()
  const allowUnorderedMigrations = !unorderedRaw || !['false', '0', 'off', 'disabled', 'no'].includes(unorderedRaw)
  return {
    mode,
    allowUnorderedMigrations,
    skipMigrations: normalizeEnvValue(env.AGENTS_SKIP_MIGRATIONS) === '1' || mode === 'skip',
  }
}

export const validateAgentsMigrationsConfig = (env: EnvSource = process.env) => {
  resolveAgentsMigrationsConfig(env)
}
