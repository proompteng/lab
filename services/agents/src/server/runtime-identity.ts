export type AgentsRuntimeServiceName = 'agents' | 'jangar'

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'agents'])
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'jangar'])

const normalize = (value: string | undefined) => value?.trim().toLowerCase()

export const isAgentsRuntimeService = (env: NodeJS.ProcessEnv = process.env) => {
  const explicitMode = normalize(env.AGENTS_RUNTIME_SERVICE)
  if (explicitMode !== undefined) {
    if (TRUE_VALUES.has(explicitMode)) return true
    if (FALSE_VALUES.has(explicitMode)) return false
  }

  return Boolean(env.AGENTS_IMAGE || env.AGENTS_RUNTIME_IMAGE || env.AGENTS_GITOPS_REVISION)
}

export const resolveRuntimeServiceName = (env: NodeJS.ProcessEnv = process.env): AgentsRuntimeServiceName =>
  isAgentsRuntimeService(env) ? 'agents' : 'jangar'
