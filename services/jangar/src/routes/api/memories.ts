import { createFileRoute } from '@tanstack/react-router'
import { Effect, Layer, ManagedRuntime } from 'effect'

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

export const getMemoriesHandler = async (request: Request) => {
  const url = new URL(request.url)
  const payload = {
    namespace: normalizeNamespace(url.searchParams.get('namespace')),
    query: url.searchParams.get('query') ?? '',
    limit: url.searchParams.get('limit') ?? undefined,
  }

  const parsed = parseRetrieveMemoryInput(payload)
  if (!parsed.ok) return errorResponse(parsed.message, 400)

  const result = await handlerRuntime.runPromise(
    Effect.either(
      Effect.gen(function* () {
        const service = yield* Memories
        return yield* service.retrieve(parsed.value)
      }),
    ),
  )

  if (result._tag === 'Left') return resolveServiceError(result.left.message)
  return jsonResponse({ ok: true, memories: result.right })
}

export const postMemoriesHandler = async (request: Request) => {
  const payload: unknown = await request.json().catch(() => null)
  if (!payload || typeof payload !== 'object') return errorResponse('invalid JSON body', 400)

  const parsed = parsePersistMemoryInput(payload as Record<string, unknown>)
  if (!parsed.ok) return errorResponse(parsed.message, 400)

  const result = await handlerRuntime.runPromise(
    Effect.either(
      Effect.gen(function* () {
        const service = yield* Memories
        return yield* service.persist(parsed.value)
      }),
    ),
  )

  if (result._tag === 'Left') return resolveServiceError(result.left.message)
  return jsonResponse({ ok: true, memory: result.right }, 201)
}
