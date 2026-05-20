import type { AgentsServiceJsonResult, EnvSource } from './agents-service-client'
import {
  fetchControlPlaneResourcesFromAgentsService,
  type AgentsControlPlaneResourceListOptions,
  type AgentsControlPlaneResourcesResult,
} from './control-plane-resource-transport'

export {
  fetchAgentRunsFromAgentsService,
  patchAgentRunAnnotationsViaAgentsService,
  submitAgentRunToAgentsService,
} from './agents-service-client'
export type {
  AgentsAgentRunAnnotationsPatchInput,
  AgentsAgentRunListInput,
  AgentsAgentRunListItem,
  AgentsAgentRunListResult,
  AgentsAgentRunSubmitInput,
  AgentsServiceJsonResult,
} from './agents-service-client'

export type AgentsAgentRunResourceListInput = AgentsControlPlaneResourceListOptions

export type { AgentsControlPlaneResourcesResult } from './control-plane-resource-transport'

export const fetchAgentRunResourcesFromAgentsService = async (
  input: AgentsAgentRunResourceListInput = {},
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsControlPlaneResourcesResult>> =>
  fetchControlPlaneResourcesFromAgentsService({ kind: 'AgentRun', ...input }, env)
