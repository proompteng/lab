import { expect, test } from 'bun:test'
import { Effect } from 'effect'

import { makeStickyCache } from '../src/worker/sticky-cache'
import type { WorkflowDeterminismState } from '../src/workflow/determinism'

const EMPTY_STATE: WorkflowDeterminismState = {
  commandHistory: [],
  randomValues: [],
  timeValues: [],
}

const makeFakeCounter = () => {
  let value = 0
  return {
    counter: {
      inc: (delta = 1) =>
        Effect.sync(() => {
          value += delta
        }),
    },
    read: () => value,
  }
}

test('sticky cache evicts least-recently-used entries when capacity exceeded', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const cache = yield* makeStickyCache({ maxEntries: 2, ttlMs: 10_000 })
      const keyOne = { namespace: 'default', workflowId: 'wf-1', runId: 'run-1' }
      const keyTwo = { namespace: 'default', workflowId: 'wf-2', runId: 'run-2' }
      const keyThree = { namespace: 'default', workflowId: 'wf-3', runId: 'run-3' }

      yield* cache.upsert({
        key: keyOne,
        determinismState: EMPTY_STATE,
        lastEventId: '1',
        lastAccessed: Date.now(),
      })
      yield* Effect.sleep('2 millis')
      yield* cache.upsert({
        key: keyTwo,
        determinismState: EMPTY_STATE,
        lastEventId: '2',
        lastAccessed: Date.now(),
      })
      yield* Effect.sleep('2 millis')
      yield* cache.upsert({
        key: keyThree,
        determinismState: EMPTY_STATE,
        lastEventId: '3',
        lastAccessed: Date.now(),
      })

      const cachedOne = yield* cache.get(keyOne)
      const cachedTwo = yield* cache.get(keyTwo)
      const cachedThree = yield* cache.get(keyThree)
      const size = yield* cache.size

      expect(cachedOne).toBeUndefined()
      expect(cachedTwo?.determinismState).toBeDefined()
      expect(cachedThree?.determinismState).toBeDefined()
      expect(size).toBe(2)
    }),
  )
})

test('sticky cache expires entries after ttl', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const cache = yield* makeStickyCache({ maxEntries: 4, ttlMs: 5 })
      const key = { namespace: 'default', workflowId: 'wf-ttl', runId: 'run-ttl' }

      yield* cache.upsert({
        key,
        determinismState: EMPTY_STATE,
        lastEventId: 'ttl',
        lastAccessed: Date.now(),
      })
      yield* Effect.sleep('10 millis')
      const entry = yield* cache.get(key)

      expect(entry).toBeUndefined()
    }),
  )
})

test('sticky cache tracks hit/miss/eviction metrics', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const hits = makeFakeCounter()
      const misses = makeFakeCounter()
      const evictions = makeFakeCounter()
      const ttlExpirations = makeFakeCounter()

      const cache = yield* makeStickyCache({
        maxEntries: 1,
        ttlMs: 5,
        metrics: {
          hits: hits.counter,
          misses: misses.counter,
          evictions: evictions.counter,
          ttlExpirations: ttlExpirations.counter,
        },
      })

      const keyA = { namespace: 'default', workflowId: 'wf-a', runId: 'run-a' }
      const keyB = { namespace: 'default', workflowId: 'wf-b', runId: 'run-b' }

      yield* cache.upsert({
        key: keyA,
        determinismState: EMPTY_STATE,
        lastEventId: 'a',
        lastAccessed: Date.now(),
      })

      // hit
      const hitEntry = yield* cache.get(keyA)
      expect(hitEntry).toBeDefined()

      // cause LRU eviction
      yield* cache.upsert({
        key: keyB,
        determinismState: EMPTY_STATE,
        lastEventId: 'b',
        lastAccessed: Date.now(),
      })

      // miss
      const missEntry = yield* cache.get(keyA)
      expect(missEntry).toBeUndefined()

      // TTL expiration
      yield* Effect.sleep('10 millis')
      const expired = yield* cache.get(keyB)
      expect(expired).toBeUndefined()

      expect(hits.read()).toBe(1)
      expect(misses.read()).toBeGreaterThanOrEqual(2)
      expect(evictions.read()).toBeGreaterThanOrEqual(1)
      expect(ttlExpirations.read()).toBeGreaterThanOrEqual(1)
    }),
  )
})

test('sticky cache invokes hooks on hit/miss/evict', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const events: { type: string; reason?: string }[] = []
      const cache = yield* makeStickyCache({
        maxEntries: 1,
        ttlMs: 1,
        hooks: {
          onHit: () => Effect.sync(() => events.push({ type: 'hit' })),
          onMiss: () => Effect.sync(() => events.push({ type: 'miss' })),
          onEvict: (_entry, reason) => Effect.sync(() => events.push({ type: 'evict', reason })),
        },
      })

      const key = { namespace: 'default', workflowId: 'wf-hook', runId: 'run-hook' }
      yield* cache.upsert({
        key,
        determinismState: EMPTY_STATE,
        lastEventId: 'hook',
        lastAccessed: Date.now(),
      })

      // Trigger hit
      const entry = yield* cache.get(key)
      expect(entry).toBeDefined()

      // Force TTL eviction
      yield* Effect.sleep('5 millis')
      const expired = yield* cache.get(key)
      expect(expired).toBeUndefined()

      // Manual removal should not throw
      yield* cache.remove(key)

      expect(events.some((event) => event.type === 'hit')).toBe(true)
      expect(events.some((event) => event.type === 'miss')).toBe(true)
      expect(events.filter((event) => event.type === 'evict').length).toBeGreaterThanOrEqual(1)
    }),
  )
})
