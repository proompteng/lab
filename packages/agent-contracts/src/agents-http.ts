import { Context, Data, Effect, Layer } from 'effect'

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
  signal?: AbortSignal | null
}

export type AgentsHttpMethod = 'GET' | 'POST' | 'PATCH'

export type AgentsFetch = (input: URL | string, init?: RequestInit) => Promise<Response>

export type AgentsJsonEffectRequest = {
  path: string
  method: AgentsHttpMethod
  env?: EnvSource
  payload?: unknown
  idempotencyKey?: string | null
  signal?: AbortSignal | null
}

export type AgentsServiceJsonSuccess<T> = Extract<AgentsServiceJsonResult<T>, { ok: true }>

export class AgentsTransportError extends Data.TaggedError('AgentsTransportError')<{
  readonly method: AgentsHttpMethod
  readonly url: string
  readonly cause: unknown
}> {}

export class AgentsHttpStatusError extends Data.TaggedError('AgentsHttpStatusError')<{
  readonly method: AgentsHttpMethod
  readonly url: string
  readonly status: number
  readonly statusText: string
  readonly body: unknown
  readonly error: string | null
}> {}

export class AgentsResponseBodyError extends Data.TaggedError('AgentsResponseBodyError')<{
  readonly method: AgentsHttpMethod
  readonly url: string
  readonly status: number
  readonly kind: 'invalid-json' | 'missing-json'
  readonly cause?: unknown
}> {}

export type AgentsHttpClientError = AgentsTransportError | AgentsHttpStatusError | AgentsResponseBodyError

export type AgentsHttpClientService = {
  readonly requestJson: <T>(
    request: AgentsJsonEffectRequest,
  ) => Effect.Effect<AgentsServiceJsonSuccess<T>, AgentsHttpClientError>
  readonly fetchJson: <T>(
    path: string,
    env?: EnvSource,
  ) => Effect.Effect<AgentsServiceJsonSuccess<T>, AgentsHttpClientError>
  readonly postJson: <T>(
    path: string,
    payload: unknown,
    options?: AgentsJsonRequestOptions,
  ) => Effect.Effect<AgentsServiceJsonSuccess<T>, AgentsHttpClientError>
  readonly patchJson: <T>(
    path: string,
    payload: unknown,
    options?: AgentsJsonRequestOptions,
  ) => Effect.Effect<AgentsServiceJsonSuccess<T>, AgentsHttpClientError>
}

export class AgentsHttpClient extends Context.Tag('agent-contracts/AgentsHttpClient')<
  AgentsHttpClient,
  AgentsHttpClientService
>() {}

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

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

type JsonBodyRead<T> =
  | {
      ok: true
      body: T | null
    }
  | {
      ok: false
      cause: unknown
    }

const readJsonBodyEffect = <T>(response: Response): Effect.Effect<JsonBodyRead<T>> =>
  Effect.tryPromise({
    try: () => response.json() as Promise<T | null>,
    catch: (cause) => cause,
  }).pipe(
    Effect.match({
      onFailure: (cause): JsonBodyRead<T> => ({ ok: false, cause }),
      onSuccess: (body): JsonBodyRead<T> => ({ ok: true, body }),
    }),
  )

const defaultAgentsFetch: AgentsFetch = (input, init) => globalThis.fetch(input, init)

const makeAgentsHttpClientService = (fetchImpl: AgentsFetch = defaultAgentsFetch): AgentsHttpClientService => {
  const requestJson = <T>(
    request: AgentsJsonEffectRequest,
  ): Effect.Effect<AgentsServiceJsonSuccess<T>, AgentsHttpClientError> =>
    Effect.gen(function* (_) {
      const env = request.env ?? process.env
      const targetUrl = buildAgentsServiceUrl(request.path, env)
      const method = request.method
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchImpl(targetUrl, {
            ...(method === 'GET' ? {} : { body: JSON.stringify(request.payload) }),
            headers: requestHeaders(env, {
              contentType: method === 'GET' ? undefined : 'application/json',
              idempotencyKey: request.idempotencyKey,
            }),
            method,
            signal: request.signal,
          }),
        catch: (cause) =>
          new AgentsTransportError({
            method,
            url: targetUrl.toString(),
            cause,
          }),
      })

      const bodyResult = yield* readJsonBodyEffect<T>(response)
      if (!response.ok) {
        const body = bodyResult.ok ? bodyResult.body : null
        const error =
          getBodyError(bodyAsRecord(body)) ?? response.statusText ?? `Agents service returned HTTP ${response.status}`
        return yield* Effect.fail(
          new AgentsHttpStatusError({
            method,
            url: targetUrl.toString(),
            status: response.status,
            statusText: response.statusText,
            body,
            error,
          }),
        )
      }

      if (!bodyResult.ok) {
        return yield* Effect.fail(
          new AgentsResponseBodyError({
            method,
            url: targetUrl.toString(),
            status: response.status,
            kind: 'invalid-json',
            cause: bodyResult.cause,
          }),
        )
      }

      if (bodyResult.body === null) {
        return yield* Effect.fail(
          new AgentsResponseBodyError({
            method,
            url: targetUrl.toString(),
            status: response.status,
            kind: 'missing-json',
          }),
        )
      }

      return {
        ok: true,
        status: response.status,
        body: bodyResult.body,
      }
    })

  return {
    requestJson,
    fetchJson: (path, env = process.env) => requestJson({ path, env, method: 'GET' }),
    postJson: (path, payload, options = {}) =>
      requestJson({
        path,
        payload,
        env: options.env,
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
        method: 'POST',
      }),
    patchJson: (path, payload, options = {}) =>
      requestJson({
        path,
        payload,
        env: options.env,
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
        method: 'PATCH',
      }),
  }
}

