import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

describe('froussard Nix image contract', () => {
  it('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/froussard.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-Vf1gxKNERlMCpSXIWU2PXDHJ+lMbsOtLRR1ln97GcZo="')
    expect(image).toContain('aarch64-linux = "sha256-jF/5qUAMY4sjdMChW414IV6ElAhIs3yddPVNsnUWvFs="')
  })
})
