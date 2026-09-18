import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { canonicalHashV1 } from '../../hash'
import { streamingFixture, streamingFixtureFromRaw } from '../../testing/streaming-market-fixture'
import { makeIntradayMomentumTestSnapshot } from '../../strategy/intraday-momentum/test-support'
import { featureBarContentHash } from '../features/contract'
import { persistIntradayRecordRows } from '../intraday/verification'
import { intradayInstantNanos } from '../intraday/time'
import { incorporateMarketRecord, incorporateRecordedMarketValue } from './projection'
import { constructStreamingSnapshot } from './snapshot'
import { reproduceStreamingSnapshot } from './replay'

for (const symbol of ['AAPL', 'SPY']) {
  test(`accepts normal corrected bars for ${symbol} independently of quote age`, () => {
    const { protocol, query } = streamingFixture()
    const raw = makeIntradayMomentumTestSnapshot(protocol, query, { AAPL: 0.02, AMZN: 0.01 })
    const first = raw.bars.find((bar) => bar.symbol === symbol)
    if (first === undefined) throw new Error('Missing test bar')
    const bars = raw.bars.map((bar) =>
      bar === first
        ? {
            ...bar,
            channel: 'updatedBars' as const,
            ingestedAt: new Date(Date.parse(bar.eventAt) + 90_000).toISOString(),
          }
        : bar,
    )
    const { snapshot, rows } = streamingFixtureFromRaw({ ...raw, bars }, query)
    expect(snapshot.manifest.candidateExclusions).toEqual([])
    expect(Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows)).manifest.snapshotId).toBe(
      snapshot.manifest.snapshotId,
    )
  })
}

test('identical late republications preserve timeliness and exact feature lineage after revision eviction', () => {
  const { cut, query, protocol, snapshot: initial } = streamingFixture()
  const first = initial.bars.find((bar) => bar.symbol === 'SPY')
  const feature = initial.manifest.streaming.features.find((receipt) => receipt.value.material.symbol === 'SPY')
  if (first === undefined || feature === undefined) throw new Error('Missing benchmark fixtures')
  const universe = {
    universeId: protocol.universeId,
    universeSymbolHash: protocol.universeSymbolHash,
    symbols: protocol.universe,
    topics: { ...protocol.sourceTopics, features: protocol.streamingInput.featureTopic },
  }
  let projection = cut.projection
  let last = first
  for (let index = 0; index < 6; index++) {
    last = {
      ...first,
      sourceOffset: String(10_000 + index),
      ingestedAt: new Date(Date.parse(first.eventAt) + (20 + index) * 60_000).toISOString(),
    }
    projection = incorporateRecordedMarketValue(projection, last, universe, Date.parse(query.observedAt) + index + 1)
  }
  const material = {
    ...feature.value.material,
    inputs: feature.value.material.inputs.map((input) =>
      input.eventTimeNanos === intradayInstantNanos(first.eventAt).toString()
        ? {
            ...input,
            sourceOffset: last.sourceOffset,
            ingestionTimeNanos: intradayInstantNanos(last.ingestedAt).toString(),
            contentHash: Result.getOrThrow(featureBarContentHash(last)),
          }
        : input,
    ),
  }
  const replacement = {
    ...feature.value,
    material,
    featureId: canonicalHashV1(material),
    computedAtMs: Date.parse(query.observedAt) + 7,
  }
  projection = incorporateMarketRecord(
    projection,
    { topic: universe.topics.features, partition: 0, offset: '10000', value: JSON.stringify(replacement) },
    universe,
    replacement.computedAtMs,
  )
  const positions = [...projection.offsets]
    .map(([key, offset]) => ({
      topic: key.slice(0, key.lastIndexOf(':')),
      partition: Number(key.slice(key.lastIndexOf(':') + 1)),
      offset: String(BigInt(offset) + 1n),
    }))
    .sort((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition)
  const snapshot = Result.getOrThrow(
    constructStreamingSnapshot(
      { ...cut, projection, positions },
      {
        ...query,
        observedAt: new Date(replacement.computedAtMs).toISOString(),
      },
    ),
  )
  expect(snapshot.manifest.candidateExclusions).toEqual([])
  expect(snapshot.bars.find((bar) => bar.symbol === 'SPY' && bar.eventAt === first.eventAt)?.sourceOffset).toBe(
    last.sourceOffset,
  )
  expect(
    snapshot.manifest.streaming.features.find((receipt) => receipt.value.material.symbol === 'SPY')?.value.featureId,
  ).toBe(replacement.featureId)
  expect(
    Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, persistIntradayRecordRows(snapshot))).manifest
      .snapshotId,
  ).toBe(snapshot.manifest.snapshotId)
})