export const makeAgentsHttpClientLayer = (options: { fetch?: AgentsFetch } = {}) =>
  Layer.succeed(AgentsHttpClient, makeAgentsHttpClientService(options.fetch))

export const AgentsHttpClientLive = makeAgentsHttpClientLayer()

export const requestAgentsJsonEffect = <T>(
  request: AgentsJsonEffectRequest,
): Effect.Effect<AgentsServiceJsonSuccess<T>, AgentsHttpClientError, AgentsHttpClient> =>
  Effect.gen(function* (_) {
    const client = yield* AgentsHttpClient
    return yield* client.requestJson<T>(request)
  })

export const fetchAgentsJsonEffect = <T>(
  path: string,
  env: EnvSource = process.env,
): Effect.Effect<AgentsServiceJsonSuccess<T>, AgentsHttpClientError, AgentsHttpClient> =>
  Effect.gen(function* (_) {
    const client = yield* AgentsHttpClient
    return yield* client.fetchJson<T>(path, env)
  })

export const postAgentsJsonEffect = <T>(
  path: string,
  payload: unknown,
  options: AgentsJsonRequestOptions = {},
): Effect.Effect<AgentsServiceJsonSuccess<T>, AgentsHttpClientError, AgentsHttpClient> =>
  Effect.gen(function* (_) {
    const client = yield* AgentsHttpClient
    return yield* client.postJson<T>(path, payload, options)
  })

export const patchAgentsJsonEffect = <T>(
  path: string,
  payload: unknown,
  options: AgentsJsonRequestOptions = {},
): Effect.Effect<AgentsServiceJsonSuccess<T>, AgentsHttpClientError, AgentsHttpClient> =>
  Effect.gen(function* (_) {
    const client = yield* AgentsHttpClient
    return yield* client.patchJson<T>(path, payload, options)
  })

const describeAgentsHttpError = (error: AgentsHttpClientError): string | null => {
  if (error instanceof AgentsTransportError) return getErrorMessage(error.cause)
  if (error instanceof AgentsHttpStatusError) return error.error
  if (error instanceof AgentsResponseBodyError) {
    if (error.kind === 'invalid-json') return `Agents service returned invalid JSON for HTTP ${error.status}`
    return `Agents service returned HTTP ${error.status}`
  }
  return getErrorMessage(error)
}

const statusForAgentsHttpError = (error: AgentsHttpClientError) => {
  if (error instanceof AgentsTransportError) return 0
  return error.status
}

const bodyForAgentsHttpError = <T>(error: AgentsHttpClientError): T | null => {
  if (error instanceof AgentsHttpStatusError) return error.body as T | null
  return null
}

export const runAgentsJsonPromise = <T>(
  effect: Effect.Effect<AgentsServiceJsonSuccess<T>, AgentsHttpClientError, AgentsHttpClient>,
): Promise<AgentsServiceJsonResult<T>> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(AgentsHttpClientLive),
      Effect.catchAll((error) =>
        Effect.succeed<AgentsServiceJsonResult<T>>({
          ok: false,
          status: statusForAgentsHttpError(error),
          body: bodyForAgentsHttpError<T>(error),
          error: describeAgentsHttpError(error),
        }),
      ),
    ),
  )

export const fetchAgentsJson = async <T>(
  path: string,
  env: EnvSource = process.env,
): Promise<AgentsServiceJsonResult<T>> => runAgentsJsonPromise(fetchAgentsJsonEffect<T>(path, env))

export const postAgentsJson = async <T>(
  path: string,
  payload: unknown,
  options: AgentsJsonRequestOptions = {},
): Promise<AgentsServiceJsonResult<T>> => runAgentsJsonPromise(postAgentsJsonEffect<T>(path, payload, options))

export const patchAgentsJson = async <T>(
  path: string,
  payload: unknown,
  options: AgentsJsonRequestOptions = {},
): Promise<AgentsServiceJsonResult<T>> => runAgentsJsonPromise(patchAgentsJsonEffect<T>(path, payload, options))

export const servicePath = (targetUrl: URL) => `${targetUrl.pathname}${targetUrl.search}`

export const __test__ = {
  DEFAULT_AGENTS_SERVICE_BASE_URL,
  DEFAULT_AGENTS_SERVICE_CLIENT_NAME,
}
