import {
  appendAgentsListParams,
  buildAgentsServiceUrl,
  fetchAgentsJson,
  servicePath,
  type AgentsResourceListInput,
  type AgentsServiceJsonResult,
  type EnvSource,
} from './agents-http'

export type AgentsSwarmResourceListInput = AgentsResourceListInput

export type AgentsStageTargetResourceGetInput = {
  kind: 'AgentRun' | 'OrchestrationRun'
  name: string
  namespace?: string | null
}

export type AgentsSwarmResource = Record<string, unknown>
export type AgentsStageTargetResource = Record<string, unknown>

export type AgentsSwarmResourcesResult = {
  ok: boolean
  kind?: 'Swarm' | string | null
  namespace?: string | null
  total?: number | null
  items: AgentsSwarmResource[]
}

export type AgentsStageTargetResourceResult = {
  ok: boolean
  kind?: 'AgentRun' | 'OrchestrationRun' | string | null
  namespace?: string | null
  resource?: AgentsStageTargetResource | null
}

export const fetchSwarmResourcesFromAgentsService = async (
  input: AgentsSwarmResourceListInput = {},
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsSwarmResourcesResult>> => {
  const targetUrl = buildAgentsServiceUrl('/v1/swarms/resources', env)
  appendAgentsListParams(targetUrl, input)
  return fetchAgentsJson<AgentsSwarmResourcesResult>(servicePath(targetUrl), env)
}

export const fetchStageTargetResourceFromAgentsService = async (
  input: AgentsStageTargetResourceGetInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsStageTargetResourceResult>> => {
  const { kind, ...resourceInput } = input
  const path = kind === 'AgentRun' ? '/v1/agent-runs/resources' : '/v1/orchestration-runs/resources'
  const targetUrl = buildAgentsServiceUrl(path, env)
  targetUrl.searchParams.set('name', resourceInput.name)
  const namespace = resourceInput.namespace?.trim()
  if (namespace) targetUrl.searchParams.set('namespace', namespace)
  return fetchAgentsJson<AgentsStageTargetResourceResult>(servicePath(targetUrl), env)
}
