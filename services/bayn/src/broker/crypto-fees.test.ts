import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { CryptoFeeTier, CryptoFeeTierSchema, cryptoTakerFeeBps, effectiveCryptoFeeTier } from './crypto-fees'

test.each([
  [CryptoFeeTier.One, 25],
  [CryptoFeeTier.Two, 22],
  [CryptoFeeTier.Three, 20],
  [CryptoFeeTier.Four, 18],
  [CryptoFeeTier.Five, 15],
  [CryptoFeeTier.Six, 13],
  [CryptoFeeTier.Seven, 12],
  [CryptoFeeTier.Eight, 10],
] as const)('broker tier %s bounds the entry taker fee at %s bps', (tier, expected) => {
  expect(cryptoTakerFeeBps(tier)).toBe(expected)
  expect(Result.isSuccess(Schema.decodeUnknownResult(CryptoFeeTierSchema)(tier))).toBe(true)
})

test.each([0, 9, -1, 4.5, '4', true])('an unknown external fee tier %s is rejected', (tier) => {
  expect(Result.isFailure(Schema.decodeUnknownResult(CryptoFeeTierSchema)(tier))).toBe(true)
})

test('an unavailable tier retains the published maximum instead of a discount', () => {
  expect(cryptoTakerFeeBps(null)).toBe(25)
  expect(effectiveCryptoFeeTier(null, '2026-10-24T23:00:00.000Z', '2026-10-24T23:00:01.000Z')).toBeNull()
})

test.each([
  ['2026-10-24T06:59:59.000Z', '2026-10-24T06:59:59.999Z', CryptoFeeTier.Four],
  ['2026-10-24T06:59:59.000Z', '2026-10-24T07:00:00.000Z', null],
  ['2026-10-24T07:00:00.000Z', '2026-10-24T07:59:59.999Z', CryptoFeeTier.Four],
  ['2026-10-24T07:59:59.000Z', '2026-10-24T08:00:00.000Z', null],
  ['2026-10-24T23:59:59.000Z', '2026-10-25T00:00:00.000Z', CryptoFeeTier.Four],
  ['2026-10-24T23:59:59.000Z', '2026-10-25T07:00:00.000Z', null],
] as const)('the fee tier observed at %s expires conservatively by %s', (observedAt, evaluatedAt, expected) => {
  expect(effectiveCryptoFeeTier(CryptoFeeTier.Four, observedAt, evaluatedAt)).toBe(expected)
})
