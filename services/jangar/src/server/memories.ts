import { Context, Effect, Layer, pipe } from 'effect'

import {
  createPostgresMemoriesStore,
  type MemoriesStats,
  type MemoriesStatsInput,
  type MemoryRecord,
  type PersistMemoryInput,
  type RetrieveMemoryInput,
} from './memories-store'

export type MemoriesService = {
  persist: (input: PersistMemoryInput) => Effect.Effect<MemoryRecord, Error>
  retrieve: (input: RetrieveMemoryInput) => Effect.Effect<MemoryRecord[], Error>
  count: (input?: { namespace?: string }) => Effect.Effect<number, Error>
  stats: (input?: MemoriesStatsInput) => Effect.Effect<MemoriesStats, Error>
}

export class Memories extends Context.Tag('Memories')<Memories, MemoriesService>() {}

const normalizeError = (message: string, error: unknown) =>
  new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`)

export const MemoriesLive = Layer.scoped(
  Memories,
  Effect.gen(function* () {
    let store: ReturnType<typeof createPostgresMemoriesStore> | null = null

    const getStore = () =>
      Effect.try({
        try: () => {
          if (!store) store = createPostgresMemoriesStore()
          return store
        },
        catch: (error) => normalizeError('memories store unavailable', error),
      })

    yield* Effect.addFinalizer(() => {
      const currentStore = store
      if (!currentStore) return Effect.void
      return pipe(
        Effect.tryPromise({
          try: () => currentStore.close(),
          catch: (error) => normalizeError('close memories store', error),
        }),
        Effect.catchAll((error) => {
          console.warn('[mcp] failed to close memories store', { error: String(error) })
          return Effect.void
        }),
      )
    })

    const service: MemoriesService = {
      persist: (input) =>
        pipe(
          getStore(),
          Effect.flatMap((resolved) =>
            Effect.tryPromise({
              try: () => resolved.persist(input),
              catch: (error) => normalizeError('persist memory failed', error),
            }),
          ),
        ),
      retrieve: (input) =>
        pipe(
          getStore(),
          Effect.flatMap((resolved) =>
            Effect.tryPromise({
              try: () => resolved.retrieve(input),
              catch: (error) => normalizeError('retrieve memories failed', error),
            }),
          ),
        ),
      count: (input) =>
        pipe(
          getStore(),
          Effect.flatMap((resolved) =>
            Effect.tryPromise({
              try: () => resolved.count(input),
              catch: (error) => normalizeError('count memories failed', error),
            }),
          ),
        ),
      stats: (input) =>
        pipe(
          getStore(),
          Effect.flatMap((resolved) =>
            Effect.tryPromise({
              try: () => resolved.stats(input),
              catch: (error) => normalizeError('memories stats failed', error),
            }),
          ),
        ),
    }

    return service
  }),
)
