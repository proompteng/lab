import { describe, expect, it } from 'bun:test'

import { ensureCli, repoRoot, run } from '../cli'

describe('shared cli utilities', () => {
  it('ensureCli passes for known binary', () => {
    expect(() => ensureCli('echo')).not.toThrow()
  })

  it('repoRoot points to repository root', () => {
    expect(repoRoot).toBe(process.cwd())
  })

  it('run executes commands successfully', () => expect(run('bash', ['-lc', 'exit 0'])).resolves.toBeUndefined())
})
