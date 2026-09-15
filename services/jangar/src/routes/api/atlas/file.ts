import { createHash } from 'node:crypto'

import { createFileRoute } from '@tanstack/react-router'
import { Effect, Layer, ManagedRuntime, pipe } from 'effect'

import { Atlas, AtlasLive } from '~/server/atlas'
import {
  DEFAULT_ATLAS_REF,
  ensureAtlasCommitAvailable,
  normalizeSearchParam,
  resolveAtlasRepository,
  runGitCommand,
} from '~/server/git-utils'

const MAX_PREVIEW_CHARS = 120_000
const handlerRuntime = ManagedRuntime.make(Layer.mergeAll(AtlasLive))

export const Route = createFileRoute('/api/atlas/file')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getAtlasFileHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
    },
  },
})

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
  const normalized = message.toLowerCase()
  if (normalized.includes('does not exist in') || (normalized.includes('path') && normalized.includes('fatal'))) {
    return errorResponse('File not found at the indexed commit.', 404)
  }
  if (normalized.includes('not ready') || normalized.includes('hash mismatch')) return errorResponse(message, 503)
  if (
    normalized.includes('econnrefused') ||
    normalized.includes('connection terminated unexpectedly') ||
    normalized.includes('server closed the connection unexpectedly') ||
    normalized.includes('terminating connection')
  ) {
    return errorResponse(message, 503)
  }
  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return errorResponse(message, 504)
  }
  return errorResponse(message, 500)
}

const readFileAtRef = async (ref: string, path: string) => {
  const result = await runGitCommand(['show', `${ref}:${path}`])
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
    throw new Error(detail || 'git show failed')
  }
  return result.stdout
}

const getAtlasFileHandlerEffect = (request: Request) =>
  pipe(
    Effect.gen(function* () {
      const url = new URL(request.url)
      const repository = normalizeSearchParam(url.searchParams.get('repository'))
      const ref = normalizeSearchParam(url.searchParams.get('ref')) || DEFAULT_ATLAS_REF
      const path = normalizeSearchParam(url.searchParams.get('path'))

      if (!path) return errorResponse('Path is required.', 400)
      if (ref !== DEFAULT_ATLAS_REF) {
        return errorResponse('Atlas file previews are limited to the main branch.', 400)
      }

      const repoResult = resolveAtlasRepository(repository)
      if (!repoResult.ok) return errorResponse(repoResult.message, 400)

      const atlas = yield* Atlas
      const health = yield* atlas.codeSearchHealth({ repository: repoResult.repository, ref })
      if (health.status !== 'ok' || !health.indexedCommit) {
        return errorResponse(`Atlas code search is not ready: ${health.message}`, 503)
      }
      const indexedRepository = yield* atlas.getRepositoryByName({ name: repoResult.repository })
      if (!indexedRepository) return errorResponse('Atlas repository is not indexed.', 404)
      const fileKey = yield* atlas.getFileKeyByPath({ repositoryId: indexedRepository.id, path })
      if (!fileKey) return errorResponse('File not found at the indexed commit.', 404)
      const fileVersion = yield* atlas.getFileVersionByKey({
        fileKeyId: fileKey.id,
        repositoryRef: ref,
        repositoryCommit: health.indexedCommit,
      })
      if (!fileVersion) return errorResponse('File not found at the indexed commit.', 404)

      const available = yield* Effect.promise(() => ensureAtlasCommitAvailable(health.indexedCommit!))
      if (!available.ok) throw new Error(available.message)

      const content = yield* Effect.tryPromise({
        try: () => readFileAtRef(health.indexedCommit!, path),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
      const contentHash = createHash('sha256').update(content).digest('hex')
      if (contentHash !== fileVersion.contentHash) {
        throw new Error(
          `Atlas source preview hash mismatch for ${path}: indexed=${fileVersion.contentHash}, git=${contentHash}`,
        )
      }
      const truncated = content.length > MAX_PREVIEW_CHARS
      const preview = truncated ? content.slice(0, MAX_PREVIEW_CHARS) : content

      return jsonResponse({
        ok: true,
        repository: repoResult.repository,
        ref,
        commit: health.indexedCommit,
        contentHash,
        path,
        truncated,
        content: preview,
      })
    }),
    Effect.catchAll((error) => Effect.succeed(resolveServiceError(error.message))),
  )

export const getAtlasFileHandler = async (request: Request) =>
  handlerRuntime.runPromise(getAtlasFileHandlerEffect(request))
