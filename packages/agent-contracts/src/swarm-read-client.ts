import type { AgentsServiceJsonResult, EnvSource } from './agents-service-client'
import {
  fetchAgentsNamedResource,
  fetchAgentsResourceList,
  type AgentsResourceListOptions,
  type AgentsResourceResult,
  type AgentsResourcesResult,
} from './agents-resource-endpoints'

export type AgentsSwarmResourceListInput = AgentsResourceListOptions

export type AgentsStageTargetResourceGetInput = {
  kind: 'AgentRun' | 'OrchestrationRun'
  name: string
  namespace?: string | null
}

export type { AgentsResourceResult, AgentsResourcesResult }

export const fetchSwarmResourcesFromAgentsService = async (
  input: AgentsSwarmResourceListInput = {},
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsResourcesResult>> =>
  fetchAgentsResourceList('/v1/swarms/resources', input, env)

export const fetchStageTargetResourceFromAgentsService = async (
  input: AgentsStageTargetResourceGetInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsResourceResult>> => {
  const { kind, ...resourceInput } = input
  const path = kind === 'AgentRun' ? '/v1/agent-runs/resources' : '/v1/orchestration-runs/resources'
  return fetchAgentsNamedResource(path, resourceInput, env)
}
