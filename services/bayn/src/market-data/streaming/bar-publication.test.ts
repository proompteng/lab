import { BarPublicationPolicy } from '../intraday/bar-publication'
import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { canonicalHashV1 } from '../../hash'
import { streamingFixture, streamingFixtureFromRaw } from '../../testing/streaming-market-fixture'
import { makeIntradayMomentumTestSnapshot } from '../../strategy/intraday-momentum/test-support'
import { featureBarContentHash } from '../features/contract'
import { persistIntradayRecordRows } from '../intraday/verification'
import { intradayInstantNanos } from '../intraday/time'
import { incorporateMarketRecord, incorporateRecordedMarketValue } from './projection'
import { constructSimulatedSnapshot, constructStreamingSnapshot } from './snapshot'
import { simulationFixture } from '../../testing/simulated-streaming-fixture'
import { reproduceSimulatedSnapshot, reproduceStreamingSnapshot } from './replay'

for (const symbol of ['AAPL', 'SPY']) {
  test(`accepts normal corrected bars for ${symbol} independently of quote age`, () => {
    const { protocol, query } = streamingFixture()
    const raw = makeIntradayMomentumTestSnapshot(
      protocol,
      { ...query, archiveWatermarks: [] },
      { AAPL: 0.02, AMZN: 0.01 },
    )
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
  expect(
    Result.isFailure(
      constructStreamingSnapshot(
        { ...cut, projection: { ...projection, features: cut.projection.features }, positions },
        { ...query, observedAt: new Date(replacement.computedAtMs).toISOString() },
      ),
    ),
  ).toBe(true)
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
    Result.getOrThrow(
      reproduceStreamingSnapshot(snapshot.manifest, Result.getOrThrow(persistIntradayRecordRows(snapshot))),
    ).manifest.snapshotId,
  ).toBe(snapshot.manifest.snapshotId)
  const publications = snapshot.manifest.streaming.barPublications
  if (publications === undefined || publications.length !== 1) throw new Error('Missing publication witness')
  const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
  expect(
    Result.isFailure(
      reproduceStreamingSnapshot(
        {
          ...snapshot.manifest,
          streaming: {
            ...snapshot.manifest.streaming,
            barPublications: publications.map((publication) => ({
              ...publication,
              row: { ...publication.row, close: 999 },
            })),
          },
        },
        rows,
      ),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      reproduceStreamingSnapshot(
        {
          ...snapshot.manifest,
          streaming: {
            ...snapshot.manifest.streaming,
            barPublications: publications.map((publication) => ({
              ...publication,
              receipt: { ...publication.receipt, availableAtMs: replacement.computedAtMs + 1 },
            })),
          },
        },
        rows,
      ),
    ),
  ).toBe(true)
  const simulation = simulationFixture()
  const simulated = Result.getOrThrow(
    constructSimulatedSnapshot(
      {
        ...simulation.cursor,
        lastArrival: null,
        projection: { ...projection, availabilityMode: 'simulated', epoch: simulation.cursor.projection.epoch },
      },
      simulation.source,
      { ...query, observedAt: new Date(replacement.computedAtMs).toISOString() },
    ),
  )
  expect(Result.getOrThrow(reproduceSimulatedSnapshot(simulated.manifest, rows)).manifest).toEqual(simulated.manifest)

  const changed = {
    ...last,
    volume: last.volume + 1,
    sourceOffset: '10006',
    ingestedAt: new Date(Date.parse(first.eventAt) + 26 * 60_000).toISOString(),
  }
  const changedAt = replacement.computedAtMs + 1
  const changedMaterial = {
    ...replacement.material,
    inputs: replacement.material.inputs.map((input) =>
      input.eventTimeNanos === intradayInstantNanos(changed.eventAt).toString()
        ? {
            ...input,
            sourceOffset: changed.sourceOffset,
            ingestionTimeNanos: intradayInstantNanos(changed.ingestedAt).toString(),
            contentHash: Result.getOrThrow(featureBarContentHash(changed)),
          }
        : input,
    ),
    values: {
      ...replacement.material.values,
      totalVolumeMicros: String(BigInt(replacement.material.values.totalVolumeMicros) + 1_000_000n),
    },
  }
  const changedProjection = incorporateMarketRecord(
    incorporateRecordedMarketValue(projection, changed, universe, changedAt),
    {
      topic: universe.topics.features,
      partition: 0,
      offset: '10001',
      value: JSON.stringify({
        ...replacement,
        material: changedMaterial,
        featureId: canonicalHashV1(changedMaterial),
        computedAtMs: changedAt,
      }),
    },
    universe,
    changedAt,
  )
  const rejected = constructStreamingSnapshot(
    {
      ...cut,
      projection: changedProjection,
      positions: positions.map((position) =>
        position.topic === universe.topics.bars || position.topic === universe.topics.features
          ? { ...position, offset: '20000' }
          : position,
      ),
    },
    { ...query, observedAt: new Date(changedAt).toISOString() },
  )
  expect(Result.isFailure(rejected)).toBe(true)
  if (Result.isFailure(rejected))
    expect(rejected.failure).toMatchObject({ reason: 'freshness', facts: { symbol: 'SPY' } })
})

test('legacy recorded cuts retain the old quote-linked bar timing policy', () => {
  const { cut, query } = streamingFixture()
  const snapshot = Result.getOrThrow(constructStreamingSnapshot(cut, query, BarPublicationPolicy.LegacyQuoteAge))
  expect(snapshot.manifest.streaming.barPublicationPolicy).toBeUndefined()
  expect(
    Result.getOrThrow(
      reproduceStreamingSnapshot(snapshot.manifest, Result.getOrThrow(persistIntradayRecordRows(snapshot))),
    ).manifest,
  ).toEqual(snapshot.manifest)
})

for (const scenario of [
  'late-original',
  'late-correction',
  'future-publication',
  'premature',
  'non-final',
  'stale-quote',
] as const) {
  test(`bar publication policy still rejects ${scenario}`, () => {
    const { protocol, query } = streamingFixture()
    const raw = makeIntradayMomentumTestSnapshot(protocol, { ...query, archiveWatermarks: [] }, {})
    const first = raw.bars.find((bar) => bar.symbol === 'SPY')
    if (first === undefined) throw new Error('Missing benchmark')
    const delay = scenario === 'late-correction' ? 105_001 : scenario === 'premature' ? 50_000 : 75_001
    const bars = raw.bars.map((bar) =>
      bar !== first || scenario === 'stale-quote'
        ? bar
        : {
            ...bar,
            channel: scenario === 'late-correction' ? ('updatedBars' as const) : ('bars' as const),
            final: scenario !== 'non-final',
            ingestedAt: new Date(
              scenario === 'future-publication'
                ? Date.parse(query.observedAt) + 10_000
                : Date.parse(bar.eventAt) + delay,
            ).toISOString(),
          },
    )
    const quotes =
      scenario !== 'stale-quote'
        ? raw.quotes
        : raw.quotes.map((quote) =>
            quote.symbol !== 'SPY'
              ? quote
              : {
                  ...quote,
                  eventAt: new Date(Date.parse(query.observedAt) - protocol.maximumQuoteAgeMs - 1).toISOString(),
                },
          )
    expect(() => streamingFixtureFromRaw({ ...raw, bars, quotes }, query)).toThrow()
  })
}
