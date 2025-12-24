import { createFileRoute } from '@tanstack/react-router'
import { Effect, Layer, ManagedRuntime, pipe } from 'effect'

import { Atlas, AtlasLive } from '~/server/atlas'
import { DEFAULT_REF, parseAtlasIndexInput } from '~/server/atlas-http'

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const normalizeOptionalText = (value: unknown) => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const resolveAtlasEventInput = (payload: Record<string, unknown>) => {
  const metadata = isRecord(payload.metadata) ? payload.metadata : undefined
  const deliveryId = normalizeOptionalText(metadata?.deliveryId)
  const eventType = normalizeOptionalText(metadata?.event)

  const repository =
    normalizeOptionalText(payload.repository) ??
    normalizeOptionalText(
      metadata?.identifiers && (metadata.identifiers as { repositoryFullName?: unknown })?.repositoryFullName,
    ) ??
    normalizeOptionalText(
      metadata?.payload && (metadata.payload as { repository?: { full_name?: unknown } })?.repository?.full_name,
    )

  if (!deliveryId || !eventType || !repository) return null

  const payloadValue = metadata?.payload
  const webhookPayload = isRecord(payloadValue) ? payloadValue : payload
  const installationIdRaw =
    (payloadValue as { installation?: { id?: unknown } })?.installation?.id ??
    (payload as { installation?: { id?: unknown } })?.installation?.id
  const installationId =
    typeof installationIdRaw === 'string'
      ? installationIdRaw
      : typeof installationIdRaw === 'number'
        ? String(installationIdRaw)
        : null

  const senderLogin =
    normalizeOptionalText(metadata?.sender) ??
    normalizeOptionalText((payloadValue as { sender?: { login?: unknown } })?.sender?.login) ??
    normalizeOptionalText((payload as { sender?: { login?: unknown } })?.sender?.login)

  const ref =
    normalizeOptionalText(payload.ref) ??
    normalizeOptionalText(
      (payloadValue as { repository?: { default_branch?: unknown } })?.repository?.default_branch,
    ) ??
    normalizeOptionalText((payloadValue as { pull_request?: { base?: { ref?: unknown } } })?.pull_request?.base?.ref)

  const commit =
    normalizeOptionalText(payload.commit) ??
    normalizeOptionalText((payloadValue as { pull_request?: { head?: { sha?: unknown } } })?.pull_request?.head?.sha) ??
    normalizeOptionalText((payloadValue as { after?: unknown })?.after) ??
    normalizeOptionalText((payloadValue as { head_commit?: { id?: unknown } })?.head_commit?.id)

  const workflowIdentifier = normalizeOptionalText(metadata?.workflowIdentifier)
  const receivedAt = normalizeOptionalText(metadata?.receivedAt)

  return {
    repository,
    ref: ref ?? DEFAULT_REF,
    commit,
    deliveryId,
    eventType,
    installationId,
    senderLogin,
    workflowIdentifier,
    receivedAt,
    payload: webhookPayload,
  }
}

export const postEnrichHandlerEffect = (request: Request) =>
  pipe(
    Effect.gen(function* () {
      const payload: unknown = yield* Effect.tryPromise({
        try: () => request.json(),
        catch: () => new Error('invalid JSON body'),
      })
      if (!payload || typeof payload !== 'object') return errorResponse('invalid JSON body', 400)

      const payloadRecord = payload as Record<string, unknown>
      const parsed = parseAtlasIndexInput(payloadRecord)
      const eventInput = resolveAtlasEventInput(payloadRecord)
      if (!parsed.ok && !eventInput) return errorResponse(parsed.message, 400)

      const atlas = yield* Atlas

      let repository = null
      if (parsed.ok || eventInput) {
        const repositoryName = parsed.ok ? parsed.value.repository : eventInput?.repository
        const repositoryRef = parsed.ok ? parsed.value.ref : eventInput?.ref
        if (repositoryName) {
          repository = yield* atlas.upsertRepository({
            name: repositoryName,
            defaultRef: repositoryRef,
          })
        }
      }

      let fileKey = null
      let fileVersion = null
      if (parsed.ok && repository) {
        fileKey = yield* atlas.upsertFileKey({
          repositoryId: repository.id,
          path: parsed.value.path,
        })
        fileVersion = yield* atlas.upsertFileVersion({
          fileKeyId: fileKey.id,
          repositoryRef: parsed.value.ref,
          repositoryCommit: parsed.value.commit ?? null,
          contentHash: parsed.value.contentHash ?? null,
          metadata: parsed.value.metadata,
        })
      }

      let githubEvent = null
      let ingestion = null
      if (eventInput) {
        githubEvent = yield* atlas.upsertGithubEvent({
          repositoryId: repository?.id ?? null,
          deliveryId: eventInput.deliveryId,
          eventType: eventInput.eventType,
          repository: eventInput.repository,
          installationId: eventInput.installationId,
          senderLogin: eventInput.senderLogin,
          payload: eventInput.payload,
          receivedAt: eventInput.receivedAt,
        })

        const workflowId = eventInput.workflowIdentifier ?? eventInput.deliveryId
        ingestion = yield* atlas.upsertIngestion({
          eventId: githubEvent.id,
          workflowId,
          status: 'accepted',
          startedAt: eventInput.receivedAt,
        })
      }

      return jsonResponse(
        {
          ok: true,
          repository,
          fileKey,
          fileVersion,
          githubEvent,
          ingestion,
        },
        202,
      )
    }),
    Effect.catchAll((error) => Effect.succeed(resolveRequestError(error.message))),
  )

export const postEnrichHandler = (request: Request) => handlerRuntime.runPromise(postEnrichHandlerEffect(request))
