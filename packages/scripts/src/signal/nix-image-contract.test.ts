import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../../..')

describe('Signal publisher Nix image contract', () => {
  test('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(resolve(root, 'nix/images/signal-publisher.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-bUC1dMRSsnhi03d4amaoFtK29Ddequk+42tiuDlVE5U="')
    expect(image).toContain('aarch64-linux = "sha256-cZj0ez2xFgp1kDayGl0KfNxr+4BBckXx19Wqh3fddQY="')
  })
})
