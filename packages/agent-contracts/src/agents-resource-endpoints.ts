import {
  fetchAgentsServiceJson,
  resolveAgentsServiceBaseUrl,
  resolveAgentsServiceClientName,
  type AgentsServiceJsonResult,
  type EnvSource,
} from './agents-service-client'

export type AgentsResourceListOptions = {
  namespace?: string | null
  limit?: number | null
  labelSelector?: string | null
  phase?: string | null
  runtime?: string | null
}

export type AgentsResourcesResult = {
  ok: boolean
  kind?: string | null
  namespace?: string | null
  total?: number | null
  items: Record<string, unknown>[]
}

export type AgentsResourceResult = {
  ok: boolean
  kind?: string | null
  namespace?: string | null
  resource?: Record<string, unknown> | null
}

export type AgentsNamedResourceInput = {
  name: string
  namespace?: string | null
}

export type AgentsResourceSubmitInput = {
  deliveryId: string
  resource: Record<string, unknown>
}

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const readJsonBody = async (response: Response): Promise<Record<string, unknown> | null> =>
  response.json().catch(() => null) as Promise<Record<string, unknown> | null>

const getBodyError = (body: Record<string, unknown> | null) => {
  const error = body?.error
  return typeof error === 'string' && error.trim().length > 0 ? error : null
}

const appendListParams = (targetUrl: URL, input: AgentsResourceListOptions) => {
  const namespace = input.namespace?.trim()
  if (namespace) targetUrl.searchParams.set('namespace', namespace)
  const labelSelector = input.labelSelector?.trim()
  if (labelSelector) targetUrl.searchParams.set('labelSelector', labelSelector)
  const phase = input.phase?.trim()
  if (phase) targetUrl.searchParams.set('phase', phase)
  const runtime = input.runtime?.trim()
  if (runtime) targetUrl.searchParams.set('runtime', runtime)
  if (input.limit && input.limit > 0) targetUrl.searchParams.set('limit', String(Math.trunc(input.limit)))
}

const servicePath = (targetUrl: URL) => `${targetUrl.pathname}${targetUrl.search}`

export const fetchAgentsResourceList = async (
  path: string,
  input: AgentsResourceListOptions = {},
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsResourcesResult>> => {
  const targetUrl = new URL(path, `${resolveAgentsServiceBaseUrl(env)}/`)
  appendListParams(targetUrl, input)
  return fetchAgentsServiceJson<AgentsResourcesResult>(servicePath(targetUrl), env)
}

export const fetchAgentsNamedResource = async (
  path: string,
  input: AgentsNamedResourceInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsResourceResult>> => {
  const targetUrl = new URL(path, `${resolveAgentsServiceBaseUrl(env)}/`)
  targetUrl.searchParams.set('name', input.name)
  const namespace = input.namespace?.trim()
  if (namespace) targetUrl.searchParams.set('namespace', namespace)
  return fetchAgentsServiceJson<AgentsResourceResult>(servicePath(targetUrl), env)
}

export const submitAgentsResource = async (
  path: string,
  input: AgentsResourceSubmitInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsResourceResult>> => {
  const targetUrl = new URL(path, `${resolveAgentsServiceBaseUrl(env)}/`)

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
    const body = (await readJsonBody(upstream)) as AgentsResourceResult | null
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
