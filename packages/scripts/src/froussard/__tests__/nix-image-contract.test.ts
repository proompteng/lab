import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

describe('froussard Nix image contract', () => {
  it('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/froussard.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-W4RToWAToEM/Jfsl1Dmbi6Cp5xV4Ye3WZshj8j5BFwE="')
    expect(image).toContain('aarch64-linux = "sha256-UUFnfC8AkxWsW3I67Wpn7AmU+US7rfvspFVizbBOl24="')
  })
})
