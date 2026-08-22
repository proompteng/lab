import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

describe('froussard Nix image contract', () => {
  it('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/froussard.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-E0R3sUZ4TjRKHeDQVSy17SHacr0VUby2NGQTV3+x1zg="')
    expect(image).toContain('aarch64-linux = "sha256-1bLBL6T3G6V+a2nJKsRnkgBTqtylQDmm/f8nC55Wdxc="')
  })
})
