import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Result } from 'effect'

import { canonicalHashV1 } from '../../hash'
import type { IntradayBar } from '../intraday/model'
import { decodeRollingMarketFeature, featureMatchesBars, type RollingMarketFeature } from './contract'

const fixture: unknown = JSON.parse(readFileSync(new URL('./fixtures/rolling-price-v1.json', import.meta.url), 'utf8'))
const feature = () => Result.getOrThrow(decodeRollingMarketFeature(fixture))
const start = Date.parse('2026-09-11T13:30:00Z')
const bars = (): readonly IntradayBar[] =>
  Array.from({ length: 30 }, (_, index) => ({
    provider: 'alpaca',
    universeId: 'test-equity-v1',
    universeSymbolHash: feature().material.universeSymbolHash,
    feed: 'iex',
    channel: 'bars',
    marketSession: 'regular',
    delayClass: 'real_time_exchange_only',
    symbol: 'AAPL',
    eventAt: new Date(start + index * 60_000).toISOString(),
    ingestedAt: new Date(start + (index + 1) * 60_000 + 1000).toISOString(),
    sourceTopic: 'torghut.bars.1m.v1',
    sourcePartition: 0,
    sourceOffset: String(index),
    final: true,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10.25,
    vwap: 100.5 + index,
    tradeCount: '2',
    schemaVersion: 1,
  }))
const rehash = (changed: RollingMarketFeature): RollingMarketFeature => ({
  ...changed,
  featureId: canonicalHashV1(changed.material),
})

describe('Dorvud rolling feature wire contract', () => {
  test('decodes the Kotlin-produced fixture with identical definition and content identity', () => {
    const value = feature()
    expect(value.featureId).toBe(canonicalHashV1(value.material))
    expect(value.material.values).toEqual({
      referencePriceMicros: '100000000',
      rangeHighPriceMicros: '131000000',
      rangeLowPriceMicros: '99000000',
      lastClosePriceMicros: '130000000',
      totalVolumeMicros: '307500000',
    })
    expect(Result.getOrThrow(featureMatchesBars(value, bars()))).toBe(true)
  })

  test('bounds source offsets and partitions to the Kafka wire integer domains', () => {
    const value = feature()
    for (const [offset, accepted] of [
      ['9223372036854775807', true],
      ['9223372036854775808', false],
      ['-1', false],
      ['01', false],
    ] as const) {
      const inputs = value.material.inputs.map((input, index) =>
        index === 0 ? { ...input, sourceOffset: offset } : input,
      )
      expect(
        Result.isSuccess(decodeRollingMarketFeature(rehash({ ...value, material: { ...value.material, inputs } }))),
      ).toBe(accepted)
    }
    const inputs = value.material.inputs.map((input, index) =>
      index === 0 ? { ...input, sourcePartition: 2_147_483_648 } : input,
    )
    expect(
      Result.isFailure(decodeRollingMarketFeature(rehash({ ...value, material: { ...value.material, inputs } }))),
    ).toBe(true)
  })

  test('rejects tampering and unsupported definitions', () => {
    const value = feature()
    expect(Result.isFailure(decodeRollingMarketFeature({ ...value, featureId: '0'.repeat(64) }))).toBe(true)
    expect(
      Result.isFailure(
        decodeRollingMarketFeature(
          rehash({ ...value, material: { ...value.material, definitionHash: '0'.repeat(64) } }),
        ),
      ),
    ).toBe(true)
  })

  test('rejects incomplete windows and future input availability even with a matching hash', () => {
    const value = feature()
    expect(
      Result.isFailure(
        decodeRollingMarketFeature(
          rehash({ ...value, material: { ...value.material, inputs: value.material.inputs.slice(1) } }),
        ),
      ),
    ).toBe(true)
    const inputs = value.material.inputs.map((input, index) =>
      index === 0 ? { ...input, ingestionTimeNanos: String(BigInt(value.computedAtMs + 6000) * 1_000_000n) } : input,
    )
    expect(
      Result.isFailure(decodeRollingMarketFeature(rehash({ ...value, material: { ...value.material, inputs } }))),
    ).toBe(true)
  })

  test('corrected and mixed-feed raw bars cannot join an old feature', () => {
    const changed = bars().map((bar, index) => (index === 12 ? { ...bar, high: 200, sourceOffset: '100' } : bar))
    expect(Result.getOrThrow(featureMatchesBars(feature(), changed))).toBe(false)
    const mixed = bars().map((bar): IntradayBar => ({ ...bar, feed: 'sip', delayClass: 'real_time_consolidated' }))
    expect(Result.getOrThrow(featureMatchesBars(feature(), mixed))).toBe(false)
  })

  test('preserves offsets larger than JavaScript safe integers', () => {
    const value = feature()
    const changed = rehash({
      ...value,
      material: {
        ...value.material,
        inputs: value.material.inputs.map((input) => ({
          ...input,
          sourceOffset: String(BigInt(input.sourceOffset) + 9_007_199_254_740_992n),
        })),
      },
    })
    expect(Result.getOrThrow(decodeRollingMarketFeature(changed)).material.inputs[0]?.sourceOffset).toBe(
      '9007199254740992',
    )
  })
})
