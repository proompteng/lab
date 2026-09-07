import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../../..')

describe('Signal publisher Nix image contract', () => {
  test('pins the dependency closures observed by the Linux builders', () => {
    const image = readFileSync(resolve(root, 'nix/images/signal-publisher.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-9wt6SMZigx6kuRrgN6TdXpPfrbbxqwr1lbrsY1HUeiY="')
    expect(image).toContain('aarch64-linux = "sha256-sEBVACaQmo9lRUpxoZCFbhzBN5cXXYH9Ve5Yj5PGMtA="')
  })
})
