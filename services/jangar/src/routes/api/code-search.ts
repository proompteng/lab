import { createFileRoute } from '@tanstack/react-router'
import { Duration, Effect, Layer, ManagedRuntime, pipe } from 'effect'

import { Atlas, AtlasLive } from '~/server/atlas'
import { resolveAtlasRuntimeConfig } from '~/server/atlas-config'
import { DEFAULT_REF, MAX_SEARCH_LIMIT, parseAtlasCodeSearchInput } from '~/server/atlas-http'
import type { AtlasCodeSearchMatch } from '~/server/atlas-store'

type CodeSearchPayload = {
  query?: string
  limit?: number
  repository?: string
  ref?: string
  pathPrefix?: string
  language?: string
}

export const Route = createFileRoute('/api/code-search')({
  server: {
    handlers: {
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
      POST: async ({ request }: JangarServerRouteArgs) => postCodeSearchHandler(request),
    },
  },
})

const handlerRuntime = ManagedRuntime.make(Layer.mergeAll(AtlasLive))

const jsonResponse = (payload: unknown, status = 200) => {
  const body = JSON.stringify(payload)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    },
  })
}

const errorResponse = (message: string, status = 500) => jsonResponse({ ok: false, message, error: message }, status)

const resolveServiceError = (message: string) => {
  const normalized = message.toLowerCase()
  if (message.includes('DATABASE_URL')) return errorResponse(message, 503)
  if (message.includes('OPENAI_API_KEY')) return errorResponse(message, 503)
  if (normalized.includes('not ready')) return errorResponse(message, 503)
  if (normalized.includes('timed out') || normalized.includes('timeout')) return errorResponse(message, 504)
  return errorResponse(message, 500)
}

const resolveRequestError = (message: string) => {
  if (message === 'invalid JSON body') return errorResponse(message, 400)
  return resolveServiceError(message)
}

const parseJsonBody = async (request: Request): Promise<CodeSearchPayload> => {
  try {
    const json = (await request.json()) as unknown
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new Error('invalid JSON body')
    }
    return json as CodeSearchPayload
  } catch {
    throw new Error('invalid JSON body')
  }
}

const toItem = (match: AtlasCodeSearchMatch) => ({
  fileVersionId: match.fileVersion.id,
  repository: match.repository.name,
  ref: match.fileVersion.repositoryRef,
  commit: match.fileVersion.repositoryCommit ?? undefined,
  path: match.fileKey.path,
  startLine: match.chunk.startLine,
  endLine: match.chunk.endLine,
  score: match.score,
  retrievalMode: match.retrievalMode,
  degradation: match.degradation,
  signals: match.signals,
  contentHash: match.fileVersion.contentHash,
  updatedAt: match.fileVersion.updatedAt,
  snippet: match.chunk.content,
})

export const postCodeSearchHandlerEffect = (request: Request) =>
  pipe(
    Effect.gen(function* () {
      const payload = yield* Effect.tryPromise({
        try: () => parseJsonBody(request),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })

      const parsed = parseAtlasCodeSearchInput(payload as Record<string, unknown>)
      if (!parsed.ok) return errorResponse(parsed.message, 400)

      const requestedLimit = parsed.value.limit ?? 10
      const effectiveLimit = Math.min(Math.max(requestedLimit, 1), MAX_SEARCH_LIMIT)
      const ref = parsed.value.ref ?? DEFAULT_REF

      const atlas = yield* Atlas
      const indexHealth = yield* atlas.codeSearchHealth({
        repository: parsed.value.repository,
        ref,
        pathPrefix: parsed.value.pathPrefix,
        language: parsed.value.language,
      })

      if (indexHealth.status !== 'ok') {
        return jsonResponse(
          {
            ok: false,
            message: indexHealth.message,
            error: indexHealth.message,
            indexHealth,
          },
          503,
        )
      }

      let matches: AtlasCodeSearchMatch[]
      try {
        matches = yield* atlas.codeSearch({
          ...parsed.value,
          ref,
          limit: Math.min(MAX_SEARCH_LIMIT, effectiveLimit),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const normalized = message.toLowerCase()
        const looksLikeTransientDbBlip =
          normalized.includes('econnrefused') ||
          normalized.includes('connection terminated unexpectedly') ||
          normalized.includes('server closed the connection unexpectedly')

        if (!looksLikeTransientDbBlip) throw error

        // Port-forwards can briefly restart (local listener down for ~1s). Retry once.
        yield* Effect.sleep(Duration.millis(750))
        matches = yield* atlas.codeSearch({
          ...parsed.value,
          ref,
          limit: Math.min(MAX_SEARCH_LIMIT, effectiveLimit),
        })
      }

      const items = matches.map(toItem)
      return jsonResponse({ ok: true, matches, items, total: items.length, indexHealth })
    }),
    Effect.catchAll((error) => Effect.succeed(resolveRequestError(error.message))),
  )

export const postCodeSearchHandler = async (request: Request) => {
  const effectiveTimeoutMs = resolveAtlasRuntimeConfig(process.env).codeSearchTimeoutMs
  const controller = new AbortController()
  let timedOut = false
  const abortOnDisconnect = () => controller.abort(request.signal.reason)
  request.signal.addEventListener('abort', abortOnDisconnect, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`atlas code search timed out after ${effectiveTimeoutMs}ms`))
  }, effectiveTimeoutMs)

  try {
    return await handlerRuntime.runPromise(postCodeSearchHandlerEffect(request), { signal: controller.signal })
  } catch (error) {
    if (timedOut) return errorResponse(`atlas code search timed out after ${effectiveTimeoutMs}ms`, 504)
    if (request.signal.aborted) return errorResponse('atlas code search request was canceled', 499)
    const message = error instanceof Error ? error.message : String(error)
    return resolveServiceError(message)
  } finally {
    clearTimeout(timeout)
    request.signal.removeEventListener('abort', abortOnDisconnect)
  }
}
