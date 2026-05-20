import type { AgentsServiceJsonResult, EnvSource } from './agents-service-client'
import {
  fetchAgentsResourceList,
  type AgentsResourceListOptions,
  type AgentsResourcesResult,
} from './agents-resource-endpoints'

export type AgentsJobResourceListInput = AgentsResourceListOptions

export type { AgentsResourcesResult }

export const fetchJobResourcesFromAgentsService = async (
  input: AgentsJobResourceListInput = {},
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsResourcesResult>> => fetchAgentsResourceList('/v1/jobs/resources', input, env)
