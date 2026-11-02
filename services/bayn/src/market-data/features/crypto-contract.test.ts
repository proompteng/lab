import { expect, test } from 'bun:test'
import { Result } from 'effect'

import fixture from './fixtures/crypto-continuous-v2.json'
import { decodeCryptoMarketFeature } from './crypto-contract'
import { canonicalHashV1Result } from '../../hash'
import { nativePayloadCanonicalJson, nativeSourceContentHash } from '../native-json'

test('the consumer verifies the real Dorvud-produced crypto fixture across a weekend midnight', () => {
  const feature = Result.getOrThrow(decodeCryptoMarketFeature(fixture.feature))
  expect(feature.material.windowEndMs).toBe(Date.parse('2026-10-11T00:01:00Z'))
  expect(feature.material.priceWindow.totalVolume).toBe('0.00000003')
  const record = fixture.records[0]
  const input = feature.material.inputs[0]
  if (record === undefined || input === undefined) throw new Error('producer fixture must contain raw source records')
  const hash = nativeSourceContentHash(
    ['alpaca', 'us', 'BTC/USD', 'bars', input.eventTimeNanos, input.ingestionTimeNanos],
    Result.getOrThrow(nativePayloadCanonicalJson(record.value)),
  )
  expect(hash).toBe(input.contentHash)
})

test('crypto feature verification rejects changed payloads, broken history, and premature computations', () => {
  expect(
    Result.isFailure(
      decodeCryptoMarketFeature({
        ...fixture.feature,
        material: { ...fixture.feature.material, symbol: 'ETH/USD' },
      }),
    ),
  ).toBe(true)
  const changed = { ...fixture.feature.material, historyHash: 'f'.repeat(64) }
  expect(
    Result.isFailure(
      decodeCryptoMarketFeature({
        ...fixture.feature,
        material: changed,
        featureId: Result.getOrThrow(canonicalHashV1Result(changed)),
      }),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      decodeCryptoMarketFeature({
        ...fixture.feature,
        computedAtMs: fixture.feature.material.windowEndMs - 6000,
      }),
    ),
  ).toBe(true)
})
