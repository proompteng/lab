import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

describe('froussard Nix image contract', () => {
  it('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/froussard.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-0HkC0E6wnNY9cUsAgYC7pfrTxgAzTblLNl730QNbIHI="')
    expect(image).toContain('aarch64-linux = "sha256-PzfUuI8vbOUedsg/aS7TE0AMlND/ojeDrhOiKrE9jIY="')
  })
})
