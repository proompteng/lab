import { createServerFn } from '@tanstack/react-start'
import { Effect, Layer, ManagedRuntime } from 'effect'

import { Memories, MemoriesLive } from '../server/memories'
import { normalizeOptionalNamespace, parsePersistMemoryInput, parseRetrieveMemoryInput } from '../server/memories-http'
import type { MemoryRecord } from '../server/memories-store'

export type PersistNoteInput = {
  namespace?: string
  content: string
  summary?: string
  tags?: string[]
  metadata?: Record<string, unknown>
}

export type RetrieveNotesInput = {
  namespace?: string
  query: string
  limit?: number
}

export type CountMemoriesInput = {
  namespace?: string
}

export type PersistNoteResult = { ok: true; memory: MemoryRecord } | { ok: false; message: string }
export type RetrieveNotesResult = { ok: true; memories: MemoryRecord[] } | { ok: false; message: string }
export type CountMemoriesResult = { ok: true; count: number } | { ok: false; message: string }

const handlerRuntime = ManagedRuntime.make(Layer.mergeAll(MemoriesLive))

const persistNoteServer = createServerFn({ method: 'POST' })
  .inputValidator((input) => (input ?? {}) as PersistNoteInput)
  .handler(async ({ data }): Promise<PersistNoteResult> => {
    const payload = data as Record<string, unknown>
    const parsed = parsePersistMemoryInput(payload)
    if (!parsed.ok) return { ok: false, message: parsed.message }

    const memoryResult = await handlerRuntime.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const service = yield* Memories
          return yield* service.persist(parsed.value)
        }),
      ),
    )

    if (memoryResult._tag === 'Left') return { ok: false, message: memoryResult.left.message }
    return { ok: true, memory: memoryResult.right }
  })

const retrieveNotesServer = createServerFn({ method: 'POST' })
  .inputValidator((input) => (input ?? {}) as RetrieveNotesInput)
  .handler(async ({ data }): Promise<RetrieveNotesResult> => {
    const payload = data as Record<string, unknown>
    const parsed = parseRetrieveMemoryInput(payload)
    if (!parsed.ok) return { ok: false, message: parsed.message }

    const memoriesResult = await handlerRuntime.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const service = yield* Memories
          return yield* service.retrieve(parsed.value)
        }),
      ),
    )

    if (memoriesResult._tag === 'Left') return { ok: false, message: memoriesResult.left.message }
    return { ok: true, memories: memoriesResult.right }
  })

const countMemoriesServer = createServerFn({ method: 'POST' })
  .inputValidator((input) => (input ?? {}) as CountMemoriesInput)
  .handler(async ({ data }): Promise<CountMemoriesResult> => {
    const payload = data as Partial<CountMemoriesInput>
    const namespace = normalizeOptionalNamespace(payload.namespace)

    const countResult = await handlerRuntime.runPromise(
      Effect.either(
        Effect.gen(function* () {
          const service = yield* Memories
          return yield* service.count({ namespace })
        }),
      ),
    )

    if (countResult._tag === 'Left') return { ok: false, message: countResult.left.message }
    return { ok: true, count: countResult.right }
  })

export const serverFns = {
  persistNote: persistNoteServer,
  retrieveNotes: retrieveNotesServer,
  countMemories: countMemoriesServer,
}
