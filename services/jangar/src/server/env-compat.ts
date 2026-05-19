export type MutableEnv = Record<string, string | undefined>

const AGENTS_ENV_PREFIX = 'AGENTS_'
const JANGAR_ENV_PREFIX = 'JANGAR_'
const JANGAR_IDENTITY_ENV_NAMES = new Set(['JANGAR_IMAGE', 'JANGAR_RUNTIME_IMAGE', 'JANGAR_GITOPS_REVISION'])

export const toJangarEnvName = (name: string): string | null => {
  if (!name.startsWith(AGENTS_ENV_PREFIX)) return null
  return `${JANGAR_ENV_PREFIX}${name.slice(AGENTS_ENV_PREFIX.length)}`
}

export const toAgentsEnvName = (name: string): string | null => {
  if (!name.startsWith(JANGAR_ENV_PREFIX)) return null
  return `${AGENTS_ENV_PREFIX}${name.slice(JANGAR_ENV_PREFIX.length)}`
}

export const installJangarEnvCompatibility = (env: MutableEnv = process.env) => {
  const entries = Object.entries(env)
  for (const [name, value] of entries) {
    if (value === undefined) continue
    const jangarName = toJangarEnvName(name)
    if (!jangarName) continue
    env[jangarName] = value
  }
  for (const [name, value] of entries) {
    if (value === undefined) continue
    const agentsName = toAgentsEnvName(name)
    if (!agentsName || JANGAR_IDENTITY_ENV_NAMES.has(name) || env[agentsName] !== undefined) continue
    env[agentsName] = value
  }
}
