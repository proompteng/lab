import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  canonicalHashV1,
  canonicalHashV1OrThrow,
  canonicalHashV1Result,
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
  test('preserves canonical bytes, UTF-16 key order, negative-zero normalization, and hash identity', () => {
    const value = {
      z: [null, true, false, -0, 1.25, 'é', '😀'],
      a: { '2': 2, '10': 1 },
    }
    const canonical = '{"a":{"10":1,"2":2},"z":[null,true,false,0,1.25,"é","😀"]}'
    const hash = 'eb5c6929cd35d9590df65fb9db0caf13177df754b1d99e17c8d58e30735486c9'

    expect(canonicalJsonV1Result(value)).toEqual(Result.succeed(canonical))
    expect(canonicalHashV1Result(value)).toEqual(Result.succeed(hash))
    expect(canonicalHashV1(value)).toBe(hash)
    expect(canonicalHashV1OrThrow(value)).toBe(hash)
    expect(canonicalHashV1({ b: 2, a: 1 })).toBe(canonicalHashV1({ a: 1, b: 2 }))
  })

  test('preserves valid Unicode exactly and rejects invalid value or key surrogates as data', () => {
    expect(canonicalJsonV1Result({ emoji: '\ud83d\ude00', composed: 'é', decomposed: 'e\u0301' })).toEqual(
      Result.succeed('{"composed":"é","decomposed":"é","emoji":"😀"}'),
    )
    expect(canonicalHashV1({ value: 'é' })).not.toBe(canonicalHashV1({ value: 'e\u0301' }))

    expect(failureOf(canonicalJsonV1Result({ invalid: '\ud800' }))).toEqual({
      _tag: 'CanonicalJsonFailure',
      path: '$.invalid',
      reason: 'invalid-unicode-surrogate',
      actualType: 'string',
    })
    expect(failureOf(canonicalJsonV1Result({ invalid: '\udc00' }))).toEqual({
      _tag: 'CanonicalJsonFailure',
      path: '$.invalid',
      reason: 'invalid-unicode-surrogate',
      actualType: 'string',
    })
    expect(failureOf(canonicalJsonV1Result({ ['\ud800']: true }))).toEqual({
      _tag: 'CanonicalJsonFailure',
      path: '$',
      reason: 'invalid-unicode-key',
      actualType: 'string',
    })
  })

  test('rejects non-finite numbers and non-JSON values without throwing', () => {
    const cases = [
      [{ invalid: Number.NaN }, '$.invalid', 'non-finite-number', 'number'],
      [{ invalid: Number.POSITIVE_INFINITY }, '$.invalid', 'non-finite-number', 'number'],
      [{ invalid: Number.NEGATIVE_INFINITY }, '$.invalid', 'non-finite-number', 'number'],
      [{ missing: undefined }, '$.missing', 'non-json-type', 'undefined'],
      [{ invalid: 1n }, '$.invalid', 'non-json-type', 'bigint'],
      [{ invalid: Symbol('value') }, '$.invalid', 'non-json-type', 'symbol'],
      [{ invalid: () => null }, '$.invalid', 'non-json-type', 'function'],
    ] as const

    for (const [value, path, reason, actualType] of cases) {
      const run = () => canonicalJsonV1Result(value)
      expect(run).not.toThrow()
      expect(failureOf(run())).toEqual({
        _tag: 'CanonicalJsonFailure',
        path,
        reason,
        actualType,
      })
    }

    expect(renderCanonicalJsonFailure(failureOf(canonicalJsonV1Result({ invalid: Number.NaN })))).toBe(
      'non-finite-number at $.invalid (number)',
    )
  })

  test('rejects cycles while accepting repeated non-cyclic references', () => {
    const cyclicObject: Record<string, unknown> = {}
    cyclicObject['self'] = cyclicObject
    expect(failureOf(canonicalJsonV1Result(cyclicObject))).toEqual({
      _tag: 'CanonicalJsonFailure',
      path: '$.self',
      reason: 'cycle',
      actualType: 'object',
    })

    const cyclicArray: unknown[] = []
    cyclicArray.push(cyclicArray)
    expect(failureOf(canonicalJsonV1Result(cyclicArray))).toEqual({
      _tag: 'CanonicalJsonFailure',
      path: '$[0]',
      reason: 'cycle',
      actualType: 'array',
    })

    const shared = { value: 1 }
    expect(canonicalJsonV1Result({ left: shared, right: shared })).toEqual(
      Result.succeed('{"left":{"value":1},"right":{"value":1}}'),
    )
  })

  test('rejects sparse, custom, symbolic, and accessor arrays', () => {
    const sparse: unknown[] = []
    sparse.length = 1

    const enumerableCustom = [1]
    Object.defineProperty(enumerableCustom, 'custom', { enumerable: true, value: 2 })

    const hiddenCustom = [1]
    Object.defineProperty(hiddenCustom, 'custom', { enumerable: false, value: 2 })

    const symbolic = [1]
    Object.defineProperty(symbolic, Symbol('custom'), { enumerable: true, value: 2 })

    let getterCalls = 0
    const accessor = [1]
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return 1
      },
    })

    for (const value of [sparse, enumerableCustom, hiddenCustom, symbolic]) {
      expect(failureOf(canonicalJsonV1Result(value))).toEqual({
        _tag: 'CanonicalJsonFailure',
        path: '$',
        reason: 'non-dense-array',
        actualType: 'array',
      })
    }
    expect(failureOf(canonicalJsonV1Result(accessor))).toEqual({
      _tag: 'CanonicalJsonFailure',
      path: '$[0]',
      reason: 'non-data-property',
      actualType: 'array-property',
    })
    expect(getterCalls).toBe(0)
  })

  test('accepts plain data descriptors and rejects object accessors, hidden properties, symbols, and prototypes', () => {
    const data = Object.create(null) as Record<string, unknown>
    Object.defineProperty(data, 'value', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: 1,
    })
    expect(canonicalJsonV1Result(data)).toEqual(Result.succeed('{"value":1}'))

    let getterCalls = 0
    const accessor = {}
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return 1
      },
    })
    expect(failureOf(canonicalJsonV1Result(accessor))).toEqual({
      _tag: 'CanonicalJsonFailure',
      path: '$.value',
      reason: 'non-data-property',
      actualType: 'object-property',
    })
    expect(getterCalls).toBe(0)

    const hidden = {}
    Object.defineProperty(hidden, 'value', { enumerable: false, value: 1 })
    expect(failureOf(canonicalJsonV1Result(hidden))).toEqual({
      _tag: 'CanonicalJsonFailure',
      path: '$.value',
      reason: 'non-data-property',
      actualType: 'object-property',
    })

    const symbolic = { value: 1 }
    Object.defineProperty(symbolic, Symbol('custom'), { enumerable: false, value: 2 })
    expect(failureOf(canonicalJsonV1Result(symbolic))).toEqual({
      _tag: 'CanonicalJsonFailure',
      path: '$',
      reason: 'symbol-key',
      actualType: 'object',
    })

    expect(failureOf(canonicalJsonV1Result(new Date('2026-01-01T00:00:00.000Z')))).toEqual({
      _tag: 'CanonicalJsonFailure',
      path: '$',
      reason: 'non-plain-object',
      actualType: 'object',
    })
  })

  test('contains throwing reflection traps as fact-bearing Result failures', () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const classify = () => canonicalJsonV1Result(revoked.proxy)
    expect(classify).not.toThrow()
    expect(failureOf(classify())).toMatchObject({
      _tag: 'CanonicalJsonFailure',
      path: '$',
      reason: 'introspection-failed',
      actualType: 'object',
      operation: 'array-classification',
      cause: expect.any(TypeError),
    })

    const ownKeysCause = new Error('own keys unavailable')
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw ownKeysCause
        },
      },
    )
    const ownKeysFailure = failureOf(canonicalJsonV1Result(hostile))
    expect(ownKeysFailure).toMatchObject({
      _tag: 'CanonicalJsonFailure',
      path: '$',
      reason: 'introspection-failed',
      actualType: 'object',
      operation: 'own-keys',
    })
    expect(ownKeysFailure.reason === 'introspection-failed' && ownKeysFailure.cause).toBe(ownKeysCause)
    expect(renderCanonicalJsonFailure(ownKeysFailure)).toBe('introspection-failed at $ (object; own-keys)')
  })

  test('keeps empty values and insertion-order permutations byte-identical', () => {
    const permutations = [{}, Object.fromEntries([]), Object.assign(Object.create(null), {})]
    for (const value of permutations) expect(canonicalJsonV1Result(value)).toEqual(Result.succeed('{}'))

    const first = { emptyArray: [], emptyObject: {}, nested: { z: 0, a: '' } }
    const second = { nested: { a: '', z: -0 }, emptyObject: {}, emptyArray: [] }
    expect(canonicalJsonV1Result(first)).toEqual(canonicalJsonV1Result(second))
    expect(canonicalHashV1Result(first)).toEqual(canonicalHashV1Result(second))
  })

  test('produces stable non-zero TigerBeetle identifiers', () => {
    expect(stableU128('run', 'event')).toBe(54953207663554066615626984220646087740n)
    expect(stableU128('run', 'event')).not.toBe(stableU128('run', 'other'))
    expect(stableU128('run', 'event')).toBeGreaterThan(0n)
    expect(stableU64('run')).toBe(6267951632907394021n)
    expect(stableU64('run')).toBeLessThan(1n << 64n)
  })
})
