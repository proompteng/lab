import { postAgentsJsonEffect, runAgentsJsonPromise, type EnvSource } from './agents-http'
import { parseRetrieveMemoryNotesInput } from './memory-client'
import { clampUtf8 } from './swarm-analysis'

export type RepoContextInput = {
  query: string
  repository?: string
  expectedCommit?: string
  pathPrefix?: string
  tags?: string[]
  limit?: number
  maxBytes?: number
}
export type ResolvedRepoContextInput = RepoContextInput &
  Required<Pick<RepoContextInput, 'repository' | 'limit' | 'maxBytes'>>

export type ContextCodeHit = {
  path: string
  startLine: number | null
  endLine: number | null
  commit: string
  contentHash: string
  excerpt: string
  truncated: boolean
}

export type ContextMemoryHit = {
  id: string
  namespace: string
  summary: string
  excerpt: string
  truncated: boolean
  createdAt: string
  commit: string | null
  model: string | null
}

export type ContextSource<T> =
  | { state: 'ready'; items: T[]; omitted: number }
  | { state: 'unavailable' | 'stale' | 'degraded'; message: string; items: [] }

export type RepoContextResponse = {
  ok: true
  repository: string
  expectedCommit: string | null
  indexedCommit: string | null
  snapshotVerified: boolean
  code: ContextSource<ContextCodeHit>
  memory: ContextSource<ContextMemoryHit>
  maxBytes: number
}

export const fitRepoContext = (
  result: RepoContextResponse,
  maxBytes: number,
  measure = (value: RepoContextResponse) => new TextEncoder().encode(JSON.stringify(value)).byteLength,
) => {
  while (measure(result) > maxBytes) {
    const sources = [result.code, result.memory].filter((source) => source.state === 'ready' && source.items.length > 0)
    sources.sort((left, right) => right.items.length - left.items.length)
    let source = sources.find((candidate) => candidate.items.length > 1)
    if (!source) {
      let longest: { excerpt: string; truncated: boolean } | undefined
      let longestBytes = 128
      for (const candidate of sources) {
        for (const item of candidate.items) {
          const bytes = new TextEncoder().encode(item.excerpt).byteLength
          if (bytes > longestBytes) {
            longest = item
            longestBytes = bytes
          }
        }
      }
      if (longest) {
        longest.excerpt = clampUtf8(longest.excerpt, Math.floor(longestBytes / 2)).value
        longest.truncated = true
        continue
      }
      source = sources[0]
    }
    if (!source || source.state !== 'ready') throw new Error('Context metadata exceeds the output budget.')
    source.items.pop()
    source.omitted++
  }
  return result
}

export const parseRepoContextInput = (payload: Record<string, unknown>) => {
  const parsed = parseRetrieveMemoryNotesInput(payload, 3)
  if (!parsed.ok) return parsed
  if (
    (payload.expectedCommit !== undefined && typeof payload.expectedCommit !== 'string') ||
    (payload.pathPrefix !== undefined && typeof payload.pathPrefix !== 'string')
  ) {
    return { ok: false as const, message: 'expectedCommit and pathPrefix must be strings.' }
  }
  const expectedCommit = typeof payload.expectedCommit === 'string' ? payload.expectedCommit.toLowerCase() : undefined
  if (expectedCommit !== undefined && !/^[0-9a-f]{40}$/.test(expectedCommit)) {
    return { ok: false as const, message: 'expectedCommit must be a full Git commit SHA.' }
  }
  const pathPrefix = typeof payload.pathPrefix === 'string' ? payload.pathPrefix.trim() : undefined
  if (pathPrefix && (pathPrefix.startsWith('/') || pathPrefix.split('/').includes('..') || pathPrefix.length > 1_024)) {
    return { ok: false as const, message: 'pathPrefix must be a repository-relative path prefix.' }
  }
  const limit = parsed.value.limit ?? 3
  if (parsed.value.repository && parsed.value.repository.length > 200)
    return { ok: false as const, message: 'repository must contain at most 200 characters.' }
  if (limit > 10) return { ok: false as const, message: 'limit must be between 1 and 10 per source.' }
  const maxBytes = payload.maxBytes === undefined ? 20_000 : Number(payload.maxBytes)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4_096 || maxBytes > 64_000) {
    return { ok: false as const, message: 'maxBytes must be between 4096 and 64000.' }
  }
  const value: ResolvedRepoContextInput = {
    query: parsed.value.query,
    repository: parsed.value.repository ?? 'proompteng/lab',
    tags: parsed.value.tags,
    expectedCommit,
    pathPrefix,
    limit,
    maxBytes,
  }
  return { ok: true as const, value }
}

export const retrieveRepoContextFromAgentsService = (input: RepoContextInput, env: EnvSource = process.env) =>
  runAgentsJsonPromise(
    postAgentsJsonEffect<RepoContextResponse>('/v1/context', input, { env, signal: AbortSignal.timeout(35_000) }),
  )
