import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Result } from 'effect'

import { IntradaySnapshotPurpose } from '../src/market-data/intraday/model'
import type { KafkaProjectionCut } from '../src/market-data/streaming/kafka'
import { compactStreamingProjection } from '../src/market-data/streaming/query-cut'
import { constructStreamingSnapshot } from '../src/market-data/streaming/snapshot'
import { defaultIntradayMomentumProtocolDocument } from '../src/strategy/intraday-momentum/protocol'
import { makeIntradayMomentumTestSnapshot } from '../src/strategy/intraday-momentum/test-support'
import { streamingFixtureFromRaw, streamingFixtureRequest } from '../src/testing/streaming-market-fixture'

const directory = process.argv[2]
if (directory === undefined) throw new Error('Usage: benchmark-intraday-pricing <baseline-bundle-directory>')
const baseCut: { compactStreamingProjection: typeof compactStreamingProjection } = await import(
  pathToFileURL(resolve(directory, 'query-cut.js')).href
)
const baseSnapshot: { constructStreamingSnapshot: typeof constructStreamingSnapshot } = await import(
  pathToFileURL(resolve(directory, 'snapshot.js')).href
)
const baseline = { ...baseCut, ...baseSnapshot }
const candidate = { compactStreamingProjection, constructStreamingSnapshot }

const { candidateSymbols: _candidates, candidateEvidencePolicy: _policy, ...defaults } = streamingFixtureRequest()
const request = {
  ...defaults,
  symbols: ['QQQ', 'SMH'],
  rangeStartAt: '2026-09-04T13:30:00.000Z',
  rangeEndAt: '2026-09-04T19:59:00.000Z',
  observedAt: '2026-09-04T19:59:02.000Z',
}
const raw = makeIntradayMomentumTestSnapshot(defaultIntradayMomentumProtocolDocument, request)
const pricing = {
  ...request,
  rangeStartAt: '2026-09-04T19:58:00.000Z',
  purpose: IntradaySnapshotPurpose.EntryPricing,
  minimumWatermarkLagMs: 0,
}
const { cut } = streamingFixtureFromRaw(raw, pricing)
assert.equal(cut.projection.bars.get('QQQ')?.length, 389)
assert.equal(cut.projection.bars.get('SMH')?.length, 389)

const read = (implementation: typeof candidate, query: typeof pricing, source: KafkaProjectionCut) => {
  const projection = Result.getOrThrow(implementation.compactStreamingProjection(source, query))
  return Result.getOrThrow(implementation.constructStreamingSnapshot({ ...source, projection }, query))
}
const percentile = (values: readonly number[], fraction: number) =>
  values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]
const iterations = 500
for (const query of [pricing, { ...pricing, purpose: IntradaySnapshotPurpose.Liquidation, symbols: ['SMH'] }]) {
  assert.equal(JSON.stringify(read(candidate, query, cut)), JSON.stringify(read(baseline, query, cut)))
  const samples = { baseline: new Array<number>(), candidate: new Array<number>() }
  for (let round = 0; round < 16; round++) {
    const order = round % 2 === 0 ? (['baseline', 'candidate'] as const) : (['candidate', 'baseline'] as const)
    for (const variant of order) {
      const implementation = variant === 'baseline' ? baseline : candidate
      const start = performance.now()
      for (let i = 0; i < iterations; i++) read(implementation, query, cut)
      const millisecondsPerRead = (performance.now() - start) / iterations
      if (round >= 4) samples[variant].push(millisecondsPerRead)
    }
  }
  console.log({
    purpose: query.purpose,
    symbols: query.symbols,
    barsPerSymbol: 389,
    medianMsPerRead: { baseline: percentile(samples.baseline, 0.5), candidate: percentile(samples.candidate, 0.5) },
    p95MsPerRead: { baseline: percentile(samples.baseline, 0.95), candidate: percentile(samples.candidate, 0.95) },
  })
}
