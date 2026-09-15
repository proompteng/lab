import { createFileRoute } from '@tanstack/react-router'
import { Effect, Layer, ManagedRuntime, pipe } from 'effect'

import { Atlas, AtlasLive } from '~/server/atlas'
import { resolveAtlasRuntimeConfig } from '~/server/atlas-config'
import { DEFAULT_REF } from '~/server/atlas-http'
import { BumbaWorkflows, BumbaWorkflowsLive } from '~/server/bumba'
import { DEFAULT_ATLAS_REF, normalizeSearchParam, resolveAtlasRepository } from '~/server/git-utils'

type EnrichPayload = {
  repository?: string
  ref?: string
  path?: string
  commit?: string
  contentHash?: string
  metadata?: Record<string, unknown>
  mode?: string
  pathPrefix?: string
  maxFiles?: number
  context?: string
}

export const Route = createFileRoute('/api/enrich')({
  server: {
    handlers: {
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
      POST: async ({ request }: JangarServerRouteArgs) => postEnrichHandler(request),
    },
  },
})

const handlerRuntime = ManagedRuntime.make(Layer.mergeAll(AtlasLive, BumbaWorkflowsLive))

const shouldUseLocalEnrich = () => {
  const atlasConfig = resolveAtlasRuntimeConfig(process.env)
  return atlasConfig.localMode || !atlasConfig.databaseConfigured
}

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
  if (message.toLowerCase().includes('already running')) return errorResponse(message, 409)
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

const normalizeOptionalNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const normalizePathPrefix = (value: unknown) => {
  const trimmed = normalizeOptionalText(value)
  if (!trimmed) return undefined
  if (trimmed.startsWith('/') || trimmed.includes('..')) {
    throw new Error('pathPrefix must be repo-relative')
  }
  return trimmed.replace(/^\//, '')
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

  const agentRunIdentifier = normalizeOptionalText(metadata?.agentRunIdentifier)
  const workflowIdentifier = normalizeOptionalText(metadata?.workflowIdentifier) ?? agentRunIdentifier
  const receivedAt = normalizeOptionalText(metadata?.receivedAt)

  return {
    repository,
    ref: ref ?? DEFAULT_REF,
    commit,
    deliveryId,
    eventType,
    installationId,
    senderLogin,
    agentRunIdentifier,
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
      const mode = normalizeOptionalText(payloadRecord.mode)
      if (mode === 'repository') {
        const repositoryParam = normalizeOptionalText(payloadRecord.repository)
        if (!repositoryParam) return errorResponse('Repository is required.', 400)

        const repoResult = resolveAtlasRepository(repositoryParam)
        if (!repoResult.ok) return errorResponse(repoResult.message, 400)

        const ref = normalizeOptionalText(payloadRecord.ref) ?? DEFAULT_REF
        if (ref !== DEFAULT_REF) {
          return errorResponse('Atlas reconciles only the authoritative main ref.', 409)
        }
        const commit = normalizeOptionalText(payloadRecord.commit)

        let pathPrefix: string | undefined
        try {
          pathPrefix = normalizePathPrefix(payloadRecord.pathPrefix)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Invalid path prefix.'
          return errorResponse(message, 400)
        }

        const maxFiles = normalizeOptionalNumber(payloadRecord.maxFiles)
        if (maxFiles !== undefined && maxFiles <= 0) {
          return errorResponse('Max files must be a positive integer.', 400)
        }
        if (pathPrefix || maxFiles !== undefined) {
          return errorResponse('Partial Atlas repository reconciliation is not supported.', 409)
        }

        const atlas = yield* Atlas
        const bumbaWorkflows = yield* BumbaWorkflows

        const repository = yield* atlas.getRepositoryByName({ name: repoResult.repository })

        const workflow = yield* bumbaWorkflows.startAtlasReconciliation({
          repository: repoResult.repository,
          ref,
          commit,
        })

        return jsonResponse(
          {
            ok: true,
            repository,
            workflow,
            request: {
              repository: repoResult.repository,
              ref,
              commit,
              pathPrefix,
              maxFiles,
              idempotencyKey: request.headers.get('idempotency-key') ?? undefined,
            },
          },
          202,
        )
      }

      const eventInput = resolveAtlasEventInput(payloadRecord)
      if (!eventInput) {
        return errorResponse(
          'Direct Atlas file writes are disabled; request a full main repository reconciliation.',
          409,
        )
      }

      const atlas = yield* Atlas
      const repository = yield* atlas.upsertRepository({
        name: eventInput.repository,
        defaultRef: DEFAULT_REF,
      })
      const githubEvent = yield* atlas.upsertGithubEvent({
        repositoryId: repository.id,
        deliveryId: eventInput.deliveryId,
        eventType: eventInput.eventType,
        repository: eventInput.repository,
        installationId: eventInput.installationId,
        senderLogin: eventInput.senderLogin,
        payload: eventInput.payload,
        receivedAt: eventInput.receivedAt,
      })

      return jsonResponse(
        {
          ok: true,
          repository,
          githubEvent,
          workflow: null,
          workflows: [],
        },
        202,
      )
    }),
    Effect.catchAll((error) => Effect.succeed(resolveRequestError(error.message))),
  )

const postLocalEnrichHandler = async (request: Request) => {
  const payload: unknown = await request.json().catch(() => null)
  if (!payload || typeof payload !== 'object') return errorResponse('invalid JSON body', 400)

  const body = payload as EnrichPayload
  const mode = normalizeOptionalText(body.mode)
  if (mode !== 'repository') {
    return errorResponse('Direct Atlas file writes are disabled; request a full main repository reconciliation.', 409)
  }

  const ref = normalizeSearchParam(body.ref ?? '') || DEFAULT_ATLAS_REF
  if (ref !== DEFAULT_ATLAS_REF) {
    return errorResponse('Atlas reconciles only the authoritative main ref.', 409)
  }
  if (normalizeOptionalText(body.pathPrefix) || normalizeOptionalNumber(body.maxFiles) !== undefined) {
    return errorResponse('Partial Atlas repository reconciliation is not supported.', 409)
  }

  return errorResponse('Atlas repository reconciliation requires configured Postgres and Temporal services.', 503)
}

export const postEnrichHandler = (request: Request) =>
  shouldUseLocalEnrich() ? postLocalEnrichHandler(request) : handlerRuntime.runPromise(postEnrichHandlerEffect(request))
