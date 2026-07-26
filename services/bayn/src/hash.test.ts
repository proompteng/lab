import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  canonicalHashV1,
  canonicalHashV1Result,
  canonicalJsonV1,
  canonicalJsonV1Result,
  renderCanonicalJsonFailure,
  stableU128,
  stableU64,
  type CanonicalJsonFailure,
} from './hash'

const failureOf = <A>(result: Result.Result<A, CanonicalJsonFailure>): CanonicalJsonFailure => {
  expect(Result.isFailure(result)).toBe(true)
  return Result.isFailure(result) ? result.failure : (result.success as never)
}

describe('canonical hashing', () => {
  test('uses deterministic UTF-16 key order and normalizes negative zero', () => {
    expect(canonicalJsonV1({ '\u20ac': 1, '\r': 2, a: -0, '\ud83d\ude00': 3 })).toBe('{"\\r":2,"a":0,"€":1,"😀":3}')
    expect(canonicalJsonV1({ nested: { '2': 2, '10': 1 } })).toBe('{"nested":{"10":1,"2":2}}')
    expect(canonicalHashV1({ b: 2, a: 1 })).toBe(canonicalHashV1({ a: 1, b: 2 }))
  })

  test('rejects values that JSON would silently discard or coerce', () => {
    expect(() => canonicalJsonV1({ missing: undefined })).toThrow('non-JSON undefined')
    expect(() => canonicalJsonV1({ invalid: Number.NaN })).toThrow('non-finite number')
    expect(() => canonicalJsonV1({ invalid: Number.POSITIVE_INFINITY })).toThrow('non-finite number')
    expect(() => canonicalJsonV1({ invalid: 1n })).toThrow('non-JSON bigint')
    expect(() => canonicalJsonV1(new Date('2026-01-01T00:00:00.000Z'))).toThrow('plain JSON objects')
    const sparse: unknown[] = []
    sparse.length = 1
    expect(() => canonicalJsonV1(sparse)).toThrow('dense array')

    const accessor = [1]
    Object.defineProperty(accessor, '0', { enumerable: true, get: () => 1 })
    expect(() => canonicalJsonV1(accessor)).toThrow('enumerable data property')

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => canonicalJsonV1(cyclic)).toThrow('cycle')
  })

  test('returns canonical output and precise failures as values', () => {
    const input = { '\u20ac': 1, '\r': 2, a: -0, nested: ['value', true, null] }
    expect(canonicalJsonV1Result(input)).toEqual(Result.succeed(canonicalJsonV1(input)))
    expect(canonicalHashV1Result(input)).toEqual(Result.succeed(canonicalHashV1(input)))

    expect(failureOf(canonicalJsonV1Result({ missing: undefined }))).toEqual({
      _tag: 'CanonicalJsonFailure',
      path: '$.missing',
      reason: 'non-json-type',
      actualType: 'undefined',
    })
    expect(failureOf(canonicalJsonV1Result({ invalid: Number.NaN }))).toEqual({
      _tag: 'CanonicalJsonFailure',
      path: '$.invalid',
      reason: 'non-finite-number',
      actualType: 'number',
    })
    expect(renderCanonicalJsonFailure(failureOf(canonicalJsonV1Result({ invalid: Number.NaN })))).toBe(
      'non-finite-number at $.invalid (number)',
    )

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(failureOf(canonicalJsonV1Result(cyclic))).toEqual({
      _tag: 'CanonicalJsonFailure',
      path: '$.self',
      reason: 'cycle',
      actualType: 'object',
    })
  })

  test('produces stable non-zero TigerBeetle identifiers', () => {
    expect(stableU128('run', 'event')).toBe(stableU128('run', 'event'))
    expect(stableU128('run', 'event')).not.toBe(stableU128('run', 'other'))
    expect(stableU128('run', 'event')).toBeGreaterThan(0n)
    expect(stableU64('run')).toBeGreaterThan(0n)
    expect(stableU64('run')).toBeLessThan(1n << 64n)
  })
})
