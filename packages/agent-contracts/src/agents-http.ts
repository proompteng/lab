export type EnvSource = Record<string, string | undefined>

const DEFAULT_AGENTS_SERVICE_BASE_URL = 'http://agents.agents.svc.cluster.local'
const DEFAULT_AGENTS_SERVICE_CLIENT_NAME = 'agent-contracts'

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

export const resolveAgentsServiceBaseUrl = (env: EnvSource = process.env) =>
  (normalizeNonEmpty(env.AGENTS_SERVICE_BASE_URL) ?? DEFAULT_AGENTS_SERVICE_BASE_URL).replace(/\/+$/, '')

export const resolveAgentsServiceClientName = (env: EnvSource = process.env) =>
  normalizeNonEmpty(env.AGENTS_SERVICE_CLIENT_NAME) ?? DEFAULT_AGENTS_SERVICE_CLIENT_NAME

export type AgentsServiceJsonResult<T> =
  | {
      ok: true
      status: number
      body: T
    }
  | {
      ok: false
      status: number
      body: T | null
      error: string | null
    }

export type AgentsResourceListInput = {
  namespace?: string | null
  limit?: number | null
  labelSelector?: string | null
  phase?: string | null
  runtime?: string | null
}

type AgentsJsonRequestOptions = {
  env?: EnvSource
  idempotencyKey?: string | null
}

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const readJsonBody = async <T>(response: Response): Promise<T | null> =>
  response.json().catch(() => null) as Promise<T | null>

const getBodyError = (body: Record<string, unknown> | null) => {
  const error = body?.error
  return typeof error === 'string' && error.trim().length > 0 ? error : null
}

const bodyAsRecord = (body: unknown) =>
  body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null

export const buildAgentsServiceUrl = (path: string, env: EnvSource = process.env) =>
  new URL(path.startsWith('/') ? path : `/${path}`, `${resolveAgentsServiceBaseUrl(env)}/`)

export const appendAgentsListParams = (targetUrl: URL, input: AgentsResourceListInput) => {
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

const requestHeaders = (env: EnvSource, options: { contentType?: string; idempotencyKey?: string | null } = {}) => ({
  accept: 'application/json',
  ...(options.contentType ? { 'content-type': options.contentType } : {}),
  ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
  'x-agents-client': resolveAgentsServiceClientName(env),
})

export const fetchAgentsJson = async <T>(
  path: string,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<T>> => {
  const targetUrl = buildAgentsServiceUrl(path, env)

  try {
    const upstream = await fetch(targetUrl, {
      headers: requestHeaders(env),
      method: 'GET',
    })
    const body = await readJsonBody<T>(upstream)
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
      error:
        getBodyError(bodyAsRecord(body)) ?? upstream.statusText ?? `Agents service returned HTTP ${upstream.status}`,
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

export const postAgentsJson = async <T>(
  path: string,
  payload: unknown,
  options: AgentsJsonRequestOptions = {},
): Promise<AgentsServiceJsonResult<T>> => {
  const env = options.env ?? process.env
  const targetUrl = buildAgentsServiceUrl(path, env)

  try {
    const upstream = await fetch(targetUrl, {
      body: JSON.stringify(payload),
      headers: requestHeaders(env, {
        contentType: 'application/json',
        idempotencyKey: options.idempotencyKey,
      }),
      method: 'POST',
    })
    const body = await readJsonBody<T>(upstream)
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
      error:
        getBodyError(bodyAsRecord(body)) ?? upstream.statusText ?? `Agents service returned HTTP ${upstream.status}`,
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

export const patchAgentsJson = async <T>(
  path: string,
  payload: unknown,
  options: AgentsJsonRequestOptions = {},
): Promise<AgentsServiceJsonResult<T>> => {
  const env = options.env ?? process.env
  const targetUrl = buildAgentsServiceUrl(path, env)

  try {
    const upstream = await fetch(targetUrl, {
      body: JSON.stringify(payload),
      headers: requestHeaders(env, {
        contentType: 'application/json',
        idempotencyKey: options.idempotencyKey,
      }),
      method: 'PATCH',
    })
    const body = await readJsonBody<T>(upstream)
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
      error:
        getBodyError(bodyAsRecord(body)) ?? upstream.statusText ?? `Agents service returned HTTP ${upstream.status}`,
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

export const servicePath = (targetUrl: URL) => `${targetUrl.pathname}${targetUrl.search}`

export const __test__ = {
  DEFAULT_AGENTS_SERVICE_BASE_URL,
  DEFAULT_AGENTS_SERVICE_CLIENT_NAME,
}
