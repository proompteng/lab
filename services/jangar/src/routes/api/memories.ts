import { createFileRoute } from '@tanstack/react-router'
import { Effect, Layer, ManagedRuntime, pipe } from 'effect'

import { Memories, MemoriesLive } from '~/server/memories'
import { normalizeNamespace, parsePersistMemoryInput, parseRetrieveMemoryInput } from '~/server/memories-http'

export const Route = createFileRoute('/api/memories')({
  server: {
    handlers: {
      GET: async ({ request }) => getMemoriesHandler(request),
      POST: async ({ request }) => postMemoriesHandler(request),
    },
  },
})

const handlerRuntime = ManagedRuntime.make(Layer.mergeAll(MemoriesLive))

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

const errorResponse = (message: string, status = 500) => jsonResponse({ error: message }, status)

const resolveServiceError = (message: string) => {
  if (message.includes('DATABASE_URL')) return errorResponse(message, 503)
  return errorResponse(message, 500)
}

const resolveRequestError = (message: string) => {
  if (message === 'invalid JSON body') return errorResponse(message, 400)
  return resolveServiceError(message)
}

export const getMemoriesHandlerEffect = (request: Request) =>
  pipe(
    Effect.gen(function* () {
      const url = new URL(request.url)
      const payload = {
        namespace: normalizeNamespace(url.searchParams.get('namespace')),
        query: url.searchParams.get('query') ?? '',
        limit: url.searchParams.get('limit') ?? undefined,
      }

      const parsed = parseRetrieveMemoryInput(payload)
      if (!parsed.ok) return errorResponse(parsed.message, 400)

      const service = yield* Memories
      const records = yield* service.retrieve(parsed.value)
      return jsonResponse({ ok: true, memories: records })
    }),
    Effect.catchAll((error) => Effect.succeed(resolveServiceError(error.message))),
  )

export const postMemoriesHandlerEffect = (request: Request) =>
  pipe(
    Effect.gen(function* () {
      const payload: unknown = yield* Effect.tryPromise({
        try: () => request.json(),
        catch: () => new Error('invalid JSON body'),
      })
      if (!payload || typeof payload !== 'object') return errorResponse('invalid JSON body', 400)

      const parsed = parsePersistMemoryInput(payload as Record<string, unknown>)
      if (!parsed.ok) return errorResponse(parsed.message, 400)

      const service = yield* Memories
      const record = yield* service.persist(parsed.value)
      return jsonResponse({ ok: true, memory: record }, 201)
    }),
    Effect.catchAll((error) => Effect.succeed(resolveRequestError(error.message))),
  )

export const getMemoriesHandler = (request: Request) => handlerRuntime.runPromise(getMemoriesHandlerEffect(request))

export const postMemoriesHandler = (request: Request) => handlerRuntime.runPromise(postMemoriesHandlerEffect(request))
