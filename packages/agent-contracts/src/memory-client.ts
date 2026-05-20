import type { AgentsServiceJsonResult, EnvSource } from './agents-service-client'
import {
  fetchControlPlaneResourceFromAgentsService,
  type AgentsControlPlaneResourceResult,
  type AgentsNamedControlPlaneResourceInput,
} from './control-plane-resource-transport'

export type { AgentsControlPlaneResourceResult, AgentsNamedControlPlaneResourceInput }

export const fetchMemoryResourceFromAgentsService = async (
  input: AgentsNamedControlPlaneResourceInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsControlPlaneResourceResult>> =>
  fetchControlPlaneResourceFromAgentsService({ kind: 'Memory', ...input }, env)
