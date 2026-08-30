import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

let originalSpawnSync: typeof Bun.spawnSync

beforeAll(() => {
  originalSpawnSync = Bun.spawnSync
})

afterEach(() => {
  Bun.spawnSync = originalSpawnSync
})

describe('bumba build-image internals', () => {
  it('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/bumba.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-fS1drRuxef6H6QieDU9afrqsjVyKIll8/qB4ZLUoWlY="')
    expect(image).toContain('aarch64-linux = "sha256-rjshdlEOFK2MxVJGfQDzNw9ASJ6p60+CUlbk5aZtP1M="')
  })

  it('includes LAB_GIT_SHA in build args so the worker build id is stable', async () => {
    const { __private } = await import('../build-image')

    expect(__private.resolveBuildArgs('v0.1.0', 'abc123def456')).toEqual({
      BUMBA_VERSION: 'v0.1.0',
      BUMBA_COMMIT: 'abc123def456',
      LAB_GIT_SHA: 'abc123def456',
    })
  })

  it('execGit returns trimmed output', async () => {
    Bun.spawnSync = ((..._args: Parameters<typeof Bun.spawnSync>) => ({
      exitCode: 0,
      stdout: Buffer.from('abc123\n'),
      stderr: new Uint8Array(),
    })) as typeof Bun.spawnSync

    const { __private } = await import('../build-image')
    expect(__private.execGit(['rev-parse', 'HEAD'])).toBe('abc123')
  })

  it('execGit throws on failure', async () => {
    Bun.spawnSync = ((..._args: Parameters<typeof Bun.spawnSync>) => ({
      exitCode: 1,
      stdout: new Uint8Array(),
      stderr: Buffer.from('error'),
    })) as typeof Bun.spawnSync

    const { __private } = await import('../build-image')
    expect(() => __private.execGit(['describe'])).toThrow(/git describe failed/)
  })
})
