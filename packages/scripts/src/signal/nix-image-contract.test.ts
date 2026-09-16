import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../../..')

describe('Signal publisher Nix image contract', () => {
  test('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(resolve(root, 'nix/images/signal-publisher.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-VPKi52f/lJw5WVc106uQAn53rTLYincNp09Y5RXsz6A="')
    expect(image).toContain('aarch64-linux = "sha256-aeMIvSj03a3W3oMsDgSWLbU7a3EjV9Wok7COyDASlWI="')
  })
})
