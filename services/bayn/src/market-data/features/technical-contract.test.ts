import { expect, test } from 'bun:test'
import { Result } from 'effect'
import fixture from './fixtures/technical-indicators-v1.json'
import { canonicalHashV1 } from '../../hash'
import type { IntradayBar } from '../intraday/model'
import { decodeTechnicalMarketFeature, technicalFeatureMatchesBars, TechnicalReadiness } from './technical-contract'

const rehash = (material: typeof fixture.material) => ({ ...fixture, material, featureId: canonicalHashV1(material) })
const rawBars = (): IntradayBar[] =>
  fixture.material.inputs.map((input) => ({
    provider: 'alpaca',
    feed: 'iex',
    delayClass: 'real_time_exchange_only',
    marketSession: 'regular',
    universeId: fixture.material.universeId,
    universeSymbolHash: fixture.material.universeSymbolHash,
    symbol: 'AAPL',
    channel: 'bars',
    final: true,
    schemaVersion: 1,
    eventAt: new Date(Number(BigInt(input.eventTimeNanos) / 1_000_000n)).toISOString(),
    ingestedAt: new Date(Number(BigInt(input.ingestionTimeNanos) / 1_000_000n)).toISOString(),
    sourceTopic: input.sourceTopic,
    sourcePartition: input.sourcePartition,
    sourceOffset: input.sourceOffset,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 2,
    vwap: 99.5,
    tradeCount: '2',
  }))

test('Kotlin fixture decodes with exact definition hash, readiness and units', () => {
  const feature = Result.getOrThrow(decodeTechnicalMarketFeature(fixture))
  expect<unknown>(feature).toEqual(fixture)
  expect(feature.material.inputs).toHaveLength(61)
  expect(feature.material.values.ema12PriceMicros).toEqual({ status: TechnicalReadiness.Ready, value: '100000000' })
  expect(feature.material.values.vwapSessionPriceMicros.value).toBe('99500000')
  expect(feature.material.values.macdPriceMicros.value).toBe('0')
  expect(feature.material.values.realizedVolatility60ReturnsPpm.value).toBe('0')
})

test('technical producer provenance joins the exact current raw window', () => {
  const feature = Result.getOrThrow(decodeTechnicalMarketFeature(fixture))
  const bars = rawBars().slice(-30)
  expect(Result.getOrThrow(technicalFeatureMatchesBars(feature, bars))).toBe(true)
  expect(Result.getOrThrow(technicalFeatureMatchesBars(feature, bars.toReversed()))).toBe(true)
  expect(
    Result.getOrThrow(
      technicalFeatureMatchesBars(
        feature,
        bars.map((bar, index) => (index === 0 ? { ...bar, sourceOffset: '999' } : bar)),
      ),
    ),
  ).toBe(false)
  expect(
    Result.getOrThrow(
      technicalFeatureMatchesBars(
        feature,
        bars.map((bar) => ({ ...bar, close: 100.1 })),
      ),
    ),
  ).toBe(false)
  expect(Result.getOrThrow(technicalFeatureMatchesBars(feature, rawBars().slice(0, 30)))).toBe(false)
})

test('content, definition, timing, input and readiness forgeries fail even when rehashed', () => {
  const material = fixture.material
  const values = material.values
  const bad = [
    { ...fixture, featureId: 'a'.repeat(64) },
    rehash({ ...material, definitionHash: 'a'.repeat(64) }),
    rehash({ ...material, windowStartMs: material.windowStartMs + 60_000 }),
    rehash({ ...material, sessionDate: '2026-09-12' }),
    rehash({ ...material, inputs: material.inputs.toReversed() }),
    rehash({ ...material, inputs: material.inputs.slice(0, -1) }),
    rehash({ ...material, values: { ...values, ema12PriceMicros: { status: 'WARMING', value: '100000000' } } }),
    rehash({ ...material, values: { ...values, rsi14Micros: { status: 'READY', value: '100000001' } } }),
    rehash({ ...material, values: { ...values, realizedVolatility60ReturnsPpm: { status: 'READY', value: '-1' } } }),
    { ...fixture, computedAtMs: material.windowEndMs - 5001 },
    { ...fixture, unexpected: 'field' },
  ]
  for (const value of bad) expect(Result.isFailure(decodeTechnicalMarketFeature(value))).toBe(true)
})

test('gaps make recursive values unavailable while a contiguous tail can remain ready', () => {
  const material = fixture.material
  const gap = { status: TechnicalReadiness.Gap, value: null }
  const changed = {
    ...material,
    inputs: material.inputs.slice(1),
    values: {
      ...material.values,
      ema12PriceMicros: gap,
      ema26PriceMicros: gap,
      macdPriceMicros: gap,
      macdSignalPriceMicros: gap,
      macdHistogramPriceMicros: gap,
      rsi14Micros: gap,
      weightedCloseSessionPriceMicros: gap,
      vwapSessionPriceMicros: gap,
      realizedVolatility60ReturnsPpm: { status: TechnicalReadiness.Warming, value: null },
    },
  }
  expect(
    Result.isSuccess(
      decodeTechnicalMarketFeature({ ...fixture, material: changed, featureId: canonicalHashV1(changed) }),
    ),
  ).toBe(true)
})
