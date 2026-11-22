import { describe, expect, it } from 'bun:test'

describe('bumba build-image internals', () => {
  it('includes LAB_GIT_SHA in build args so the worker build id is stable', async () => {
    const { __private } = await import('../build-image')

    expect(__private.resolveBuildArgs('v0.1.0', 'abc123def456')).toEqual({
      BUMBA_VERSION: 'v0.1.0',
      BUMBA_COMMIT: 'abc123def456',
      LAB_GIT_SHA: 'abc123def456',
    })
  })
})
