import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../../..')

describe('Signal publisher Nix image contract', () => {
  test('pins the dependency closures observed by both native builders', () => {
    const image = readFileSync(resolve(root, 'nix/images/signal-publisher.nix'), 'utf8')

    expect(image).toContain('x86_64-linux = "sha256-r50uAMFELn5y8GE65WtGIfitWQsgthkVT/CYv6Wk2LU="')
    expect(image).toContain('aarch64-linux = "sha256-/qjyMWfkaFH7XEYEDV2G6jtuDLbZVcUmeRB74PL9ZPs="')
  })
})
