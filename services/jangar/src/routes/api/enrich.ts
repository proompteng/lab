import { extname } from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import { Effect, Layer, ManagedRuntime, pipe } from 'effect'

import { Atlas, AtlasLive } from '~/server/atlas'
import { type AtlasIndexInput, DEFAULT_REF, parseAtlasIndexInput } from '~/server/atlas-http'
import { BumbaWorkflows, BumbaWorkflowsLive, type StartEnrichFileResult } from '~/server/bumba'
import {
  DEFAULT_ATLAS_REF,
  ensureFileAtRef,
  ensureGitRef,
  normalizeSearchParam,
  resolveAtlasRepository,
  runGitCommand,
} from '~/server/git-utils'

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

type GitIndexResolution = { ok: true; value: AtlasIndexInput } | { ok: false; message: string; status?: number }

export const Route = createFileRoute('/api/enrich')({
  server: {
    handlers: {
      GET: async () => new Response('Method Not Allowed', { status: 405 }),
      POST: async ({ request }) => postEnrichHandler(request),
    },
  },
})

const handlerRuntime = ManagedRuntime.make(Layer.mergeAll(AtlasLive, BumbaWorkflowsLive))

const shouldUseLocalEnrich = () => process.env.ATLAS_LOCAL_MODE === 'true' || !process.env.DATABASE_URL

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

const resolveRequestError = (message: string) => {
  if (message === 'invalid JSON body') return errorResponse(message, 400)
  return resolveServiceError(message)
}

const isMissingWorktreeFile = (message: string) =>
  message.includes('File not found in worktree after refresh') || message.includes('Commit not found after fetch')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const LOCK_FILENAMES = new Set([
  'bun.lock',
  'composer.lock',
  'cargo.lock',
  'gemfile.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-lock.yml',
  'poetry.lock',
  'pipfile.lock',
  'yarn.lock',
  'npm-shrinkwrap.json',
])
const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.avi',
  '.avif',
  '.bmp',
  '.bz2',
  '.class',
  '.db',
  '.dll',
  '.dylib',
  '.eot',
  '.exe',
  '.flac',
  '.gif',
  '.gz',
  '.ico',
  '.icns',
  '.jar',
  '.jpeg',
  '.jpg',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.otf',
  '.pdf',
  '.png',
  '.psd',
  '.rar',
  '.so',
  '.sqlite',
  '.sqlite3',
  '.tar',
  '.tgz',
  '.ttf',
  '.wav',
  '.webp',
  '.woff',
  '.woff2',
  '.xz',
  '.zip',
  '.wasm',
  '.bin',
])

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

