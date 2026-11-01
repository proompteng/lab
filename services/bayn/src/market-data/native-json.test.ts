import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { nativePayloadCanonicalJson, nativePayloadNumericFields, nativeSourceContentHash } from './native-json'
import { sha256 } from '../hash'

test('native source hashing preserves decimal and exponent tokens while ordering object keys', () => {
  const payload = Result.getOrThrow(
    nativePayloadCanonicalJson('{"payload":{"v":1.000000000,"c":82000.123456789,"x":[1e-9,-0.0]}}'),
  )
  expect(payload).toBe('{"c":82000.123456789,"v":1.000000000,"x":[1e-9,-0.0]}')
  expect(nativeSourceContentHash(['alpaca', 'us', 'BTC/USD'], payload)).toBe(
    sha256(`["alpaca","us","BTC/USD",${payload}]`),
  )
  expect(payload).not.toBe(JSON.stringify(JSON.parse(payload)))
})

test('malformed native envelopes fail without manufacturing a payload', () => {
  for (const record of ['{', '{}', 'null', '{"payload":NaN}'])
    expect(Result.isFailure(nativePayloadCanonicalJson(record))).toBe(true)
})

test('native numeric fields retain decimal quantities and one-atom exponents without binary64 rounding', () => {
  expect(
    Result.getOrThrow(
      nativePayloadNumericFields('{"v":9007199.123456789,"c":82000.123456789,"s":1e-9,"text":"1.2","zero":0}'),
    ),
  ).toEqual({
    v: '9007199.123456789',
    c: '82000.123456789',
    s: '0.000000001',
    zero: '0',
  })
  expect(Result.isFailure(nativePayloadNumericFields('{'))).toBeTrue()
  expect(Result.isFailure(nativePayloadNumericFields('null'))).toBeTrue()
})
