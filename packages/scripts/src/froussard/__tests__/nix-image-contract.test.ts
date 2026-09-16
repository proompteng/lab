import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

describe('froussard Nix image contract', () => {
  it('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/froussard.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-b3D2d8QIOc/4R5ScckOVfYAzgeh3B7pU8rDCWi3iAnM="')
    expect(image).toContain('aarch64-linux = "sha256-7/CO+MULYkQtmj5viZ0Lank+slExJnByX35N5rWUTPo="')
  })
})
