import type { AgentsServiceJsonResult, EnvSource } from './agents-service-client'
import {
  fetchControlPlaneResourceFromAgentsService,
  fetchControlPlaneResourcesFromAgentsService,
  type AgentsControlPlaneResourceListOptions,
  type AgentsControlPlaneResourceResult,
  type AgentsControlPlaneResourcesResult,
} from './control-plane-resource-transport'

export type AgentsSwarmResourceListInput = AgentsControlPlaneResourceListOptions

export type AgentsStageTargetResourceGetInput = {
  kind: 'AgentRun' | 'OrchestrationRun'
  name: string
  namespace?: string | null
}

export type { AgentsControlPlaneResourceResult, AgentsControlPlaneResourcesResult }

export const fetchSwarmResourcesFromAgentsService = async (
  input: AgentsSwarmResourceListInput = {},
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsControlPlaneResourcesResult>> =>
  fetchControlPlaneResourcesFromAgentsService({ kind: 'Swarm', ...input }, env)

export const fetchStageTargetResourceFromAgentsService = async (
  input: AgentsStageTargetResourceGetInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsControlPlaneResourceResult>> =>
  fetchControlPlaneResourceFromAgentsService(input, env)
