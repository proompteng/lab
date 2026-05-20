import {
  appendAgentsListParams,
  buildAgentsServiceUrl,
  fetchAgentsJson,
  patchAgentsJson,
  postAgentsJson,
  servicePath,
  type AgentsResourceListInput,
  type AgentsServiceJsonResult,
  type EnvSource,
} from './agents-http'

export type { AgentsServiceJsonResult } from './agents-http'

export type AgentsAgentRunSubmitInput = {
  deliveryId: string
  payload: Record<string, unknown>
  dryRun?: string | null
}

export type AgentsAgentRunListItem = {
  id: string
  agentName: string
  deliveryId: string
  provider: string
  status: string
  externalRunId: string | null
  payload: Record<string, unknown>
  createdAt?: string | null
  updatedAt?: string | null
}

export type AgentsAgentRunListInput = {
  agentName?: string | null
  statuses?: string[] | null
  limit?: number | null
}

export type AgentsAgentRunListResult = {
  ok: boolean
  runs: AgentsAgentRunListItem[]
}

export type AgentsAgentRunResource = Record<string, unknown>
export type AgentsAgentRunResourceListInput = AgentsResourceListInput

export type AgentsAgentRunResourcesResult = {
  ok: boolean
  kind?: 'AgentRun' | string | null
  namespace?: string | null
  total?: number | null
  items: AgentsAgentRunResource[]
}

export type AgentsAgentRunAnnotationsPatchInput = {
  name: string
  namespace: string
  annotations: Record<string, string | null>
}

export const submitAgentRunToAgentsService = async (
  input: AgentsAgentRunSubmitInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<Record<string, unknown>>> => {
  const targetUrl = buildAgentsServiceUrl('/v1/agent-runs', env)
  if (input.dryRun != null) {
    targetUrl.searchParams.set('dryRun', input.dryRun)
  }
  return postAgentsJson<Record<string, unknown>>(servicePath(targetUrl), input.payload, {
    env,
    idempotencyKey: input.deliveryId,
  })
}

export const fetchAgentRunsFromAgentsService = async (
  input: AgentsAgentRunListInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsAgentRunListResult>> => {
  const params = new URLSearchParams()
  const agentName = input.agentName?.trim()
  if (agentName) params.set('agentName', agentName)
  const statuses = (input.statuses ?? []).map((status) => status.trim()).filter((status) => status.length > 0)
  if (statuses.length > 0) params.set('status', statuses.join(','))
  if (input.limit && input.limit > 0) params.set('limit', String(Math.trunc(input.limit)))

  const suffix = params.size > 0 ? `?${params.toString()}` : ''
  return fetchAgentsJson<AgentsAgentRunListResult>(`/v1/agent-runs${suffix}`, env)
}

export const fetchAgentRunResourcesFromAgentsService = async (
  input: AgentsAgentRunResourceListInput = {},
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsAgentRunResourcesResult>> => {
  const targetUrl = buildAgentsServiceUrl('/v1/agent-runs/resources', env)
  appendAgentsListParams(targetUrl, input)
  return fetchAgentsJson<AgentsAgentRunResourcesResult>(servicePath(targetUrl), env)
}

export const patchAgentRunAnnotationsViaAgentsService = async (
  input: AgentsAgentRunAnnotationsPatchInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<Record<string, unknown>>> => {
  const targetUrl = buildAgentsServiceUrl('/v1/agent-runs/resources', env)
  targetUrl.searchParams.set('name', input.name)
  targetUrl.searchParams.set('namespace', input.namespace)

  return patchAgentsJson<Record<string, unknown>>(
    servicePath(targetUrl),
    { metadata: { annotations: input.annotations } },
    { env },
  )
}
