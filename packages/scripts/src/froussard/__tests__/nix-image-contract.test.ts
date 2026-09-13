import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

describe('froussard Nix image contract', () => {
  it('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/froussard.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-qw2EqZnxZ0aA6P65Sbrlt5sssJL3Ba+y8XbOLXexqRU="')
    expect(image).toContain('aarch64-linux = "sha256-jmHdKYrknGfRDIB3Gyy8Vh06tGQXaFxEBiTvlkhoxjM="')
  })
})
