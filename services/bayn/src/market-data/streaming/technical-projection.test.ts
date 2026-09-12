import { summarizeStreamingSymbol } from '../../streaming-diagnostics-command'
import { expect, test } from 'bun:test'
import { Result } from 'effect'
import technicalFixture from '../features/fixtures/technical-indicators-v1.json'
import rollingFixture from '../features/fixtures/rolling-price-v1.json'
import { decodeTechnicalMarketFeature } from '../features/technical-contract'
import { decodeRollingMarketFeature } from '../features/contract'
import { canonicalHashV1 } from '../../hash'
import type { IntradayBar, IntradaySnapshotQuery } from '../intraday/model'
import { persistIntradayRecordRows } from '../intraday/verification'
import {
  emptyStreamingProjection,
  incorporateMarketRecord,
  incorporateRecordedMarketValue,
  type StreamingProjection,
} from './projection'
import { selectStreamingInputs } from './inputs'
import { constructSimulatedSnapshot, constructStreamingSnapshot } from './snapshot'
import { reproduceSimulatedSnapshot, reproduceStreamingSnapshot } from './replay'
import { advanceHistoricalMarketCursor, createHistoricalMarketCursor } from './historical'
import { KafkaBootstrapTimestampPolicy } from './bootstrap'

const feature = Result.getOrThrow(
  decodeTechnicalMarketFeature({ ...technicalFixture, computedAtMs: technicalFixture.material.windowEndMs + 1000 }),
)
const end = feature.material.windowEndMs
const start = end - 30 * 60_000
const observed = end + 3000
const topic = 'torghut.technical-features.v1'
const universe = {
  universeId: feature.material.universeId,
  universeSymbolHash: feature.material.universeSymbolHash,
  symbols: ['AAPL'],
  topics: {
    bars: 'torghut.bars.1m.v1',
    quotes: 'torghut.quotes.v1',
    trades: 'torghut.trades.v1',
    features: 'torghut.market-features.v1',
    technicalFeatures: topic,
  },
}
const bars: IntradayBar[] = feature.material.inputs.slice(-30).map((input) => ({
  provider: 'alpaca',
  feed: 'iex',
  delayClass: 'real_time_exchange_only',
  marketSession: 'regular',
  universeId: universe.universeId,
  universeSymbolHash: universe.universeSymbolHash,
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
const rollingMaterial = {
  ...rollingFixture.material,
  windowStartMs: start,
  windowEndMs: end,
  inputs: feature.material.inputs.slice(-30),
  values: {
    referencePriceMicros: '100000000',
    rangeHighPriceMicros: '101000000',
    rangeLowPriceMicros: '99000000',
    lastClosePriceMicros: '100000000',
    totalVolumeMicros: '60000000',
  },
}
const rolling = Result.getOrThrow(
  decodeRollingMarketFeature({
    ...rollingFixture,
    material: rollingMaterial,
    featureId: canonicalHashV1(rollingMaterial),
    computedAtMs: end + 1000,
  }),
)
const calendar = {
  schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
  source: 'alpaca-v2-calendar' as const,
  requestedRange: { start: '2026-09-11', end: '2026-09-11' },
  timeZone: 'UTC' as const,
  sessions: [{ date: '2026-09-11', openAt: '2026-09-11T13:30:00.000Z', closeAt: '2026-09-11T20:00:00.000Z' }],
}
const query: IntradaySnapshotQuery = {
  sessionDate: '2026-09-11',
  calendar: { ...calendar, normalizedResponseHash: canonicalHashV1(calendar) },
  rangeStartAt: new Date(start).toISOString(),
  rangeEndAt: new Date(end).toISOString(),
  observedAt: new Date(observed).toISOString(),
  universeId: universe.universeId,
  universeSymbolHash: universe.universeSymbolHash,
  universe: universe.symbols,
  symbols: universe.symbols,
  feed: 'iex',
  delayClass: 'real_time_exchange_only',
  sourceTopics: { bars: universe.topics.bars, quotes: universe.topics.quotes, trades: universe.topics.trades },
  maximumQuoteAgeMs: 2000,
  minimumWatermarkLagMs: 2000,
}
const record = (offset = '0', value: unknown = feature) => ({
  topic,
  partition: 0,
  offset,
  timestampMs: feature.computedAtMs,
  value: JSON.stringify(value),
})
const initial = () => {
  let state = emptyStreamingProjection('technical-test', topic)
  for (const bar of bars) state = incorporateRecordedMarketValue(state, bar, universe, end + 2000)
  for (const channel of ['quotes', 'trades'] as const)
    state = incorporateMarketRecord(
      state,
      {
        topic: universe.topics[channel],
        partition: 0,
        offset: '0',
        value: JSON.stringify({
          provider: 'alpaca',
          feed: 'iex',
          delayClass: 'real_time_exchange_only',
          marketSession: 'regular',
          channel,
          symbol: 'AAPL',
          eventTs: new Date(end + 2000).toISOString(),
          ingestTs: new Date(end + 2000).toISOString(),
          version: 2,
          payload: {
            t: new Date(end + 2000).toISOString(),
            ...(channel === 'quotes' ? { bp: 100, ap: 100.01, bs: 100, as: 100 } : { p: 100, s: 100 }),
          },
        }),
      },
      universe,
      end + 2000,
    )
  return incorporateMarketRecord(
    state,
    { topic: universe.topics.features, partition: 0, offset: '0', value: JSON.stringify(rolling) },
    universe,
    end + 2000,
  )
}
const cut = (projection: StreamingProjection) => {
  const positions = Object.values(universe.topics)
    .sort()
    .map((source) => ({
      topic: source,
      partition: 0,
      offset: String(BigInt(projection.offsets.get(`${source}:0`) ?? '-1') + 1n),
    }))
  return {
    projection,
    positions,
    bootstrap: {
      schemaVersion: 'bayn.kafka-bootstrap.v1' as const,
      epoch: projection.epoch,
      observedAtMs: end + 1000,
      lowerTimestampMs: start - 5000,
      timestampPolicy: KafkaBootstrapTimestampPolicy.ProducerClock,
      partitions: positions.map((position) => ({
        topic: position.topic,
        partition: position.partition,
        logStartOffset: '0',
        startOffset: '0',
        endOffset: position.offset,
      })),
    },
  }
}
const select = (state: StreamingProjection) => Result.getOrThrow(selectStreamingInputs(state, query))

test('optional technical inputs preserve baseline data when absent, malformed or late', () => {
  const base = initial()
  const selected = select(base)
  expect(selected.technical?.unavailableSymbols).toEqual(['AAPL'])
  const bad = incorporateMarketRecord(base, record('0', { broken: true }), universe, end + 2200)
  expect(bad.rejections.size).toBe(0)
  expect(bad.technicalRejections).toHaveLength(1)
  expect(select(bad).featureReceipts).toEqual(selected.featureReceipts)
  expect(select(bad).bars).toEqual(selected.bars)
  const late = incorporateMarketRecord(base, record(), universe, observed + 1)
  expect(select(late).technical?.features).toHaveLength(0)
  const snapshot = Result.getOrThrow(constructStreamingSnapshot(cut(bad), query))
  expect(
    Result.getOrThrow(
      reproduceStreamingSnapshot(snapshot.manifest, Result.getOrThrow(persistIntradayRecordRows(snapshot))),
    ).manifest,
  ).toEqual(snapshot.manifest)
})

test('exact technical suffix joins as-of and immutable conflicts remove optional evidence', () => {
  const base = initial()
  const ready = incorporateMarketRecord(base, record(), universe, end + 2200)
  expect(select(ready).technical?.features[0]?.value).toEqual(feature)
  expect(select(ready).technical?.unavailableSymbols).toEqual([])
  expect(summarizeStreamingSymbol(ready, 'AAPL').technical?.matchedFeatures[0]).toMatchObject({
    featureId: feature.featureId,
    matchedRawBars: 30,
    values: feature.material.values,
  })
  const duplicate = incorporateMarketRecord(ready, record('1'), universe, end + 2300)
  expect(duplicate.technicalFeatures.get('AAPL')).toHaveLength(1)
  expect(select(duplicate).technical?.features[0]?.availableAtMs).toBe(end + 2200)
  const conflict = incorporateMarketRecord(
    ready,
    record('0', { ...feature, producerRevision: 'conflict' }),
    universe,
    end + 2400,
  )
  expect(select(conflict).technical?.features).toHaveLength(0)
  expect(summarizeStreamingSymbol(conflict, 'AAPL').technical?.matchedFeatures).toHaveLength(0)
  const malformed = incorporateMarketRecord(ready, { ...record('2'), value: '{' }, universe, end + 2400)
  const discarded = { ...ready, technicalRejectionsDiscardedThroughMs: end + 2200 }
  for (const invalidated of [malformed, discarded]) {
    expect(select(invalidated).technical?.features).toHaveLength(0)
    expect(summarizeStreamingSymbol(invalidated, 'AAPL').technical?.matchedFeatures).toHaveLength(0)
  }
  expect(select(conflict).featureReceipts).toEqual(select(base).featureReceipts)
  const wrong = { ...feature.material, universeId: 'other' }
  expect(
    select(
      incorporateMarketRecord(
        base,
        record('0', { ...feature, material: wrong, featureId: canonicalHashV1(wrong) }),
        universe,
        end + 2200,
      ),
    ).technical?.features,
  ).toHaveLength(0)
  const corrected = {
    ...feature.material,
    inputs: feature.material.inputs.map((input, index) => (index === 60 ? { ...input, sourceOffset: '9999' } : input)),
  }
  expect(
    select(
      incorporateMarketRecord(
        base,
        record('0', { ...feature, material: corrected, featureId: canonicalHashV1(corrected) }),
        universe,
        end + 2200,
      ),
    ).technical?.features,
  ).toHaveLength(0)
})

test('a new technical revision supersedes the previous value before matching raw correction arrives', () => {
  const ready = incorporateMarketRecord(initial(), record(), universe, end + 2200)
  const material = {
    ...feature.material,
    inputs: feature.material.inputs.map((input, index) => (index === 60 ? { ...input, sourceOffset: '9999' } : input)),
  }
  const corrected = { ...feature, material, featureId: canonicalHashV1(material) }
  const waiting = incorporateMarketRecord(ready, record('1', corrected), universe, end + 2500)
  expect(select(waiting).technical?.features).toHaveLength(0)
  expect(select(waiting).technical?.unavailableSymbols).toEqual(['AAPL'])
  expect(summarizeStreamingSymbol(waiting, 'AAPL').technical?.matchedFeatures).toHaveLength(0)
  const earlier = Result.getOrThrow(
    selectStreamingInputs(waiting, { ...query, observedAt: new Date(end + 2400).toISOString() }),
  )
  expect(earlier.technical?.features[0]?.value.featureId).toBe(feature.featureId)
  const original = bars.at(-1)
  if (original === undefined) throw new Error('missing final bar')
  const correctedBar = { ...original, sourceOffset: '9999' }
  const updatedRaw = incorporateRecordedMarketValue(waiting, correctedBar, universe, end + 2600)
  const updatedRollingMaterial = { ...rollingMaterial, inputs: material.inputs.slice(-30) }
  const updated = incorporateMarketRecord(
    updatedRaw,
    {
      topic: universe.topics.features,
      partition: 0,
      offset: '1',
      value: JSON.stringify({
        ...rolling,
        material: updatedRollingMaterial,
        featureId: canonicalHashV1(updatedRollingMaterial),
      }),
    },
    universe,
    end + 2700,
  )
  expect(select(updated).technical?.features[0]?.value.featureId).toBe(corrected.featureId)
  expect(summarizeStreamingSymbol(updated, 'AAPL').technical?.matchedFeatures.map((value) => value.featureId)).toEqual([
    corrected.featureId,
  ])
})

test('rolling regeneration time cannot admit technical records computed after their arrival', () => {
  const regeneratedAtMs = end + 86_400_000
  const source = Result.getOrThrow(createHistoricalMarketCursor('d'.repeat(64), universe, regeneratedAtMs))
  const rollingCursor = Result.getOrThrow(
    advanceHistoricalMarketCursor(source, {
      availableAtMs: observed,
      record: {
        topic: universe.topics.features,
        partition: 0,
        offset: '0',
        value: JSON.stringify({ ...rolling, computedAtMs: regeneratedAtMs }),
      },
    }),
  )
  expect(rollingCursor.projection.features.get('AAPL')).toHaveLength(1)
  const rejected = Result.getOrThrow(
    advanceHistoricalMarketCursor(rollingCursor, {
      availableAtMs: observed + 1,
      record: {
        ...record(),
        timestampMs: regeneratedAtMs,
        value: JSON.stringify({ ...feature, computedAtMs: regeneratedAtMs }),
      },
    }),
  )
  expect(rejected.projection.technicalFeatures.size).toBe(0)
  expect(rejected.projection.technicalRejections[0]?.reason).toBe('technical-identity-or-availability')
  expect(rejected.projection.features.get('AAPL')).toHaveLength(1)
  const accepted = Result.getOrThrow(
    advanceHistoricalMarketCursor(rejected, { availableAtMs: observed + 2, record: record('1') }),
  )
  expect(accepted.projection.technicalFeatures.get('AAPL')).toHaveLength(1)
})

test('live and simulated snapshots reproduce technical payload and provenance, rejecting tampering', () => {
  const ready = incorporateMarketRecord(initial(), record(), universe, end + 2200)
  const snapshot = Result.getOrThrow(constructStreamingSnapshot(cut(ready), query))
  const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
  expect(Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows)).manifest).toEqual(snapshot.manifest)
  const technical = snapshot.manifest.streaming.technical
  if (technical === undefined) throw new Error('missing optional evidence')
  for (const changed of [
    { ...technical, topic: 'other' },
    { ...technical, features: [] },
    { ...technical, features: technical.features.map((receipt) => ({ ...receipt, availableAtMs: observed + 1 })) },
    { ...technical, features: technical.features.map((receipt) => ({ ...receipt, offset: '99' })) },
    { ...technical, unavailableSymbols: ['AAPL'] },
  ])
    expect(
      Result.isFailure(
        reproduceStreamingSnapshot(
          { ...snapshot.manifest, streaming: { ...snapshot.manifest.streaming, technical: changed } },
          rows,
        ),
      ),
    ).toBe(true)
  const source = {
    runId: 'a'.repeat(64),
    sourceManifestHash: 'b'.repeat(64),
    featureTopic: universe.topics.features,
    technicalFeatureTopic: topic,
    deliveryModel: {
      schemaVersion: 'bayn.supplied-arrival-times.v1' as const,
      description: 'literal test availability',
      tieBreak: 'availability-topic-partition-offset' as const,
    },
  }
  const empty = Result.getOrThrow(createHistoricalMarketCursor(source.runId, universe, undefined, source))
  const cursor = {
    ...empty,
    projection: { ...ready, epoch: empty.projection.epoch, availabilityMode: 'simulated' as const },
  }
  const simulated = Result.getOrThrow(constructSimulatedSnapshot(cursor, source, query))
  expect(Result.getOrThrow(reproduceSimulatedSnapshot(simulated.manifest, rows)).manifest).toEqual(simulated.manifest)
  expect(
    Result.isFailure(constructSimulatedSnapshot(cursor, { ...source, technicalFeatureTopic: 'other' }, query)),
  ).toBe(true)
})
