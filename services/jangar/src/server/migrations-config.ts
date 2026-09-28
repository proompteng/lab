type EnvSource = Record<string, string | undefined>

export type MigrationsMode = 'auto' | 'skip'

export type MigrationsConfig = {
  mode: MigrationsMode
  allowUnorderedMigrations: boolean
  skipMigrations: boolean
}

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

export const resolveMigrationsConfig = (env: EnvSource = process.env): MigrationsConfig => {
  const rawMode = normalizeNonEmpty(env.JANGAR_MIGRATIONS)?.toLowerCase()
  const mode: MigrationsMode = rawMode && ['skip', 'disabled', 'false', '0', 'off'].includes(rawMode) ? 'skip' : 'auto'
  const unorderedRaw = normalizeNonEmpty(env.JANGAR_ALLOW_UNORDERED_MIGRATIONS)?.toLowerCase()
  const allowUnorderedMigrations = !unorderedRaw || !['false', '0', 'off', 'disabled', 'no'].includes(unorderedRaw)
  return {
    mode,
    allowUnorderedMigrations,
    skipMigrations: env.JANGAR_SKIP_MIGRATIONS === '1' || mode === 'skip',
  }
}

export const validateMigrationsConfig = (env: EnvSource = process.env) => {
  resolveMigrationsConfig(env)
}
