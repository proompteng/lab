import { Effect, Ref } from 'effect'

import type { Counter } from '../observability/metrics'
import type { ActivityResolution, NexusOperationResolution } from '../workflow/context'
import type { WorkflowDeterminismState } from '../workflow/determinism'

export interface StickyCacheKey {
  readonly namespace: string
  readonly workflowId: string
  readonly runId: string
}

export interface StickyCacheEntry {
  readonly key: StickyCacheKey
  readonly determinismState: WorkflowDeterminismState
  readonly lastEventId: string | null
  readonly lastAccessed: number
  readonly workflowArguments?: unknown[]
  readonly activityResults?: Map<string, ActivityResolution>
  readonly activityScheduleEventIds?: Map<string, string>
  readonly nexusResults?: Map<string, NexusOperationResolution>
  readonly nexusScheduleEventIds?: Map<string, string>
  readonly timerResults?: ReadonlySet<string>
  readonly workflowType?: string
  readonly workflowTaskCount?: number
  readonly lastDeterminismMarkerHash?: string
  readonly lastDeterminismMarkerTask?: number
  readonly lastDeterminismFullSnapshotTask?: number
  readonly lastDeterminismMarkerState?: WorkflowDeterminismState
}

export interface StickyCacheConfig {
  readonly maxEntries: number
  readonly ttlMs: number
  readonly metrics?: StickyCacheMetrics
  readonly hooks?: StickyCacheHooks
}

export interface StickyCache {
  readonly upsert: (entry: StickyCacheEntry) => Effect.Effect<void, never, never>
  readonly get: (key: StickyCacheKey) => Effect.Effect<StickyCacheEntry | undefined, never, never>
  readonly remove: (key: StickyCacheKey) => Effect.Effect<void, never, never>
  readonly removeByWorkflow: (workflow: { namespace: string; workflowId: string }) => Effect.Effect<void, never, never>
  readonly clear: Effect.Effect<void, never, never>
  readonly size: Effect.Effect<number, never, never>
}

export interface StickyCacheMetrics {
  readonly hits?: Counter
  readonly misses?: Counter
  readonly evictions?: Counter
  readonly ttlExpirations?: Counter
}

export type StickyCacheEvictionReason = 'lru' | 'ttl' | 'manual'

export interface StickyCacheHooks {
  readonly onHit?: (entry: StickyCacheEntry) => Effect.Effect<void, never, never>
  readonly onMiss?: (key: StickyCacheKey) => Effect.Effect<void, never, never>
  readonly onEvict?: (entry: StickyCacheEntry, reason: StickyCacheEvictionReason) => Effect.Effect<void, never, never>
}

type StickyCacheLookupResult =
  | { readonly kind: 'miss' }
  | { readonly kind: 'expired'; readonly entry: StickyCacheEntry }
  | { readonly kind: 'hit'; readonly entry: StickyCacheEntry }

const serializeKey = (key: StickyCacheKey): string => JSON.stringify([key.namespace, key.workflowId, key.runId])

const recordCounter = (counter?: Counter, value = 1) => (counter ? counter.inc(value) : Effect.void)

