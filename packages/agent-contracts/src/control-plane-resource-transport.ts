import {
  fetchAgentsServiceJson,
  resolveAgentsServiceBaseUrl,
  resolveAgentsServiceClientName,
  type AgentsServiceJsonResult,
  type EnvSource,
} from './agents-service-client'

export type AgentsControlPlaneResourceListOptions = {
  namespace?: string | null
  limit?: number | null
  labelSelector?: string | null
  phase?: string | null
  runtime?: string | null
}

export type AgentsControlPlaneResourceListInput = AgentsControlPlaneResourceListOptions & {
  kind: string
}

export type AgentsControlPlaneResourcesResult = {
  ok: boolean
  kind?: string | null
  namespace?: string | null
  total?: number | null
  items: Record<string, unknown>[]
}

export type AgentsControlPlaneResourceGetInput = {
  kind: string
  name: string
  namespace?: string | null
}

export type AgentsControlPlaneResourceResult = {
  ok: boolean
  kind?: string | null
  namespace?: string | null
  resource?: Record<string, unknown> | null
}

export type AgentsControlPlaneResourceSubmitInput = {
  deliveryId: string
  resource: Record<string, unknown>
}

export type AgentsNamedControlPlaneResourceInput = {
  name: string
  namespace?: string | null
}

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const readJsonBody = async (response: Response): Promise<Record<string, unknown> | null> =>
  response.json().catch(() => null) as Promise<Record<string, unknown> | null>

const getBodyError = (body: Record<string, unknown> | null) => {
  const error = body?.error
  return typeof error === 'string' && error.trim().length > 0 ? error : null
}

export const fetchControlPlaneResourcesFromAgentsService = async (
  input: AgentsControlPlaneResourceListInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsControlPlaneResourcesResult>> => {
  const params = new URLSearchParams({ kind: input.kind })
  const namespace = input.namespace?.trim()
  if (namespace) params.set('namespace', namespace)
  const labelSelector = input.labelSelector?.trim()
  if (labelSelector) params.set('labelSelector', labelSelector)
  const phase = input.phase?.trim()
  if (phase) params.set('phase', phase)
  const runtime = input.runtime?.trim()
  if (runtime) params.set('runtime', runtime)
  if (input.limit && input.limit > 0) params.set('limit', String(Math.trunc(input.limit)))

  return fetchAgentsServiceJson<AgentsControlPlaneResourcesResult>(`/api/agents/control-plane/resources?${params}`, env)
}

export const fetchControlPlaneResourceFromAgentsService = async (
  input: AgentsControlPlaneResourceGetInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsControlPlaneResourceResult>> => {
  const params = new URLSearchParams({ kind: input.kind, name: input.name })
  const namespace = input.namespace?.trim()
  if (namespace) params.set('namespace', namespace)

  return fetchAgentsServiceJson<AgentsControlPlaneResourceResult>(`/api/agents/control-plane/resource?${params}`, env)
}

export const submitControlPlaneResourceToAgentsService = async (
  input: AgentsControlPlaneResourceSubmitInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsControlPlaneResourceResult>> => {
  const baseUrl = resolveAgentsServiceBaseUrl(env)
  const targetUrl = new URL('/api/agents/control-plane/resource', `${baseUrl}/`)

  try {
    const upstream = await fetch(targetUrl, {
      body: JSON.stringify(input.resource),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'idempotency-key': input.deliveryId,
        'x-agents-client': resolveAgentsServiceClientName(env),
      },
      method: 'POST',
    })
    const body = (await readJsonBody(upstream)) as AgentsControlPlaneResourceResult | null
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
