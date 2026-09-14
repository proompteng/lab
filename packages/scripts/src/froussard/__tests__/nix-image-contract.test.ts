import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

describe('froussard Nix image contract', () => {
  it('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/froussard.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-lehIz2I8sZH6kW/Tt13qVqCU7UJqfruAizO4h7I39L8="')
    expect(image).toContain('aarch64-linux = "sha256-6OloMEKxao+135eqFzNI8OSI5kwGxURStrbRCQy4viU="')
  })
})
