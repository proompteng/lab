import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

describe('froussard Nix image contract', () => {
  it('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/froussard.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-8VXa2TQPWZOlXi+jTMdoH6tPnPs1CSy0K3QOcuixXtQ="')
    expect(image).toContain('aarch64-linux = "sha256-xLvuC0fGeaVrqafWbkHORYWNQb3Nd3gQ6OJLpa6w4lQ="')
  })
})
