import { describe, expect, it } from 'bun:test'

import { cloneRepo, ensureBranch, pushBranch } from './git'

describe('git helpers (stubs)', () => {
  it('cloneRepo currently returns the placeholder path', async () => {
    await expect(cloneRepo({ repoUrl: 'x', workdir: '/tmp/x' })).resolves.toBe('TODO_CLONE_PATH')
  })

  it('ensureBranch resolves without throwing (stub)', async () => {
    await expect(ensureBranch('/tmp/x', 'main')).resolves.toBeUndefined()
  })

  it('pushBranch resolves with an empty result (stub)', async () => {
    await expect(pushBranch('/tmp/x', 'main')).resolves.toEqual({})
  })
})
