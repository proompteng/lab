import { createFileRoute } from '@tanstack/react-router'
import { Effect, Layer, ManagedRuntime, pipe } from 'effect'

import { Memories, MemoriesLive } from '~/server/memories'
import { normalizeOptionalNamespace } from '~/server/memories-http'

export const Route = createFileRoute('/api/memories/count')({
  server: {
    handlers: {
      GET: async ({ request }) => getMemoriesCountHandler(request),
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

export const getMemoriesCountHandlerEffect = (request: Request) =>
  pipe(
    Effect.gen(function* () {
      const url = new URL(request.url)
      const namespace = normalizeOptionalNamespace(url.searchParams.get('namespace'))

      const service = yield* Memories
      const count = yield* service.count({ namespace })
      return jsonResponse({ ok: true, count })
    }),
    Effect.catchAll((error) => Effect.succeed(resolveServiceError(error.message))),
  )

export const getMemoriesCountHandler = (request: Request) =>
  handlerRuntime.runPromise(getMemoriesCountHandlerEffect(request))
