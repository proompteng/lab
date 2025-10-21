import { expect, test } from 'bun:test'

import { clientClose, clientConnect } from '../src/ffi'

const THREADS = 8
const ITERATIONS = 100

test('multi-actor open/close stress', async () => {
  const tasks = Array.from({ length: THREADS }, async () => {
    for (let index = 0; index < ITERATIONS; index += 1) {
      const handle = clientConnect()
      expect(handle).toBeGreaterThan(0n)
      clientClose(handle)
    }
  })

  await Promise.all(tasks)
})
