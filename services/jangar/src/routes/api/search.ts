import { createFileRoute } from '@tanstack/react-router'
import { Effect, Layer, ManagedRuntime, pipe } from 'effect'

import { Atlas, AtlasLive } from '~/server/atlas'
import { parseAtlasSearchInput } from '~/server/atlas-http'

export const Route = createFileRoute('/api/search')({
  server: {
    handlers: {
      GET: async ({ request }) => getSearchHandler(request),
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

const errorResponse = (message: string, status = 500) => jsonResponse({ error: message }, status)

const resolveServiceError = (message: string) => {
  if (message.includes('DATABASE_URL')) return errorResponse(message, 503)
  if (message.includes('OPENAI_API_KEY')) return errorResponse(message, 503)
  return errorResponse(message, 500)
}

const splitList = (values: string[]) =>
  values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

export const getSearchHandlerEffect = (request: Request) =>
  pipe(
    Effect.gen(function* () {
      const url = new URL(request.url)
      const payload = {
        query: url.searchParams.get('query') ?? '',
        limit: url.searchParams.get('limit') ?? undefined,
        repository: url.searchParams.get('repository') ?? undefined,
        ref: url.searchParams.get('ref') ?? undefined,
        pathPrefix: url.searchParams.get('pathPrefix') ?? undefined,
        tags: splitList(url.searchParams.getAll('tags')),
        kinds: splitList(url.searchParams.getAll('kinds')),
      }

      const parsed = parseAtlasSearchInput(payload)
      if (!parsed.ok) return errorResponse(parsed.message, 400)

      const atlas = yield* Atlas
      const matches = yield* atlas.search(parsed.value)
      return jsonResponse({ ok: true, matches })
    }),
    Effect.catchAll((error) => Effect.succeed(resolveServiceError(error.message))),
  )

export const getSearchHandler = (request: Request) => handlerRuntime.runPromise(getSearchHandlerEffect(request))
