import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

describe('froussard Nix image contract', () => {
  it('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/froussard.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-p9cMqBBy5kEGCQRK0cb/6bkMdXzzDfDmygcQI6Vud54="')
    expect(image).toContain('aarch64-linux = "sha256-/P1eH/L8whbHaN2FmOGeQl1bX5H4EIH1Jw0wH85nvzc="')
  })
})
