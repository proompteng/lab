import { Effect, Ref } from 'effect'

import type { WorkflowDeterminismState } from '../workflow/determinism'

export interface StickyCacheKey {
  readonly namespace: string
  readonly workflowId: string
  readonly runId: string
}

export interface StickyCacheEntry {
  readonly key: StickyCacheKey
  readonly determinismState: WorkflowDeterminismState
  readonly lastAccessed: number
}

export interface StickyCacheConfig {
  readonly maxEntries: number
  readonly ttlMs: number
}

export interface StickyCache {
  readonly upsert: (entry: StickyCacheEntry) => Effect.Effect<void, never, never>
  readonly get: (key: StickyCacheKey) => Effect.Effect<StickyCacheEntry | undefined, never, never>
  readonly remove: (key: StickyCacheKey) => Effect.Effect<void, never, never>
  readonly size: Effect.Effect<number, never, never>
}

export const makeStickyCache = (config: StickyCacheConfig): Effect.Effect<StickyCache, never, never> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<StickyCacheEntry[]>([])

    const evictExpired = (now: number, entries: StickyCacheEntry[]): StickyCacheEntry[] => {
      if (config.ttlMs <= 0) {
        return entries
      }
      return entries.filter((entry) => now - entry.lastAccessed <= config.ttlMs)
    }

    const evictOverflow = (entries: StickyCacheEntry[]): StickyCacheEntry[] => {
      if (config.maxEntries <= 0) {
        return []
      }
      if (entries.length <= config.maxEntries) {
        return entries
      }
      return entries
        .slice()
        .sort((left, right) => left.lastAccessed - right.lastAccessed)
        .slice(entries.length - config.maxEntries)
    }

    const touch = (entry: StickyCacheEntry): StickyCacheEntry => ({
      ...entry,
      lastAccessed: Date.now(),
    })

    // TODO(TBS-001): Replace naive eviction with configurable strategy (LRU, LFU)
    // and expose metrics describing cache churn.

    const upsert: StickyCache['upsert'] = (entry) =>
      Ref.update(state, (entries) => {
        const now = Date.now()
        const sanitized = evictOverflow(evictExpired(now, entries))
        const filtered = sanitized.filter(
          (candidate) =>
            candidate.key.namespace !== entry.key.namespace ||
            candidate.key.workflowId !== entry.key.workflowId ||
            candidate.key.runId !== entry.key.runId,
        )
        const nextEntries = [...filtered, touch(entry)]
        return evictOverflow(nextEntries)
      })

    const get: StickyCache['get'] = (key) =>
      Ref.modify(state, (entries) => {
        const now = Date.now()
        const sanitized = evictExpired(now, entries)
        const found = sanitized.find(
          (entry) =>
            entry.key.namespace === key.namespace &&
            entry.key.workflowId === key.workflowId &&
            entry.key.runId === key.runId,
        )
        const updated = found ? sanitized.map((entry) => (entry === found ? touch(entry) : entry)) : sanitized
        return [found, updated] as const
      })

    const remove: StickyCache['remove'] = (key) =>
      Ref.update(state, (entries) =>
        entries.filter(
          (entry) =>
            entry.key.namespace !== key.namespace ||
            entry.key.workflowId !== key.workflowId ||
            entry.key.runId !== key.runId,
        ),
      )

    const size = Ref.get(state).pipe(Effect.map((entries) => entries.length))

    return {
      upsert,
      get,
      remove,
      size,
    }
  })
