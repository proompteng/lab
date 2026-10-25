import { afterEach, beforeAll, describe, expect, it } from 'bun:test'

let originalSpawnSync: typeof Bun.spawnSync

beforeAll(() => {
  originalSpawnSync = Bun.spawnSync
})

afterEach(() => {
  Bun.spawnSync = originalSpawnSync
})

describe('facteur deploy-service internals', () => {
  it('execGit returns trimmed output', async () => {
    Bun.spawnSync = ((..._args: Parameters<typeof Bun.spawnSync>) => ({
      exitCode: 0,
      stdout: Buffer.from('deadbeef\n'),
      stderr: new Uint8Array(),
    })) as typeof Bun.spawnSync

    const { __private } = await import('../deploy-service')
    expect(__private.execGit(['rev-parse', '--short', 'HEAD'])).toBe('deadbeef')
  })

  it('execGit throws on failure', async () => {
    Bun.spawnSync = ((..._args: Parameters<typeof Bun.spawnSync>) => ({
      exitCode: 2,
      stdout: new Uint8Array(),
      stderr: Buffer.from('fatal'),
    })) as typeof Bun.spawnSync

    const { __private } = await import('../deploy-service')
    expect(() => __private.execGit(['rev-parse'])).toThrow(/git rev-parse failed/)
  })
})
