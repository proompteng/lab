import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

describe('froussard Nix image contract', () => {
  it('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(join(repoRoot, 'nix/images/froussard.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-oKTSsF0H8dh8vk9CvJruJUOUH+IdMNQN9s8TystgE0Q="')
    expect(image).toContain('aarch64-linux = "sha256-dWXUZxQh/trI9XCDgqy1qfpDU6gf+hqkALR0WRfmZ5Y="')
  })
})
