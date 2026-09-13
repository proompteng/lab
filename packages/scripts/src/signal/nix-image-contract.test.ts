import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../../..')

describe('Signal publisher Nix image contract', () => {
  test('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(resolve(root, 'nix/images/signal-publisher.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-fJN/TGFC8fxev5T+OBZ1BK3bIyHxyTzWV8bPm21s75E="')
    expect(image).toContain('aarch64-linux = "sha256-RxKBAlbIc1+nWVdn9XPaQJHCzcxo7pxGW+yXRUGd21s="')
  })
})
