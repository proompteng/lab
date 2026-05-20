import type { AgentsServiceJsonResult, EnvSource } from './agents-service-client'
import {
  fetchControlPlaneResourcesFromAgentsService,
  type AgentsControlPlaneResourceListOptions,
  type AgentsControlPlaneResourcesResult,
} from './control-plane-resource-transport'

export type AgentsJobResourceListInput = AgentsControlPlaneResourceListOptions

export type { AgentsControlPlaneResourcesResult }

export const fetchJobResourcesFromAgentsService = async (
  input: AgentsJobResourceListInput = {},
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsControlPlaneResourcesResult>> =>
  fetchControlPlaneResourcesFromAgentsService({ kind: 'Job', ...input }, env)
