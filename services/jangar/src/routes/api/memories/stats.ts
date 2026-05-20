import { createFileRoute } from '@tanstack/react-router'
import { Effect, Layer, ManagedRuntime, pipe } from 'effect'

import { normalizeOptionalMemoryNoteNamespace } from '@proompteng/agent-contracts/memory-client'

import { MemoryNotes, MemoryNotesLive, MemoryNotesServiceError } from '~/server/memory-notes'

export const Route = createFileRoute('/api/memories/stats')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getMemoriesStatsHandler(request),
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

const clampNumber = (value: string | null, fallback: number, min: number, max: number) => {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

export const getMemoriesStatsHandlerEffect = (request: Request) =>
  pipe(
    Effect.gen(function* () {
      const url = new URL(request.url)
      const namespace = normalizeOptionalMemoryNoteNamespace(url.searchParams.get('namespace'))
      const days = clampNumber(url.searchParams.get('days'), 30, 1, 365)
      const topNamespaces = clampNumber(url.searchParams.get('topNamespaces'), 8, 1, 25)

      const service = yield* MemoryNotes
      const stats = yield* service.stats({ namespace, days, topNamespaces })
      return jsonResponse({ ok: true, ...stats })
    }),
    Effect.catchAll((error) => Effect.succeed(serviceErrorResponse(error))),
  )

export const getMemoriesStatsHandler = (request: Request) =>
  handlerRuntime.runPromise(getMemoriesStatsHandlerEffect(request))
