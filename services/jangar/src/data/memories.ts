import { createServerFn } from '@tanstack/react-start'
import { Effect, Layer, ManagedRuntime } from 'effect'

import { Memories, MemoriesLive } from '../server/memories'
import type { MemoryRecord } from '../server/memories-store'

export type PersistNoteInput = {
  namespace?: string
  content: string
  summary?: string
  tags?: string[]
}

export type RetrieveNotesInput = {
  namespace?: string
  query: string
  limit?: number
}

export type PersistNoteResult = { ok: true; memory: MemoryRecord } | { ok: false; message: string }
export type RetrieveNotesResult = { ok: true; memories: MemoryRecord[] } | { ok: false; message: string }

const DEFAULT_NAMESPACE = 'default'
const DEFAULT_LIMIT = 10

const MAX_CONTENT_CHARS = 50_000
const MAX_QUERY_CHARS = 10_000
const MAX_SUMMARY_CHARS = 5_000
const MAX_NAMESPACE_CHARS = 200
const MAX_TAGS = 50

const handlerRuntime = ManagedRuntime.make(Layer.mergeAll(MemoriesLive))

const normalizeNamespace = (namespace: unknown) => {
  const raw = typeof namespace === 'string' ? namespace.trim() : ''
  const resolved = raw.length > 0 ? raw : DEFAULT_NAMESPACE
  return resolved.slice(0, MAX_NAMESPACE_CHARS)
}

const normalizeTags = (tags: unknown): string[] => {
  if (!Array.isArray(tags)) return []
  return tags
    .filter((tag) => typeof tag === 'string')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .slice(0, MAX_TAGS)
}

const persistNoteServer = createServerFn({ method: 'POST' })
  .inputValidator((input) => (input ?? {}) as PersistNoteInput)
  .handler(async ({ data }): Promise<PersistNoteResult> => {
    const payload = data as Partial<PersistNoteInput>
    const content = typeof payload.content === 'string' ? payload.content.trim() : ''
    if (!content) return { ok: false, message: 'Content is required.' }
    if (content.length > MAX_CONTENT_CHARS) {
      return { ok: false, message: `Content is too large (max ${MAX_CONTENT_CHARS} chars).` }
    }

    const summary = typeof payload.summary === 'string' ? payload.summary.trim() : null
    if (summary && summary.length > MAX_SUMMARY_CHARS) {
      return { ok: false, message: `Summary is too large (max ${MAX_SUMMARY_CHARS} chars).` }
    }

    const namespace = normalizeNamespace(payload.namespace)
    const tags = normalizeTags(payload.tags)

    const memoryResult = await handlerRuntime.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const service = yield* Memories
          return yield* service.persist({ namespace, content, summary, tags })
        }),
      ),
    )

    if (memoryResult._tag === 'Left') return { ok: false, message: memoryResult.left.message }
    return { ok: true, memory: memoryResult.right }
  })

const retrieveNotesServer = createServerFn({ method: 'POST' })
  .inputValidator((input) => (input ?? {}) as RetrieveNotesInput)
  .handler(async ({ data }): Promise<RetrieveNotesResult> => {
    const payload = data as Partial<RetrieveNotesInput>
    const query = typeof payload.query === 'string' ? payload.query.trim() : ''
    if (!query) return { ok: false, message: 'Query is required.' }
    if (query.length > MAX_QUERY_CHARS) {
      return { ok: false, message: `Query is too large (max ${MAX_QUERY_CHARS} chars).` }
    }

    const namespace = normalizeNamespace(payload.namespace)
    const limit =
      typeof payload.limit === 'number' && Number.isFinite(payload.limit) ? Math.floor(payload.limit) : DEFAULT_LIMIT

    const clampedLimit = Math.max(1, Math.min(50, limit))

    const memoriesResult = await handlerRuntime.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const service = yield* Memories
          return yield* service.retrieve({ namespace, query, limit: clampedLimit })
        }),
      ),
    )

    if (memoriesResult._tag === 'Left') return { ok: false, message: memoriesResult.left.message }
    return { ok: true, memories: memoriesResult.right }
  })

export const serverFns = {
  persistNote: persistNoteServer,
  retrieveNotes: retrieveNotesServer,
}
