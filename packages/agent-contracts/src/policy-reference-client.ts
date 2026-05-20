import {
  buildAgentsServiceUrl,
  fetchAgentsJson,
  servicePath,
  type AgentsServiceJsonResult,
  type EnvSource,
} from './agents-http'

export type AgentsPolicyResourceInput = {
  name: string
  namespace?: string | null
}

export type ApprovalPolicyResource = Record<string, unknown>
export type BudgetResource = Record<string, unknown>
export type SecretBindingResource = Record<string, unknown>

export type AgentsPolicyResourceResult<TResource extends Record<string, unknown> = Record<string, unknown>> = {
  ok: boolean
  kind?: string | null
  namespace?: string | null
  resource?: TResource | null
}

const fetchPolicyResource = async <TResource extends Record<string, unknown>>(
  path: string,
  input: AgentsPolicyResourceInput,
  env: EnvSource,
): Promise<AgentsServiceJsonResult<AgentsPolicyResourceResult<TResource>>> => {
  const targetUrl = buildAgentsServiceUrl(path, env)
  targetUrl.searchParams.set('name', input.name)
  const namespace = input.namespace?.trim()
  if (namespace) targetUrl.searchParams.set('namespace', namespace)
  return fetchAgentsJson<AgentsPolicyResourceResult<TResource>>(servicePath(targetUrl), env)
}

export const fetchApprovalPolicyResourceFromAgentsService = async (
  input: AgentsPolicyResourceInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsPolicyResourceResult<ApprovalPolicyResource>>> =>
  fetchPolicyResource('/v1/approval-policies/resources', input, env)

export const fetchBudgetResourceFromAgentsService = async (
  input: AgentsPolicyResourceInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsPolicyResourceResult<BudgetResource>>> =>
  fetchPolicyResource('/v1/budgets/resources', input, env)

export const fetchSecretBindingResourceFromAgentsService = async (
  input: AgentsPolicyResourceInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsPolicyResourceResult<SecretBindingResource>>> =>
  fetchPolicyResource('/v1/secret-bindings/resources', input, env)
