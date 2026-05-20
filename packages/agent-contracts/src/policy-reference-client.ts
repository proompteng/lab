import type { AgentsServiceJsonResult, EnvSource } from './agents-service-client'
import {
  fetchAgentsNamedResource,
  type AgentsNamedResourceInput,
  type AgentsResourceResult,
} from './agents-resource-endpoints'

export type { AgentsNamedResourceInput, AgentsResourceResult }

export const fetchApprovalPolicyResourceFromAgentsService = async (
  input: AgentsNamedResourceInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsResourceResult>> =>
  fetchAgentsNamedResource('/v1/approval-policies/resources', input, env)

export const fetchBudgetResourceFromAgentsService = async (
  input: AgentsNamedResourceInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsResourceResult>> =>
  fetchAgentsNamedResource('/v1/budgets/resources', input, env)

export const fetchSecretBindingResourceFromAgentsService = async (
  input: AgentsNamedResourceInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsResourceResult>> =>
  fetchAgentsNamedResource('/v1/secret-bindings/resources', input, env)
