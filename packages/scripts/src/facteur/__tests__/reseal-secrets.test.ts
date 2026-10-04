import { afterEach, describe, expect, it } from 'bun:test'

const originalSpawn = Bun.spawn

afterEach(() => {
  Bun.spawn = originalSpawn
})

describe('facteur reseal-secrets helpers', () => {
  it('capture returns stdout stream contents', async () => {
    Bun.spawn = ((..._args: Parameters<typeof Bun.spawn>) => {
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
      } as unknown as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn

    const { __private } = await import('../reseal-secrets')
    return expect(__private.capture(['echo', 'captured'])).resolves.toBe('captured')
  })
})
