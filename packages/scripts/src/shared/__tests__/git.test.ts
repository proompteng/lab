import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'bun:test'

import { execGit } from '../git'

it('returns trimmed stdout and reports a nonzero exit from Git', () => {
  const directory = mkdtempSync(join(tmpdir(), 'script-git-test-'))
  try {
    execGit(['-C', directory, 'init', '--quiet'])
    expect(execGit(['-C', directory, 'rev-parse', '--show-toplevel'])).toBe(realpathSync(directory))

    const missing = ['-C', directory, 'rev-parse', '--verify', 'refs/heads/missing']
    expect(() => execGit(missing)).toThrow(`git ${missing.join(' ')} failed`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
