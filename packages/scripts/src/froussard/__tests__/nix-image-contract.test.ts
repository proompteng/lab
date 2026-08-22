import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

describe('froussard Nix image contract', () => {
  it('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/froussard.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-zv+v2ijPxGN8PV3s8H/wMdUP8EQH/pcomqilTZLo3ac="')
    expect(image).toContain('aarch64-linux = "sha256-pdNhzMAdtXljUFf4axRA/quk419J+TDVDI5Q891owZk="')
  })
})
