import { describe, expect, it } from 'bun:test'

import { ensureCli, repoRoot, run } from '../cli'

describe('shared cli utilities', () => {
  it('ensureCli passes for known binary', () => {
    expect(() => ensureCli('echo')).not.toThrow()
  })

  it('repoRoot points to repository root', () => {
    expect(repoRoot).toMatch(/review-functional$/)
  })

  it('run executes commands successfully', async () => {
    await expect(run('bash', ['-lc', 'exit 0'])).resolves.toBeUndefined()
  })
})
