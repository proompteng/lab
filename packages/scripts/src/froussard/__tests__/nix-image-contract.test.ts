import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

describe('froussard Nix image contract', () => {
  it('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/froussard.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-mqTY/iASQ5Y9MkCPM0PB2v8GVOhkYwrD7RDEDh2kzSg="')
    expect(image).toContain('aarch64-linux = "sha256-dr9kxaJAhPl0QEa2u6/gI/4iT47jJTQuMgwAS27vPQw="')
  })
})
