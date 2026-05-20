import { createFileRoute } from '@tanstack/react-router'
import { Effect, Layer, ManagedRuntime, pipe } from 'effect'

import { normalizeOptionalMemoryNoteNamespace } from '@proompteng/agent-contracts/memory-client'

import { MemoryNotes, MemoryNotesLive, MemoryNotesServiceError } from '~/server/memory-notes'

export const Route = createFileRoute('/api/memories/count')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getMemoriesCountHandler(request),
    },
  },
})

const handlerRuntime = ManagedRuntime.make(Layer.mergeAll(MemoryNotesLive))

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

const serviceErrorResponse = (error: unknown) => {
  if (error instanceof MemoryNotesServiceError) return errorResponse(error.message, error.status)
  const message = error instanceof Error ? error.message : String(error)
  return resolveServiceError(message)
}

export const getMemoriesCountHandlerEffect = (request: Request) =>
  pipe(
    Effect.gen(function* () {
      const url = new URL(request.url)
      const namespace = normalizeOptionalMemoryNoteNamespace(url.searchParams.get('namespace'))

      const service = yield* MemoryNotes
      const count = yield* service.count({ namespace })
      return jsonResponse({ ok: true, count })
    }),
    Effect.catchAll((error) => Effect.succeed(serviceErrorResponse(error))),
  )

export const getMemoriesCountHandler = (request: Request) =>
  handlerRuntime.runPromise(getMemoriesCountHandlerEffect(request))
