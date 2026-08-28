import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

describe('froussard Nix image contract', () => {
  it('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/froussard.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-AHq/bHwOvDa+Fi6rf5FbWDfe73mzQN86ELuFjkaVmjA="')
    expect(image).toContain('aarch64-linux = "sha256-7OoNZSJyVG60fTnTdB0GDN5PfJhxKChojvPGimTe1R8="')
  })
})
