import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

describe('oirat Nix image contract', () => {
  it('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/oirat.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-e92eaR/VYRTKdbWYaNrCtboaasy7huMhQsvffWnSEUU="')
    expect(image).toContain('aarch64-linux = "sha256-Nqfyxuo8KhwPzLaEc/4dPuWr0GKsIP09hbRXwI3rE18="')
  })
})
