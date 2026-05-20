import {
  resolveAgentsServiceBaseUrl,
  resolveAgentsServiceClientName,
  type AgentsServiceJsonResult,
  type EnvSource,
} from './agents-service-client'

export { fetchAgentRunsFromAgentsService, submitAgentRunToAgentsService } from './agents-service-client'
export type {
  AgentsAgentRunListInput,
  AgentsAgentRunListItem,
  AgentsAgentRunListResult,
  AgentsAgentRunSubmitInput,
  AgentsServiceJsonResult,
} from './agents-service-client'

export type AgentsAgentRunResourceListInput = {
  namespace?: string | null
  limit?: number | null
  labelSelector?: string | null
  phase?: string | null
  runtime?: string | null
}

export type AgentsAgentRunResourcesResult = {
  ok: boolean
  kind?: 'AgentRun' | string | null
  namespace?: string | null
  total?: number | null
  items: Record<string, unknown>[]
}

export type AgentsAgentRunAnnotationsPatchInput = {
  name: string
  namespace: string
  annotations: Record<string, string | null>
}

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const readJsonBody = async (response: Response): Promise<Record<string, unknown> | null> =>
  response.json().catch(() => null) as Promise<Record<string, unknown> | null>

const getBodyError = (body: Record<string, unknown> | null) => {
  const error = body?.error
  return typeof error === 'string' && error.trim().length > 0 ? error : null
}

export const fetchAgentRunResourcesFromAgentsService = async (
  input: AgentsAgentRunResourceListInput = {},
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsAgentRunResourcesResult>> => {
  const baseUrl = resolveAgentsServiceBaseUrl(env)
  const targetUrl = new URL('/v1/agent-runs/resources', `${baseUrl}/`)
  const namespace = input.namespace?.trim()
  if (namespace) targetUrl.searchParams.set('namespace', namespace)
  const labelSelector = input.labelSelector?.trim()
  if (labelSelector) targetUrl.searchParams.set('labelSelector', labelSelector)
  const phase = input.phase?.trim()
  if (phase) targetUrl.searchParams.set('phase', phase)
  const runtime = input.runtime?.trim()
  if (runtime) targetUrl.searchParams.set('runtime', runtime)
  if (input.limit && input.limit > 0) targetUrl.searchParams.set('limit', String(Math.trunc(input.limit)))

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        accept: 'application/json',
        'x-agents-client': resolveAgentsServiceClientName(env),
      },
      method: 'GET',
    })
    const body = (await readJsonBody(upstream)) as AgentsAgentRunResourcesResult | null
    if (upstream.ok && body !== null) {
      return {
        ok: true,
        status: upstream.status,
        body,
      }
    }
    return {
      ok: false,
      status: upstream.status,
      body,
      error: getBodyError(body) ?? upstream.statusText ?? `Agents service returned HTTP ${upstream.status}`,
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: getErrorMessage(error),
    }
  }
}

export const patchAgentRunAnnotationsViaAgentsService = async (
  input: AgentsAgentRunAnnotationsPatchInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<Record<string, unknown>>> => {
  const baseUrl = resolveAgentsServiceBaseUrl(env)
  const targetUrl = new URL('/v1/agent-runs/resources', `${baseUrl}/`)
  targetUrl.searchParams.set('name', input.name)
  targetUrl.searchParams.set('namespace', input.namespace)

  try {
    const upstream = await fetch(targetUrl, {
      body: JSON.stringify({ metadata: { annotations: input.annotations } }),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-agents-client': resolveAgentsServiceClientName(env),
      },
      method: 'PATCH',
    })
    const body = await readJsonBody(upstream)
    if (upstream.ok && body !== null) {
      return {
        ok: true,
        status: upstream.status,
        body,
      }
    }

    return {
      ok: false,
      status: upstream.status,
      body,
      error: getBodyError(body) ?? upstream.statusText ?? `Agents service returned HTTP ${upstream.status}`,
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: getErrorMessage(error),
    }
  }
}
