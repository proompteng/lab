import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../../..')

describe('Signal publisher Nix image contract', () => {
  test('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(resolve(root, 'nix/images/signal-publisher.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-26Z6FE1CE6gHf6hjK9kWpG5SLy1a0S0DddWw3XNWB1c="')
    expect(image).toContain('aarch64-linux = "sha256-4T9BYjSEjW6SOguGrcVeNVwnUS74mKrgg1jO8XnINII="')
  })
})
