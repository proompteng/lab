import { createFileRoute } from '@tanstack/react-router'
import { Effect, Layer, ManagedRuntime, pipe } from 'effect'

import type { AtlasSearchMatch } from '~/server/atlas-store'
import { Atlas, AtlasLive } from '~/server/atlas'
import { parseAtlasSearchInput } from '~/server/atlas-http'
import {
  DEFAULT_ATLAS_REF,
  ensureGitRef,
  normalizeSearchParam,
  resolveAtlasRepository,
  resolveLimit,
  runGitCommand,
} from '~/server/git-utils'

type AtlasSearchItem = {
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

type FileSeed = {
  path: string
  score?: number
  commit?: string
  updatedAt?: string
}

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 200

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
  if (message.includes('DATABASE_URL')) return errorResponse(message, 503)
  if (message.includes('OPENAI_API_KEY')) return errorResponse(message, 503)
  return errorResponse(message, 500)
}

const splitList = (values: string[]) =>
  values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

const shouldUseLocalSearch = () => process.env.ATLAS_LOCAL_MODE === 'true' || !process.env.DATABASE_URL

const mapMatchToItem = (match: AtlasSearchMatch): AtlasSearchItem => ({
  repository: match.repository.name,
  ref: match.fileVersion.repositoryRef,
  commit: match.fileVersion.repositoryCommit,
  path: match.fileKey.path,
  contentHash: match.fileVersion.contentHash,
  updatedAt: match.fileVersion.updatedAt,
  score: match.enrichment.distance,
  summary: match.enrichment.summary,
  tags: match.enrichment.tags.length ? match.enrichment.tags : undefined,
})

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
      const items = matches.map(mapMatchToItem)
      return jsonResponse({ ok: true, matches, items })
    }),
    Effect.catchAll((error) => Effect.succeed(resolveServiceError(error.message))),
  )

const parseCommitLine = (line: string) => {
  const trimmed = line.trim()
  if (!trimmed) return null
  const dividerIndex = trimmed.indexOf('|')
  if (dividerIndex < 7) return null
  const commit = trimmed.slice(0, dividerIndex)
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return null
  const updatedAt = trimmed.slice(dividerIndex + 1).trim()
  if (!updatedAt) return null
  return { commit, updatedAt }
}

const resolveContentHash = async (ref: string, path: string) => {
  const result = await runGitCommand(['rev-parse', `${ref}:${path}`])
  if (result.exitCode !== 0) return undefined
  const hash = result.stdout.trim()
  return hash || undefined
}

const resolveFileMetadata = async (ref: string, seed: FileSeed) => {
  let commit = seed.commit
  let updatedAt = seed.updatedAt

  if (!commit || !updatedAt) {
    const logResult = await runGitCommand(['log', '-1', '--format=%H|%cI', ref, '--', seed.path])
    if (logResult.exitCode === 0) {
      const parsed = parseCommitLine(logResult.stdout.split('\n')[0] ?? '')
      if (parsed) {
        commit = parsed.commit
        updatedAt = parsed.updatedAt
      }
    }
  }

  const contentHash = await resolveContentHash(ref, seed.path)

  return {
    commit,
    updatedAt,
    contentHash,
  }
}

const buildItems = async (ref: string, repository: string, seeds: FileSeed[]) => {
  const items: AtlasSearchItem[] = []
  for (const seed of seeds) {
    const metadata = await resolveFileMetadata(ref, seed)
    items.push({
      repository,
      ref,
      path: seed.path,
      score: seed.score,
      commit: metadata.commit,
      updatedAt: metadata.updatedAt,
      contentHash: metadata.contentHash,
    })
  }
  return items
}

const listRecentFiles = async (ref: string, pathPrefix: string, limit: number) => {
  const maxCommits = Math.max(limit, 25)
  const args = ['log', `-${maxCommits}`, '--name-only', '--pretty=format:%H|%cI', ref]
  if (pathPrefix) args.push('--', pathPrefix)

  const result = await runGitCommand(args)
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
    throw new Error(detail || 'git log failed')
  }

  const entries = new Map<string, { commit: string; updatedAt: string }>()
  let currentCommit: string | null = null
  let currentDate: string | null = null

  for (const line of result.stdout.split('\n')) {
    const parsed = parseCommitLine(line)
    if (parsed) {
      currentCommit = parsed.commit
      currentDate = parsed.updatedAt
      continue
    }

    const path = line.trim()
    if (!path) continue
    if (!currentCommit || !currentDate) continue
    if (entries.has(path)) continue

    entries.set(path, { commit: currentCommit, updatedAt: currentDate })
    if (entries.size >= limit) break
  }

  const seeds: FileSeed[] = []
  for (const [path, meta] of entries) {
    seeds.push({ path, commit: meta.commit, updatedAt: meta.updatedAt })
  }

  return seeds
}

const searchFiles = async (ref: string, query: string, pathPrefix: string, limit: number) => {
  const args = ['grep', '-n', '--full-name', '-I', '-F', query, ref]
  if (pathPrefix) args.push('--', pathPrefix)

  const result = await runGitCommand(args)
  if (result.exitCode === 1) return []
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
    throw new Error(detail || 'git grep failed')
  }

  const seen = new Set<string>()
  const seeds: FileSeed[] = []
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const segments = trimmed.split(':')
    if (segments.length < 2) continue
    const firstSegment = segments[0]
    const path = firstSegment === ref && segments.length >= 2 ? segments[1] : firstSegment
    if (!path || seen.has(path)) continue
    seen.add(path)
    const score = Math.max(0, 1 - seeds.length * 0.001)
    seeds.push({ path, score })
    if (seeds.length >= limit) break
  }

  return seeds
}

const getLocalSearchHandler = async (request: Request) => {
  const url = new URL(request.url)
  const repositoryParam = normalizeSearchParam(url.searchParams.get('repository'))
  const ref = normalizeSearchParam(url.searchParams.get('ref')) || DEFAULT_ATLAS_REF
  const query = normalizeSearchParam(url.searchParams.get('query'))
  const pathPrefix = normalizeSearchParam(url.searchParams.get('pathPrefix'))
  const limit = resolveLimit(normalizeSearchParam(url.searchParams.get('limit')), DEFAULT_LIMIT, MAX_LIMIT)

  const repoResult = resolveAtlasRepository(repositoryParam)
  if (!repoResult.ok) return errorResponse(repoResult.message, 400)

  const refResult = await ensureGitRef(ref)
  if (!refResult.ok) return errorResponse(refResult.message, 404)

  try {
    const seeds = query
      ? await searchFiles(ref, query, pathPrefix, limit)
      : await listRecentFiles(ref, pathPrefix, limit)
    const items = await buildItems(ref, repoResult.repository, seeds)
    return jsonResponse({ ok: true, items, matches: [] })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500)
  }
}

export const getAtlasSearchHandler = async (request: Request) => {
  const url = new URL(request.url)
  const query = normalizeSearchParam(url.searchParams.get('query'))

  if (!query || shouldUseLocalSearch()) {
    return getLocalSearchHandler(request)
  }

  return handlerRuntime.runPromise(getSearchHandlerEffect(request))
}