const shouldSkipFilePath = (filePath: string) => {
  const normalized = filePath.trim()
  if (normalized.length === 0) return true
  const lower = normalized.toLowerCase()
  const base = lower.split('/').pop() ?? lower
  const extension = extname(base)

  if (LOCK_FILENAMES.has(base)) return true
  if (extension === '.lock') return true
  if (BINARY_EXTENSIONS.has(extension)) return true

  return false
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

const resolveCommit = async (ref: string, path: string) => {
  const result = await runGitCommand(['log', '-1', '--format=%H', ref, '--', path])
  if (result.exitCode !== 0) return undefined
  const commit = result.stdout.trim()
  return commit || undefined
}

const resolveRefCommit = async (ref: string) => {
  const result = await runGitCommand(['rev-parse', ref])
  if (result.exitCode !== 0) return undefined
  const commit = result.stdout.trim()
  return commit || undefined
}

const resolveContentHash = async (ref: string, path: string) => {
  const result = await runGitCommand(['rev-parse', `${ref}:${path}`])
  if (result.exitCode !== 0) return undefined
  const hash = result.stdout.trim()
  return hash || undefined
}

const resolveGitIndexInput = async (payload: Record<string, unknown>): Promise<GitIndexResolution> => {
  const repository = normalizeOptionalText(payload.repository)
  const ref = normalizeOptionalText(payload.ref) ?? DEFAULT_REF
  const path = normalizeOptionalText(payload.path)

  if (!repository) return { ok: false, message: 'Repository is required.', status: 400 }
  if (!path) return { ok: false, message: 'Path is required.', status: 400 }

  const repoResult = resolveAtlasRepository(repository)
  if (!repoResult.ok) {
    return {
      ok: false,
      message: 'Commit or content hash is required for non-default repositories.',
      status: 400,
    }
  }

  const refResult = await ensureGitRef(ref)
  if (!refResult.ok) return { ok: false, message: refResult.message, status: 404 }

  const fileResult = await ensureFileAtRef(ref, path)
  if (!fileResult.ok) return { ok: false, message: fileResult.message, status: 404 }

  const commit = await resolveCommit(ref, path)
  const contentHash = await resolveContentHash(ref, path)

  if (!commit && !contentHash) {
    return { ok: false, message: 'Commit or content hash is required.', status: 400 }
  }

  const parsed = parseAtlasIndexInput({
    ...payload,
    repository,
    ref,
    path,
    commit,
    contentHash,
  })

  if (!parsed.ok) return { ok: false, message: parsed.message, status: 400 }

  return { ok: true, value: parsed.value }
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
        const refResult = yield* Effect.tryPromise({
          try: () => ensureGitRef(ref),
          catch: (error) => error as Error,
        })
        if (!refResult.ok) return errorResponse(refResult.message, 404)

        const commit =
          normalizeOptionalText(payloadRecord.commit) ??
          (yield* Effect.tryPromise({
            try: () => resolveRefCommit(ref),
            catch: (error) => error as Error,
          }))
        if (!commit) return errorResponse('Commit not found for ref.', 404)

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

        const context = normalizeOptionalText(payloadRecord.context)

        const atlas = yield* Atlas
        const bumbaWorkflows = yield* BumbaWorkflows

        const repository = yield* atlas.upsertRepository({
          name: repoResult.repository,
          defaultRef: ref,
        })

        const workflow = yield* bumbaWorkflows.startEnrichRepository({
          repository: repoResult.repository,
          ref,
          commit,
          context,
          pathPrefix: pathPrefix ?? null,
          maxFiles: maxFiles ?? null,
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
              context: context ?? undefined,
              idempotencyKey: request.headers.get('idempotency-key') ?? undefined,
            },
          },
          202,
        )
      }

      const parsed = parseAtlasIndexInput(payloadRecord)
      const parsedMessage = parsed.ok ? null : parsed.message
      const eventInput = resolveAtlasEventInput(payloadRecord)

      let parsedInput: AtlasIndexInput | null = null
      if (parsed.ok) {
        parsedInput = parsed.value
      } else if (parsedMessage === 'Commit or content hash is required.') {
        const gitResolved = yield* Effect.tryPromise({
          try: () => resolveGitIndexInput(payloadRecord),
          catch: (error) => error as Error,
        })
        if (gitResolved.ok) {
          parsedInput = gitResolved.value
        } else if (!eventInput) {
          return errorResponse(gitResolved.message, gitResolved.status ?? 400)
        }
      }

      if (!parsedInput && !eventInput) return errorResponse(parsedMessage ?? 'Invalid Atlas index input.', 400)

      const atlas = yield* Atlas
      const bumbaWorkflows = yield* BumbaWorkflows

      let repository = null
      if (parsedInput || eventInput) {
        const repositoryName = parsedInput?.repository ?? eventInput?.repository
        const repositoryRef = parsedInput?.ref ?? eventInput?.ref
        if (repositoryName) {
          repository = yield* atlas.upsertRepository({
            name: repositoryName,
            defaultRef: repositoryRef,
          })
        }
      }

      const shouldSkipParsedPath = Boolean(parsedInput && shouldSkipFilePath(parsedInput.path))

      let fileKey = null
      let fileVersion = null
      if (parsedInput && repository && !shouldSkipParsedPath) {
        fileKey = yield* atlas.upsertFileKey({
          repositoryId: repository.id,
          path: parsedInput.path,
        })
        fileVersion = yield* atlas.upsertFileVersion({
          fileKeyId: fileKey.id,
          repositoryRef: parsedInput.ref,
          repositoryCommit: parsedInput.commit ?? null,
          contentHash: parsedInput.contentHash ?? null,
          metadata: parsedInput.metadata,
        })
      }

      let githubEvent = null
      let ingestion = null
      let ingestionTarget = null
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
      }

      let workflow = null
      const workflows: StartEnrichFileResult[] = []
      if (parsedInput && !eventInput) {
        if (shouldSkipParsedPath) {
          return jsonResponse(
            {
              ok: true,
              repository,
              fileKey,
              fileVersion,
              githubEvent,
              ingestion,
              ingestionTarget,
              workflow,
              workflows,
              skipped: true,
              reason: 'excluded_file_type',
            },
            202,
          )
        }
        const startResult = yield* pipe(
          bumbaWorkflows.startEnrichFile({
            filePath: parsedInput.path,
            commit: parsedInput.commit ?? null,
            repository: parsedInput.repository,
            ref: parsedInput.ref,
          }),
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catchAll((error) => {
            const message = error instanceof Error ? error.message : String(error)
            if (isMissingWorktreeFile(message)) {
              return Effect.succeed({ ok: false as const, status: 404, message })
            }
            return Effect.fail(error)
          }),
        )
        if (!startResult.ok) {
          return errorResponse(startResult.message, startResult.status)
        }
        workflow = startResult.value

        if (githubEvent) {
          ingestion = yield* atlas.upsertIngestion({
            eventId: githubEvent.id,
            workflowId: workflow.workflowId,
            status: 'accepted',
          })
        }
      }

      if (ingestion && fileVersion) {
        ingestionTarget = yield* atlas.upsertIngestionTarget({
          ingestionId: ingestion.id,
          fileVersionId: fileVersion.id,
          kind: 'model_enrichment',
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
          ingestionTarget,
          workflow,
          workflows,
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
  if (mode === 'repository') {
    const repositoryParam = normalizeSearchParam(body.repository ?? '')
    if (!repositoryParam) return errorResponse('repository is required', 400)

    const repoResult = resolveAtlasRepository(repositoryParam)
    if (!repoResult.ok) return errorResponse(repoResult.message, 400)

    const ref = normalizeSearchParam(body.ref ?? '') || DEFAULT_ATLAS_REF
    const refResult = await ensureGitRef(ref)
    if (!refResult.ok) return errorResponse(refResult.message, 404)

    const commit = normalizeSearchParam(body.commit ?? '') || (await resolveRefCommit(ref))
    if (!commit) return errorResponse('Commit not found for ref.', 404)

    let pathPrefix: string | undefined
    try {
      pathPrefix = normalizePathPrefix(body.pathPrefix)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid path prefix.'
      return errorResponse(message, 400)
    }

    const maxFiles = normalizeOptionalNumber(body.maxFiles)
    if (maxFiles !== undefined && maxFiles <= 0) {
      return errorResponse('Max files must be a positive integer.', 400)
    }

    const context = normalizeOptionalText(body.context)

    return jsonResponse(
      {
        ok: true,
        status: 'queued',
        request: {
          repository: repoResult.repository,
          ref,
          commit,
          pathPrefix,
          maxFiles,
          context: context ?? undefined,
          idempotencyKey: request.headers.get('idempotency-key') ?? undefined,
        },
      },
      202,
    )
  }

  const repositoryParam = normalizeSearchParam(body.repository ?? '')
  const ref = normalizeSearchParam(body.ref ?? '') || DEFAULT_ATLAS_REF
  const path = normalizeSearchParam(body.path ?? '')
  const commitParam = normalizeSearchParam(body.commit ?? '')
  const contentHashParam = normalizeSearchParam(body.contentHash ?? '')
  const metadata = body.metadata

  if (!path) return errorResponse('path is required', 400)

  const repoResult = resolveAtlasRepository(repositoryParam)
  if (!repoResult.ok) return errorResponse(repoResult.message, 400)

  const refResult = await ensureGitRef(ref)
  if (!refResult.ok) return errorResponse(refResult.message, 404)

  const fileResult = await ensureFileAtRef(ref, path)
  if (!fileResult.ok) return errorResponse(fileResult.message, 404)

  const commit = commitParam || (await resolveCommit(ref, path))
  const contentHash = contentHashParam || (await resolveContentHash(ref, path))

  return jsonResponse(
    {
      ok: true,
      status: 'queued',
      request: {
        repository: repoResult.repository,
        ref,
        path,
        commit,
        contentHash,
        metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
        idempotencyKey: request.headers.get('idempotency-key') ?? undefined,
      },
    },
    202,
  )
}

export const postEnrichHandler = (request: Request) =>
  shouldUseLocalEnrich() ? postLocalEnrichHandler(request) : handlerRuntime.runPromise(postEnrichHandlerEffect(request))
