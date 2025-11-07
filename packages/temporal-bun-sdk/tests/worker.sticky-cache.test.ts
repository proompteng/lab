import { expect, test } from 'bun:test'
import { Effect } from 'effect'

import { makeStickyCache } from '../src/worker/sticky-cache'
import type { WorkflowDeterminismState } from '../src/workflow/determinism'

const EMPTY_STATE: WorkflowDeterminismState = {
  commandHistory: [],
  randomValues: [],
  timeValues: [],
}

test('sticky cache evicts least-recently-used entries when capacity exceeded', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const cache = yield* makeStickyCache({ maxEntries: 2, ttlMs: 10_000 })
      const keyOne = { namespace: 'default', workflowId: 'wf-1', runId: 'run-1' }
      const keyTwo = { namespace: 'default', workflowId: 'wf-2', runId: 'run-2' }
      const keyThree = { namespace: 'default', workflowId: 'wf-3', runId: 'run-3' }

      yield* cache.upsert({ key: keyOne, determinismState: EMPTY_STATE, lastEventId: '1', lastAccessed: Date.now() })
      yield* Effect.sleep('2 millis')
      yield* cache.upsert({ key: keyTwo, determinismState: EMPTY_STATE, lastEventId: '2', lastAccessed: Date.now() })
      yield* Effect.sleep('2 millis')
      yield* cache.upsert({ key: keyThree, determinismState: EMPTY_STATE, lastEventId: '3', lastAccessed: Date.now() })

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

      yield* cache.upsert({ key, determinismState: EMPTY_STATE, lastEventId: 'ttl', lastAccessed: Date.now() })
      yield* Effect.sleep('10 millis')
      const entry = yield* cache.get(key)

      expect(entry).toBeUndefined()
    }),
  )
})
