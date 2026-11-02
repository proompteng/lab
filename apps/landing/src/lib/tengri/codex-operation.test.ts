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

test('submission timing survives retries while older retained operations keep an unknown start', async () => {
  const storage = storageFixture()
  const input = { threadId: 'thread', text: 'One request', images: [] }
  const operation = await prepareCodexOperation('submission', input, '', {}, storage)
  expect(operation.submittedAtMs).toBeGreaterThan(0)
  expect((await prepareCodexOperation('submission', input, '', {}, storage)).submittedAtMs).toBe(
    operation.submittedAtMs,
  )
  const { submittedAtMs: _submittedAtMs, ...legacy } = operation
  storage.setItem('submission', JSON.stringify(legacy))
  storage.removeItem('submission:timing')
  const recovered = await prepareCodexOperation('submission', input, '', {}, storage)
  expect(recovered.id).toBe(operation.id)
  expect(recovered.submittedAtMs).toBeUndefined()
})

test('timing metadata preserves the exact operation shape accepted by older open tabs', async () => {
  const storage = storageFixture()
  const operation = await prepareCodexOperation('submission', { text: 'One request' }, '', {}, storage)
  const record = JSON.parse(storage.getItem('submission')!)
  expect(Object.keys(record).sort()).toEqual(['fingerprint', 'id', 'options', 'turnId'])
  expect(record.id).toBe(operation.id)
  completeCodexOperation('submission', operation.id, storage)
  expect(storage.getItem('submission:timing')).toBeNull()
})

test('invalid display timing cannot change or block an uncertain operation retry', async () => {
  const storage = storageFixture()
  const input = { text: 'One request' }
  const operation = await prepareCodexOperation('submission', input, '', {}, storage)
  for (const submittedAtMs of [-1, 1e30, 'yesterday', null]) {
    storage.setItem('submission:timing', JSON.stringify({ id: operation.id, submittedAtMs }))
    const retry = await prepareCodexOperation('submission', input, '', {}, storage)
    expect(retry.id).toBe(operation.id)
    expect(retry.submittedAtMs).toBeUndefined()
  }
})
