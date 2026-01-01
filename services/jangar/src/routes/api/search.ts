import { createFileRoute } from '@tanstack/react-router'
import { Duration, Effect, Layer, ManagedRuntime, pipe } from 'effect'

import { Atlas, AtlasLive } from '~/server/atlas'
import { DEFAULT_REF, MAX_SEARCH_LIMIT, parseAtlasSearchInput } from '~/server/atlas-http'
import type { AtlasSearchMatch } from '~/server/atlas-store'

type AtlasSearchItem = {
  fileVersionId?: string
  repository?: string
  ref?: string
  commit?: string
  path?: string
  contentHash?: string
  updatedAt?: string
  score?: number
  summary?: string | null
  tags?: string[]
}

export const Route = createFileRoute('/api/search')({
  server: {
    handlers: {
      GET: async ({ request }) => getAtlasSearchHandler(request),
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
  const normalized = message.toLowerCase()
  if (message.includes('DATABASE_URL')) return errorResponse(message, 503)
  if (message.includes('OPENAI_API_KEY')) return errorResponse(message, 503)
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

const splitList = (values: string[]) =>
  values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

const mapMatchToItem = (match: AtlasSearchMatch): AtlasSearchItem => ({
  fileVersionId: match.fileVersion.id,
  repository: match.repository.name,
  ref: match.fileVersion.repositoryRef,
  commit: match.fileVersion.repositoryCommit ?? undefined,
  path: match.fileKey.path,
  contentHash: match.fileVersion.contentHash,
  updatedAt: match.fileVersion.updatedAt,
  score: match.enrichment.distance,
  summary: match.enrichment.summary,
  tags: match.enrichment.tags.length ? match.enrichment.tags : undefined,
})

const rankFiles = (matches: AtlasSearchMatch[], limit: number) => {
  const ranked = new Map<string, AtlasSearchItem>()

  for (const match of matches) {
    const key = match.fileVersion.id
    const next = mapMatchToItem(match)
    const existing = ranked.get(key)

    if (!existing || (typeof next.score === 'number' && (existing.score ?? Number.POSITIVE_INFINITY) > next.score)) {
      ranked.set(key, next)
      continue
    }

    if (!existing.summary && next.summary) {
      ranked.set(key, { ...existing, summary: next.summary })
    }
    if (next.tags && next.tags.length > 0) {
      const combined = new Set([...(existing.tags ?? []), ...next.tags])
      ranked.set(key, { ...existing, tags: Array.from(combined) })
    }
  }

  return Array.from(ranked.values())
    .sort((a, b) => (a.score ?? Number.POSITIVE_INFINITY) - (b.score ?? Number.POSITIVE_INFINITY))
    .slice(0, limit)
}

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

      if (parsed.value.ref && parsed.value.ref !== DEFAULT_REF) {
        return errorResponse('Atlas search is limited to the main branch.', 400)
      }

      const requestedLimit = parsed.value.limit ?? 10
      const searchLimit = Math.min(Math.max(requestedLimit * 3, requestedLimit), MAX_SEARCH_LIMIT)
      const searchInput = { ...parsed.value, ref: DEFAULT_REF, limit: searchLimit }

      const atlas = yield* Atlas

      let matches: AtlasSearchMatch[]
      try {
        matches = yield* atlas.search(searchInput)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const normalized = message.toLowerCase()
        const looksLikeTransientDbBlip =
          normalized.includes('econnrefused') ||
          normalized.includes('connection terminated unexpectedly') ||
          normalized.includes('server closed the connection unexpectedly')

        if (!looksLikeTransientDbBlip) throw error

        // Port-forwards can briefly restart (local listener down for ~1s). Retry once.
        yield* Effect.sleep(Duration.millis(750))
        matches = yield* atlas.search(searchInput)
      }
      const items = rankFiles(matches, requestedLimit)
      return jsonResponse({ ok: true, matches, items })
    }),
    Effect.catchAll((error) => Effect.succeed(resolveServiceError(error.message))),
  )

export const getAtlasSearchHandler = async (request: Request) => {
  const timeoutMs = Number.parseInt(process.env.ATLAS_SEARCH_TIMEOUT_MS ?? '25000', 10)
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 25_000

  return Promise.race([
    handlerRuntime.runPromise(getSearchHandlerEffect(request)),
    new Promise<Response>((resolve) => {
      setTimeout(() => {
        resolve(errorResponse(`atlas search timed out after ${effectiveTimeoutMs}ms`, 504))
      }, effectiveTimeoutMs)
    }),
  ])
}
