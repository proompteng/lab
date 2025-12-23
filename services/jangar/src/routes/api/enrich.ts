import { createFileRoute } from '@tanstack/react-router'
import { Effect, Layer, ManagedRuntime, pipe } from 'effect'

import { Atlas, AtlasLive } from '~/server/atlas'
import { parseAtlasIndexInput } from '~/server/atlas-http'

export const Route = createFileRoute('/api/enrich')({
  server: {
    handlers: {
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
      POST: async ({ request }) => postEnrichHandler(request),
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

const resolveRequestError = (message: string) => {
  if (message === 'invalid JSON body') return errorResponse(message, 400)
  return resolveServiceError(message)
}

export const postEnrichHandlerEffect = (request: Request) =>
  pipe(
    Effect.gen(function* () {
      const payload: unknown = yield* Effect.tryPromise({
        try: () => request.json(),
        catch: () => new Error('invalid JSON body'),
      })
      if (!payload || typeof payload !== 'object') return errorResponse('invalid JSON body', 400)

      const parsed = parseAtlasIndexInput(payload as Record<string, unknown>)
      if (!parsed.ok) return errorResponse(parsed.message, 400)

      const atlas = yield* Atlas
      const repository = yield* atlas.upsertRepository({
        name: parsed.value.repository,
        defaultRef: parsed.value.ref,
      })
      const fileKey = yield* atlas.upsertFileKey({
        repositoryId: repository.id,
        path: parsed.value.path,
      })
      const fileVersion = yield* atlas.upsertFileVersion({
        fileKeyId: fileKey.id,
        repositoryRef: parsed.value.ref,
        repositoryCommit: parsed.value.commit ?? null,
        contentHash: parsed.value.contentHash ?? null,
        metadata: parsed.value.metadata,
      })

      return jsonResponse({ ok: true, repository, fileKey, fileVersion }, 202)
    }),
    Effect.catchAll((error) => Effect.succeed(resolveRequestError(error.message))),
  )

export const postEnrichHandler = (request: Request) => handlerRuntime.runPromise(postEnrichHandlerEffect(request))
