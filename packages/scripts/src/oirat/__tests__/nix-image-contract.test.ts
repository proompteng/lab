import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

describe('oirat Nix image contract', () => {
  it('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/oirat.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-MwH1rr0qGDKtUUH7PeuXoOfz2dZnJmyWwt68IdvOPn8="')
    expect(image).toContain('aarch64-linux = "sha256-GOuwFb/D/evsUV/V7+pqHxByKRUS0Z7v7b/OjGEXQgE="')
  })
})
