import { afterEach, describe, expect, it } from 'bun:test'

const originalSpawn = Bun.spawn

afterEach(() => {
  Bun.spawn = originalSpawn
})

describe('facteur reseal-secrets helpers', () => {
  it('capture returns stdout stream contents', async () => {
    Bun.spawn = () => {
      const stdout = new Blob(['captured']).stream()
      const stderr = new Blob(['']).stream()
      return {
        stdin: {
          write() {},
          end() {},
        },
        stdout,
        stderr,
        exited: Promise.resolve(0),
      }
    }

    const { __private } = await import('../reseal-secrets')
    await expect(__private.capture(['echo', 'captured'])).resolves.toBe('captured')
  })
})
