import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

describe('froussard Nix image contract', () => {
  it('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/froussard.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-zsz+9375A0BGIVuBvbQN6zt9/x8/ItRyimf9qZicCHs="')
    expect(image).toContain('aarch64-linux = "sha256-6kPu1cxS2IMZKhenilAXD4Q5ZYXkmaR7h0TSA+3Qnrk="')
  })
})
