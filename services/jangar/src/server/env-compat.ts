export type MutableEnv = Record<string, string | undefined>

const AGENTS_ENV_PREFIX = 'AGENTS_'
const JANGAR_ENV_PREFIX = 'JANGAR_'

export const toJangarEnvName = (name: string): string | null => {
  if (!name.startsWith(AGENTS_ENV_PREFIX)) return null
  return `${JANGAR_ENV_PREFIX}${name.slice(AGENTS_ENV_PREFIX.length)}`
}

export const installJangarEnvCompatibility = (env: MutableEnv = process.env) => {
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    const jangarName = toJangarEnvName(name)
    if (!jangarName) continue
    env[jangarName] = value
  }
}
