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

export type AgentsHealthController = {
  enabled: boolean
  crdsReady: boolean | null
}

export type AgentsHealthPayload = {
  status?: string
  service?: string
  agentsController?: AgentsHealthController
}

export type AgentsOrchestrationRunSubmitInput = {
  deliveryId: string
  orchestrationRef: { name: string }
  namespace: string
  parameters?: Record<string, string>
  policy?: Record<string, unknown>
}

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

export type AgentsAgentRunAnnotationsPatchInput = {
  name: string
  namespace: string
  annotations: Record<string, string | null>
}

export type AgentsOrchestrationRunSubmitResult = {
  orchestrationRun: Record<string, unknown>
  resource: Record<string, unknown> | null
  idempotent: boolean
}

export type AgentsOrchestrationRunSubmitter = (
  input: AgentsOrchestrationRunSubmitInput,
) => Promise<AgentsOrchestrationRunSubmitResult>

export type AgentsAgentMessageInput = {
  agentRunUid: string | null
  agentRunName: string | null
  agentRunNamespace: string | null
  runId: string | null
  stepId: string | null
  agentId: string | null
  role: string
  kind: string
  timestamp: string | Date
  channel: string | null
  stage: string | null
  content: string
  attrs?: Record<string, unknown>
  dedupeKey?: string | null
}

export type AgentsAgentMessagesSubmitInput = {
  messages: AgentsAgentMessageInput[]
  skipIfExisting?: {
    runId?: string | null
    agentRunUid?: string | null
  }
}

export type AgentsAgentMessagesSubmitResult = {
  inserted: number
  messages: Record<string, unknown>[]
  skipped: boolean
}

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const readJsonBody = async (response: Response): Promise<Record<string, unknown> | null> =>
  response.json().catch(() => null) as Promise<Record<string, unknown> | null>

const getBodyError = (body: Record<string, unknown> | null) => {
  const error = body?.error
  return typeof error === 'string' && error.trim().length > 0 ? error : null
}

export const fetchAgentsServiceJson = async <T>(
  path: string,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<T>> => {
  const baseUrl = resolveAgentsServiceBaseUrl(env)
  const targetUrl = new URL(path.startsWith('/') ? path : `/${path}`, `${baseUrl}/`)
  const requestHeaders = new Headers({
    accept: 'application/json',
    'x-agents-client': resolveAgentsServiceClientName(env),
  })

  try {
    const upstream = await fetch(targetUrl, {
      headers: requestHeaders,
      method: 'GET',
    })
    const body = (await upstream.json().catch(() => null)) as T | null
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
      error: upstream.statusText || `Agents service returned HTTP ${upstream.status}`,
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

export const fetchAgentsHealthFromAgentsService = async (
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<AgentsHealthPayload>> => fetchAgentsServiceJson<AgentsHealthPayload>('/health', env)

export const submitAgentRunToAgentsService = async (
  input: AgentsAgentRunSubmitInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<Record<string, unknown>>> => {
  const baseUrl = resolveAgentsServiceBaseUrl(env)
  const targetUrl = new URL('/v1/agent-runs', `${baseUrl}/`)
  if (input.dryRun != null) {
    targetUrl.searchParams.set('dryRun', input.dryRun)
  }

  try {
    const upstream = await fetch(targetUrl, {
      body: JSON.stringify(input.payload),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'idempotency-key': input.deliveryId,
        'x-agents-client': resolveAgentsServiceClientName(env),
      },
      method: 'POST',
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
  return fetchAgentsServiceJson<AgentsAgentRunListResult>(`/v1/agent-runs${suffix}`, env)
}

export const patchAgentRunAnnotationsViaAgentsService = async (
  input: AgentsAgentRunAnnotationsPatchInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<Record<string, unknown>>> => {
  const baseUrl = resolveAgentsServiceBaseUrl(env)
  const targetUrl = new URL('/api/agents/control-plane/resource', `${baseUrl}/`)
  targetUrl.searchParams.set('kind', 'AgentRun')
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

export const submitOrchestrationRunToAgentsService = async (
  input: AgentsOrchestrationRunSubmitInput,
  env: EnvSource = process.env,
): Promise<AgentsOrchestrationRunSubmitResult> => {
  const baseUrl = resolveAgentsServiceBaseUrl(env)
  const targetUrl = new URL('/v1/orchestration-runs', `${baseUrl}/`)
  const upstream = await fetch(targetUrl, {
    body: JSON.stringify({
      orchestrationRef: input.orchestrationRef,
      namespace: input.namespace,
      parameters: input.parameters ?? {},
      policy: input.policy ?? {},
    }),
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'idempotency-key': input.deliveryId,
      'x-agents-client': resolveAgentsServiceClientName(env),
    },
    method: 'POST',
  })

  const body = await readJsonBody(upstream)
  if (!upstream.ok) {
    const message = getBodyError(body) ?? upstream.statusText ?? `Agents service returned HTTP ${upstream.status}`
    throw new Error(`Agents service orchestration submit failed (${upstream.status}): ${message}`)
  }

  const orchestrationRun = body?.orchestrationRun
  if (!body?.ok || !orchestrationRun || typeof orchestrationRun !== 'object' || Array.isArray(orchestrationRun)) {
    throw new Error('Agents service orchestration submit response did not include an orchestrationRun')
  }

  const resource =
    body.resource && typeof body.resource === 'object' && !Array.isArray(body.resource)
      ? (body.resource as Record<string, unknown>)
      : null
  return {
    orchestrationRun: orchestrationRun as Record<string, unknown>,
    resource,
    idempotent: body.idempotent === true,
  }
}

export const submitAgentMessagesToAgentsService = async (
  input: AgentsAgentMessagesSubmitInput,
  env: EnvSource = process.env,
): Promise<AgentsAgentMessagesSubmitResult> => {
  const baseUrl = resolveAgentsServiceBaseUrl(env)
  const targetUrl = new URL('/api/agents/messages', `${baseUrl}/`)
  const upstream = await fetch(targetUrl, {
    body: JSON.stringify(input),
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-agents-client': resolveAgentsServiceClientName(env),
    },
    method: 'POST',
  })

  const body = await readJsonBody(upstream)
  if (!upstream.ok) {
    const message = getBodyError(body) ?? upstream.statusText ?? `Agents service returned HTTP ${upstream.status}`
    throw new Error(`Agents service agent messages submit failed (${upstream.status}): ${message}`)
  }

  const messages = Array.isArray(body?.messages) ? body.messages : []
  return {
    inserted: typeof body?.inserted === 'number' ? body.inserted : messages.length,
    messages: messages.filter((message): message is Record<string, unknown> => {
      return !!message && typeof message === 'object' && !Array.isArray(message)
    }),
    skipped: body?.skipped === true,
  }
}

export const __test__ = {
  DEFAULT_AGENTS_SERVICE_BASE_URL,
  DEFAULT_AGENTS_SERVICE_CLIENT_NAME,
}
