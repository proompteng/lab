import { expect, test } from 'bun:test'
import { completeCodexOperation, prepareCodexOperation } from './codex-operation'

function storageFixture(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

test('a lost response retains the operation identity across retries and reloads', async () => {
  const storage = storageFixture()
  const input = { threadId: 'thread-1', text: 'Write the requested file', images: [] }
  const operation = await prepareCodexOperation('submission', input, '', {}, storage)
  const id = operation.id
  expect(await prepareCodexOperation('submission', { ...input }, 'accepted-turn', {}, storage)).toEqual(operation)
  expect(storage.getItem('submission')).not.toContain(input.text)
  completeCodexOperation('submission', crypto.randomUUID(), storage)
  expect((await prepareCodexOperation('submission', input, '', {}, storage)).id).toBe(id)
  completeCodexOperation('submission', id, storage)
  expect((await prepareCodexOperation('submission', input, '', {}, storage)).id).not.toBe(id)
})

test('a different input gets a different identity', async () => {
  const storage = storageFixture()
  const operation = await prepareCodexOperation('submission', { text: 'First request' }, '', {}, storage)
  expect((await prepareCodexOperation('submission', { text: 'Different request' }, '', {}, storage)).id).not.toBe(
    operation.id,
  )
})

test('an ambiguous retry retains the original model settings without rotating its identity', async () => {
  const storage = storageFixture()
  const input = { threadId: 'thread', text: 'One request', images: [] }
  const operation = await prepareCodexOperation(
    'submission',
    input,
    '',
    { model: 'first', reasoningEffort: 'high' },
    storage,
  )
  const retry = await prepareCodexOperation(
    'submission',
    input,
    'accepted-turn',
    { model: 'second', reasoningEffort: 'low' },
    storage,
  )
  expect(retry).toEqual(operation)
  expect(retry.options).toEqual({ model: 'first', reasoningEffort: 'high' })
})
