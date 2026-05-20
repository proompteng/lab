import type { AgentsServiceJsonResult, EnvSource } from './agents-service-client'
import {
  fetchAgentsNamedResource,
  type AgentsNamedResourceInput,
  type AgentsResourceResult,
} from './agents-resource-endpoints'

export type { AgentsNamedResourceInput, AgentsResourceResult }

export const fetchMemoryResourceFromAgentsService = async (
  input: AgentsNamedResourceInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsResourceResult>> =>
  fetchAgentsNamedResource('/v1/memories/resources', input, env)
