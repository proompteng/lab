import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

describe('froussard Nix image contract', () => {
  it('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/froussard.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-9on/zsdBMotxhAJ2Ul0oOjC9nca+7UUl2qrB/oMewrw="')
    expect(image).toContain('aarch64-linux = "sha256-Bt4N43CNpc5TBgFaBBzmnq7qPznc4kl4Ut/h7PG95RI="')
  })
})
