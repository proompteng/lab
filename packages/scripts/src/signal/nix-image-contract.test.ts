import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../../..')

describe('Signal publisher Nix image contract', () => {
  test('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(resolve(root, 'nix/images/signal-publisher.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-yj99BX72khrbE+LXP86oTBjjdRkwHm2MwnY4hbA2Zr0="')
    expect(image).toContain('aarch64-linux = "sha256-BrND6olKZ5m4IWXoyjja3cvnhPzhS58v1T17r5kZh9U="')
  })
})
