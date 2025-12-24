import { createFileRoute } from '@tanstack/react-router'
import { Effect, Layer, ManagedRuntime, pipe } from 'effect'

import { Atlas, AtlasLive } from '~/server/atlas'
import { normalizeSearchParam, resolveLimit } from '~/server/git-utils'

type AtlasIndexedItem = {
  repository?: string
  ref?: string
  commit?: string | null
  path?: string
  contentHash?: string
  updatedAt?: string
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export const Route = createFileRoute('/api/atlas/indexed')({
  server: {
    handlers: {
      GET: async ({ request }) => getAtlasIndexedHandler(request),
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

const getIndexedHandlerEffect = (request: Request) =>
  pipe(
    Effect.gen(function* () {
      const url = new URL(request.url)
      const limit = resolveLimit(normalizeSearchParam(url.searchParams.get('limit')), DEFAULT_LIMIT, MAX_LIMIT)
      const repository = normalizeSearchParam(url.searchParams.get('repository')) || undefined
      const ref = normalizeSearchParam(url.searchParams.get('ref')) || undefined
      const pathPrefix = normalizeSearchParam(url.searchParams.get('pathPrefix')) || undefined

      const atlas = yield* Atlas
      const items = yield* atlas.listIndexedFiles({ limit, repository, ref, pathPrefix })

      const responseItems: AtlasIndexedItem[] = items.map((item) => ({
        repository: item.repository,
        ref: item.ref,
        commit: item.commit ?? undefined,
        path: item.path,
        contentHash: item.contentHash,
        updatedAt: item.updatedAt
          ? item.updatedAt instanceof Date
            ? item.updatedAt.toISOString()
            : String(item.updatedAt)
          : undefined,
      }))

      return jsonResponse({ ok: true, items: responseItems })
    }),
    Effect.catchAll((error) => Effect.succeed(resolveServiceError(error.message))),
  )

export const getAtlasIndexedHandler = async (request: Request) =>
  handlerRuntime.runPromise(getIndexedHandlerEffect(request))
