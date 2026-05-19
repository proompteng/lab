type EnvSource = Record<string, string | undefined>

const DEFAULT_AGENTS_SERVICE_BASE_URL = 'http://agents.agents.svc.cluster.local'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

export const resolveAgentsServiceBaseUrl = (env: EnvSource = process.env) =>
  (normalizeNonEmpty(env.AGENTS_SERVICE_BASE_URL) ?? DEFAULT_AGENTS_SERVICE_BASE_URL).replace(/\/+$/, '')

const copyHeaders = (source: Headers, omit: Set<string>) => {
  const headers = new Headers()
  source.forEach((value, key) => {
    if (!omit.has(key.toLowerCase())) {
      headers.set(key, value)
    }
  })
  return headers
}

export const buildAgentsServiceProxyUrl = (request: Request, path: string, env: EnvSource = process.env) => {
  const requestUrl = new URL(request.url)
  const baseUrl = resolveAgentsServiceBaseUrl(env)
  const targetUrl = new URL(path.startsWith('/') ? path : `/${path}`, `${baseUrl}/`)
  targetUrl.search = requestUrl.search
  return targetUrl
}

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

export type AgentsOrchestrationRunSubmitResult = {
  orchestrationRun: Record<string, unknown>
  resource: Record<string, unknown> | null
  idempotent: boolean
}

export type AgentsOrchestrationRunSubmitter = (
  input: AgentsOrchestrationRunSubmitInput,
) => Promise<AgentsOrchestrationRunSubmitResult>

export type AgentsAgentMessageInput = {
  workflowUid: string | null
  workflowName: string | null
  workflowNamespace: string | null
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
    workflowUid?: string | null
  }
}

export type AgentsAgentMessagesSubmitResult = {
  inserted: number
  messages: Record<string, unknown>[]
  skipped: boolean
}

export type AgentsCodexCallbackKind = 'notify' | 'run-complete'

export type AgentsCodexCallbackSubmitInput = {
  kind: AgentsCodexCallbackKind
  payload: Record<string, unknown>
}

export type AgentsCodexCallbackSubmitter = (
  input: AgentsCodexCallbackSubmitInput,
) => Promise<AgentsServiceJsonResult<Record<string, unknown>>>

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
    'x-agents-client': 'jangar',
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
        'x-agents-client': 'jangar',
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
      'x-agents-client': 'jangar',
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
      'x-agents-client': 'jangar',
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

export const submitCodexCallbackToAgentsService = async (
  input: AgentsCodexCallbackSubmitInput,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<Record<string, unknown>>> => {
  const baseUrl = resolveAgentsServiceBaseUrl(env)
  const targetUrl = new URL(`/api/agents/codex/${input.kind}`, `${baseUrl}/`)
  try {
    const upstream = await fetch(targetUrl, {
      body: JSON.stringify(input.payload),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-agents-client': 'jangar',
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

export const proxyAgentsServiceRequest = async (request: Request, path: string, env: EnvSource = process.env) => {
  const method = request.method.toUpperCase()
  const targetUrl = buildAgentsServiceProxyUrl(request, path, env)
  const requestHeaders = copyHeaders(request.headers, HOP_BY_HOP_HEADERS)
  requestHeaders.set('x-agents-client', 'jangar')

  const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer()
  const upstream = await fetch(targetUrl, {
    body,
    headers: requestHeaders,
    method,
  })

  return new Response(upstream.body, {
    headers: copyHeaders(upstream.headers, HOP_BY_HOP_HEADERS),
    status: upstream.status,
    statusText: upstream.statusText,
  })
}

export const __test__ = {
  DEFAULT_AGENTS_SERVICE_BASE_URL,
}