export const makeStickyCache = (config: StickyCacheConfig): Effect.Effect<StickyCache, never, never> => {
  if (config.maxEntries <= 0) {
    return Effect.succeed(makeDisabledStickyCache())
  }
  return Effect.gen(function* () {
    const state = yield* Ref.make(new Map<string, StickyCacheEntry>())
    const ttlMs = config.ttlMs > 0 ? config.ttlMs : 0
    const metrics = config.metrics
    const hooks = config.hooks
    const maxEntries = Math.max(0, config.maxEntries)

    const recordHit = () => recordCounter(metrics?.hits)
    const recordMiss = () => recordCounter(metrics?.misses)
    const recordEviction = (entry: StickyCacheEntry, reason: StickyCacheEvictionReason) =>
      Effect.gen(function* () {
        if (reason === 'ttl') {
          yield* recordCounter(metrics?.ttlExpirations)
        }
        if (reason === 'lru' || reason === 'ttl') {
          yield* recordCounter(metrics?.evictions)
        }
        const onEvictHook = hooks?.onEvict
        if (onEvictHook) {
          yield* onEvictHook(entry, reason)
        }
      })

    const upsert: StickyCache['upsert'] = (entry) =>
      Effect.gen(function* () {
        const now = Date.now()
        const evicted = yield* Ref.modify(state, (map) => {
          const next = new Map(map)
          const id = serializeKey(entry.key)
          const normalized: StickyCacheEntry = {
            ...entry,
            lastAccessed: now,
          }
          next.delete(id)
          next.set(id, normalized)

          const evictedEntries: StickyCacheEntry[] = []
          while (maxEntries > 0 && next.size > maxEntries) {
            const oldestKey = next.keys().next().value as string | undefined
            if (!oldestKey) {
              break
            }
            const oldest = next.get(oldestKey)
            if (!oldest) {
              break
            }
            next.delete(oldestKey)
            evictedEntries.push(oldest)
          }

          return [evictedEntries, next] as const
        })

        for (const evictedEntry of evicted) {
          yield* recordEviction(evictedEntry, 'lru')
        }
      })

    const get: StickyCache['get'] = (key) =>
      Effect.gen(function* () {
        const now = Date.now()
        const result = yield* Ref.modify(
          state,
          (map): readonly [StickyCacheLookupResult, Map<string, StickyCacheEntry>] => {
            const next = new Map(map)
            const id = serializeKey(key)
            const existing = next.get(id)
            if (!existing) {
              return [{ kind: 'miss' }, map]
            }
            if (ttlMs > 0 && now - existing.lastAccessed > ttlMs) {
              next.delete(id)
              return [{ kind: 'expired', entry: existing }, next]
            }
            const updated = { ...existing, lastAccessed: now }
            next.delete(id)
            next.set(id, updated)
            return [{ kind: 'hit', entry: updated }, next]
          },
        )

        if (result.kind === 'hit') {
          yield* recordHit()
          if (hooks?.onHit) {
            yield* hooks.onHit(result.entry)
          }
          return result.entry
        }

        if (result.kind === 'expired') {
          yield* recordEviction(result.entry, 'ttl')
          yield* recordMiss()
          if (hooks?.onMiss) {
            yield* hooks.onMiss(key)
          }
          return undefined
        }

        // miss
        yield* recordMiss()
        if (hooks?.onMiss) {
          yield* hooks.onMiss(key)
        }
        return undefined
      })

    const remove: StickyCache['remove'] = (key) =>
      Effect.gen(function* () {
        const removed = yield* Ref.modify(state, (map) => {
          const next = new Map(map)
          const id = serializeKey(key)
          const existing = next.get(id)
          if (existing) {
            next.delete(id)
          }
          return [existing, next] as const
        })

        if (removed) {
          yield* recordEviction(removed, 'manual')
        }
      })

    const removeByWorkflow: StickyCache['removeByWorkflow'] = (workflow) =>
      Effect.gen(function* () {
        const removed = yield* Ref.modify(state, (map) => {
          const next = new Map(map)
          const evicted: StickyCacheEntry[] = []

          for (const [id, entry] of next) {
            if (entry.key.namespace === workflow.namespace && entry.key.workflowId === workflow.workflowId) {
              next.delete(id)
              evicted.push(entry)
            }
          }

          return [evicted, next] as const
        })

        for (const entry of removed) {
          yield* recordEviction(entry, 'manual')
        }
      })

    const clear = Ref.modify(state, (map) => {
      const next = new Map<string, StickyCacheEntry>()
      return [map, next] as const
    }).pipe(
      Effect.flatMap((previous) =>
        Effect.all(
          Array.from(previous.values()).map((entry) => recordEviction(entry, 'manual')),
          {
            discard: true,
          },
        ),
      ),
    )

    const size = Ref.get(state).pipe(Effect.map((map) => map.size))

    return {
      upsert,
      get,
      remove,
      removeByWorkflow,
      clear,
      size,
    }
  })
}

const makeDisabledStickyCache = (): StickyCache => ({
  upsert: () => Effect.void,
  get: () => Effect.succeed(undefined),
  remove: () => Effect.void,
  removeByWorkflow: () => Effect.void,
  clear: Effect.void,
  size: Effect.succeed(0),
})
