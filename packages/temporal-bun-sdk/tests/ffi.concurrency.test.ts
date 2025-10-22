import { describe, expect, test } from 'bun:test'
import { drainErrorForTest } from '../src/ffi.ts'
import { ClientHandle } from '../src/handles.ts'

describe('ffi concurrency', () => {
  test('connect and close handles across concurrent tasks', async () => {
    const iterations = 100
    const workers = Array.from({ length: 8 }, async () => {
      for (let index = 0; index < iterations; index += 1) {
        const client = ClientHandle.create()
        client.close()
      }
    })
    await Promise.all(workers)
    expect(drainErrorForTest()).toBeNull()
  })
})
