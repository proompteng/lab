import { createFileRoute } from '@tanstack/react-router'
import { Effect, Layer, ManagedRuntime, pipe } from 'effect'

import { Atlas, AtlasLive } from '~/server/atlas'
import { normalizeSearchParam, resolveLimit } from '~/server/git-utils'

type AtlasAstFact = {
  nodeType: string
  matchText: string
  startLine: number | null
  endLine: number | null
}

const DEFAULT_LIMIT = 300
const MAX_LIMIT = 1000

export const Route = createFileRoute('/api/atlas/ast')({
  server: {
    handlers: {
      GET: async ({ request }) => getAtlasAstHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
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
  if (message.includes('DATABASE_URL')) return errorResponse(message, 503)
  if (message.includes('OPENAI_API_KEY')) return errorResponse(message, 503)
  return errorResponse(message, 500)
}

const getAstHandlerEffect = (request: Request) =>
  pipe(
    Effect.gen(function* () {
      const url = new URL(request.url)
      const fileVersionId = normalizeSearchParam(url.searchParams.get('fileVersionId'))
      const limit = resolveLimit(normalizeSearchParam(url.searchParams.get('limit')), DEFAULT_LIMIT, MAX_LIMIT)

      if (!fileVersionId) return errorResponse('fileVersionId is required.', 400)

      const atlas = yield* Atlas
      const preview = yield* atlas.getAstPreview({ fileVersionId, limit })

      const facts: AtlasAstFact[] = preview.facts.map((fact) => ({
        nodeType: fact.nodeType,
        matchText: fact.matchText,
        startLine: fact.startLine,
        endLine: fact.endLine,
      }))

      return jsonResponse({ ok: true, fileVersionId, summary: preview.summary ?? undefined, facts })
    }),
    Effect.catchAll((error) => Effect.succeed(resolveServiceError(error.message))),
  )

export const getAtlasAstHandler = async (request: Request) => handlerRuntime.runPromise(getAstHandlerEffect(request))
