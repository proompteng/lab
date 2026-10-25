import {
  buildAgentsServiceUrl,
  fetchAgentsJsonEffect,
  runAgentsJsonPromise,
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

const fetchPolicyResourceEffect = <TResource extends Record<string, unknown>>(
  path: string,
  input: AgentsPolicyResourceInput,
  env: EnvSource,
) => {
  const targetUrl = buildAgentsServiceUrl(path, env)
  targetUrl.searchParams.set('name', input.name)
  const namespace = input.namespace?.trim()
  if (namespace) targetUrl.searchParams.set('namespace', namespace)
  return fetchAgentsJsonEffect<AgentsPolicyResourceResult<TResource>>(servicePath(targetUrl), env)
}

export const fetchApprovalPolicyResourceFromAgentsServiceEffect = (
  input: AgentsPolicyResourceInput,
  env: EnvSource = process.env,
) => fetchPolicyResourceEffect<ApprovalPolicyResource>('/v1/approval-policies/resources', input, env)

export const fetchBudgetResourceFromAgentsServiceEffect = (
  input: AgentsPolicyResourceInput,
  env: EnvSource = process.env,
) => fetchPolicyResourceEffect<BudgetResource>('/v1/budgets/resources', input, env)

export const fetchSecretBindingResourceFromAgentsServiceEffect = (
  input: AgentsPolicyResourceInput,
  env: EnvSource = process.env,
) => fetchPolicyResourceEffect<SecretBindingResource>('/v1/secret-bindings/resources', input, env)

export const fetchApprovalPolicyResourceFromAgentsService = async (
  input: AgentsPolicyResourceInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsPolicyResourceResult<ApprovalPolicyResource>>> =>
  runAgentsJsonPromise(fetchApprovalPolicyResourceFromAgentsServiceEffect(input, env))

export const fetchBudgetResourceFromAgentsService = async (
  input: AgentsPolicyResourceInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsPolicyResourceResult<BudgetResource>>> =>
  runAgentsJsonPromise(fetchBudgetResourceFromAgentsServiceEffect(input, env))

export const fetchSecretBindingResourceFromAgentsService = async (
  input: AgentsPolicyResourceInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsPolicyResourceResult<SecretBindingResource>>> =>
  runAgentsJsonPromise(fetchSecretBindingResourceFromAgentsServiceEffect(input, env))
