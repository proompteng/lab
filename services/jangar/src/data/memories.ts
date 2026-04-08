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

type JsonValue = string | number | boolean | JsonObject | JsonValue[]
type JsonObject = { [key: string]: JsonValue }

type MemoryRecordJson = Omit<MemoryRecord, 'metadata'> & { metadata: JsonObject }

export type PersistNoteResult = { ok: true; memory: MemoryRecordJson } | { ok: false; message: string }
export type RetrieveNotesResult = { ok: true; memories: MemoryRecordJson[] } | { ok: false; message: string }
export type CountMemoriesResult = { ok: true; count: number } | { ok: false; message: string }

const handlerRuntime = ManagedRuntime.make(Layer.mergeAll(MemoriesLive))

const toJsonMemoryRecord = (record: MemoryRecord): MemoryRecordJson => ({
  ...record,
  metadata: record.metadata as JsonObject,
})

export const persistNote = async (input: PersistNoteInput): Promise<PersistNoteResult> => {
  const payload = (input ?? {}) as Record<string, unknown>
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
  return { ok: true, memory: toJsonMemoryRecord(memoryResult.right) }
}

export const retrieveNotes = async (input: RetrieveNotesInput): Promise<RetrieveNotesResult> => {
  const payload = (input ?? {}) as Record<string, unknown>
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
  return { ok: true, memories: memoriesResult.right.map(toJsonMemoryRecord) }
}

export const countMemories = async (input: CountMemoriesInput = {}): Promise<CountMemoriesResult> => {
  const namespace = normalizeOptionalNamespace(input.namespace)

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
}
