import { describe, expect, test } from 'bun:test'

import { canonicalJson, hashObject, stableU128, stableU64 } from './hash'

describe('canonical hashing', () => {
  test('does not depend on object insertion order', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe(canonicalJson({ a: { x: 3, y: 2 }, z: 1 }))
    expect(hashObject({ b: 2, a: 1 })).toBe(hashObject({ a: 1, b: 2 }))
  })

  test('produces stable non-zero TigerBeetle identifiers', () => {
    expect(stableU128('run', 'event')).toBe(stableU128('run', 'event'))
    expect(stableU128('run', 'event')).not.toBe(stableU128('run', 'other'))
    expect(stableU128('run', 'event')).toBeGreaterThan(0n)
    expect(stableU64('run')).toBeGreaterThan(0n)
    expect(stableU64('run')).toBeLessThan(1n << 64n)
  })
})
