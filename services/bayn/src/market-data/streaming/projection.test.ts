import { replayHistoricalMarketArrivals } from './historical'
import { reproduceStreamingSnapshot } from './replay'
import { persistIntradayRecordRows } from '../intraday/verification'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Result } from 'effect'

import { constructStreamingSnapshot } from './snapshot'
import { KafkaBootstrapTimestampPolicy } from './bootstrap'
import type { KafkaProjectionCut } from './kafka'
import type { IntradaySnapshotQuery } from '../intraday/model'
import { canonicalHashV1 } from '../../hash'
import { decodeRollingMarketFeature, featureBarContentHash } from '../features/contract'
import { decodeRawMarketRecord, RawMarketEventKind, type KafkaMarketRecord, type StreamingUniverse } from './raw-events'
import { emptyStreamingProjection, incorporateMarketRecord, selectStreamingSymbolInputs } from './projection'

const fixture: unknown = JSON.parse(
  readFileSync(new URL('../features/fixtures/rolling-price-v1.json', import.meta.url), 'utf8'),
)
const feature = Result.getOrThrow(decodeRollingMarketFeature(fixture))
const start = feature.material.windowStartMs
const end = feature.material.windowEndMs
const universe: StreamingUniverse = {
  universeId: feature.material.universeId,
  universeSymbolHash: feature.material.universeSymbolHash,
  symbols: ['AAPL'],
  topics: {
    bars: 'torghut.bars.1m.v1',
    quotes: 'torghut.quotes.v1',
    trades: 'torghut.trades.v1',
    features: 'torghut.market-features.v1',
  },
}
const rawRecord = (
  channel: 'bars' | 'quotes' | 'trades',
  offset: number,
  at: number,
  payload: object,
): KafkaMarketRecord => ({
  topic: universe.topics[channel],
  partition: 0,
  offset: String(offset),
  value: JSON.stringify({
    provider: 'alpaca',
    feed: 'iex',
    delayClass: 'real_time_exchange_only',
    marketSession: 'regular',
    channel,
    symbol: 'AAPL',
    eventTs: new Date(at).toISOString(),
    ingestTs: new Date(channel === 'bars' ? at + 61_000 : at).toISOString(),
    version: 2,
    isFinal: true,
    payload: { ...payload, t: new Date(at).toISOString() },
  }),
})
const barRecord = (index: number) =>
  rawRecord('bars', index, start + index * 60_000, {
    o: 100 + index,
    h: 102 + index,
    l: 99 + index,
    c: 101 + index,
    v: 10.25,
    vw: 100.5 + index,
    n: 2,
  })
const quote = rawRecord('quotes', 1, end + 2000, { bp: 130, ap: 131, bs: 100, as: 100 })
const trade = rawRecord('trades', 1, end + 2000, { p: 130, s: 100 })
const featureRecord: KafkaMarketRecord = {
  topic: universe.topics.features,
  partition: 0,
  offset: '0',
  value: JSON.stringify(feature),
}
const incorporate = (records: readonly KafkaMarketRecord[], available = end + 3000) =>
  records.reduce(
    (state, record) => incorporateMarketRecord(state, record, universe, available),
    emptyStreamingProjection('test-epoch'),
  )
const raw = () => [...Array.from({ length: 30 }, (_, index) => barRecord(index)), quote, trade]
const select = (state: ReturnType<typeof incorporate>, at = end + 3000) =>
  selectStreamingSymbolInputs(state, 'AAPL', start, end, at)

describe('streaming raw and rolling feature projection', () => {
  test('joins the Kotlin feature only after its exact raw inputs are incorporated', () => {
    let state = incorporate([featureRecord, quote, trade])
    expect(Result.isFailure(select(state))).toBe(true)
    for (let index = 0; index < 30; index++)
      state = incorporateMarketRecord(state, barRecord(index), universe, end + 3000)
    const inputs = Result.getOrThrow(select(state))
    expect(inputs.feature.value.featureId).toBe(feature.featureId)
    expect(inputs.bars).toHaveLength(30)
    expect(inputs.quote.askPrice).toBe(131)
  })

  test('feature receipt controls eligibility independently of computation time', () => {
    const state = incorporate([...raw(), featureRecord], end + 5000)
    expect(Result.isFailure(select(state, end + 4000))).toBe(true)
    expect(Result.isSuccess(select(state, end + 5000))).toBe(true)
  })

  test('raw-first and feature-first arrivals reach the same normalized inputs', () => {
    const first = Result.getOrThrow(select(incorporate([featureRecord, ...raw()])))
    const last = Result.getOrThrow(select(incorporate([...raw(), featureRecord])))
    expect(first.bars).toEqual(last.bars)
    expect(first.feature.value).toEqual(last.feature.value)
    expect(first.feature.sequence).not.toBe(last.feature.sequence)
  })

  test('correction invalidates the old feature until its replacement arrives, and retries cannot reverse it', () => {
    const initial = incorporate([...raw(), featureRecord])
    const correctedRecord = rawRecord('bars', 30, start, { o: 100.5, h: 102, l: 99, c: 101, v: 10.25, vw: 100.5, n: 2 })
    const decoded = Result.getOrThrow(decodeRawMarketRecord(correctedRecord, universe))
    expect(decoded.kind).toBe(RawMarketEventKind.Bar)
    if (decoded.kind !== RawMarketEventKind.Bar) throw new Error('expected bar')
    const inputs = feature.material.inputs.map((input, index) =>
      index === 0
        ? {
            ...input,
            sourceOffset: '30',
            contentHash: Result.getOrThrow(featureBarContentHash(decoded.value)),
          }
        : input,
    )
    const material = {
      ...feature.material,
      inputs,
      values: { ...feature.material.values, referencePriceMicros: '100500000' },
    }
    const replacement = { ...feature, material, featureId: canonicalHashV1(material) }
    const corrected = incorporateMarketRecord(initial, correctedRecord, universe, end + 4000)
    expect(Result.isFailure(select(corrected, end + 4000))).toBe(true)
    const replaced = incorporateMarketRecord(
      corrected,
      { ...featureRecord, offset: '1', value: JSON.stringify(replacement) },
      universe,
      end + 5000,
    )
    expect(Result.getOrThrow(select(replaced, end + 5000)).feature.value.featureId).toBe(replacement.featureId)
    const retried = incorporateMarketRecord(replaced, { ...featureRecord, offset: '2' }, universe, end + 6000)
    expect(Result.getOrThrow(select(retried, end + 6000)).feature.value.featureId).toBe(replacement.featureId)
    expect(Result.getOrThrow(select(initial)).feature.value.featureId).toBe(feature.featureId)
  })

  test('duplicates preserve the original receipt and conflicting immutable payloads block the cut', () => {
    const initial = incorporate([...raw(), featureRecord])
    const duplicate = incorporateMarketRecord(initial, { ...featureRecord, offset: '1' }, universe, end + 4000)
    expect(Result.getOrThrow(select(duplicate, end + 4000)).feature.availableAtMs).toBe(end + 3000)
    const conflict = incorporateMarketRecord(
      initial,
      { ...quote, value: quote.value.replace('"ap":131', '"ap":132') },
      universe,
      end + 4000,
    )
    expect(Result.isFailure(select(conflict, end + 4000))).toBe(true)
  })

  test('a missing minute, mixed feed, or malformed source coordinate cannot provide a snapshot', () => {
    expect(
      Result.isFailure(
        select(
          incorporate([
            ...raw().filter((record) => record.topic !== universe.topics.bars || record.offset !== '10'),
            featureRecord,
          ]),
        ),
      ),
    ).toBe(true)
    const mixed = { ...quote, value: quote.value.replace('"iex"', '"sip"') }
    expect(
      Result.isFailure(select(incorporate([...raw().filter((record) => record !== quote), mixed, featureRecord]))),
    ).toBe(true)
    const invalid = incorporateMarketRecord(
      emptyStreamingProjection('invalid'),
      { ...quote, offset: 'bad' },
      universe,
      end + 3000,
    )
    expect(invalid.rejections.size).toBe(1)
    expect(invalid.offsets.size).toBe(0)
  })

  test('later corrections do not mutate an earlier persisted projection and raw retention is bounded', () => {
    const initial = incorporate([...raw(), featureRecord])
    let current = initial
    for (let index = 30; index < 200; index++)
      current = incorporateMarketRecord(current, barRecord(index), universe, start + (index + 2) * 60_000)
    expect(current.bars.get('AAPL')).toHaveLength(61)
    expect(Result.isSuccess(select(initial))).toBe(true)
  })
})

const calendarMaterial = {
  schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
  source: 'alpaca-v2-calendar' as const,
  requestedRange: { start: '2026-09-11', end: '2026-09-11' },
  timeZone: 'UTC' as const,
  sessions: [{ date: '2026-09-11', openAt: '2026-09-11T13:30:00.000Z', closeAt: '2026-09-11T20:00:00.000Z' }],
}
const query: IntradaySnapshotQuery = {
  sessionDate: '2026-09-11',
  calendar: { ...calendarMaterial, normalizedResponseHash: canonicalHashV1(calendarMaterial) },
  rangeStartAt: new Date(start).toISOString(),
  rangeEndAt: new Date(end).toISOString(),
  observedAt: new Date(end + 3000).toISOString(),
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
const cutFor = (projection: ReturnType<typeof incorporate>): KafkaProjectionCut => {
  const positions = Object.values(universe.topics)
    .sort()
    .map((topic) => ({
      topic,
      partition: 0,
      offset: String(BigInt(projection.offsets.get(`${topic}:0`) ?? '-1') + 1n),
    }))
  return {
    projection,
    positions,
    bootstrap: {
      schemaVersion: 'bayn.kafka-bootstrap.v1',
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
describe('verified streaming decision snapshot', () => {
  test('binds calendar, exact raw receipts, selected feature and source cut without archive provenance', () => {
    const snapshot = Result.getOrThrow(
      constructStreamingSnapshot(cutFor(incorporate([...raw(), featureRecord])), query),
    )
    expect(snapshot.manifest.schemaVersion).toBe('bayn.streaming-market-snapshot.v1')
    expect('archiveWatermarks' in snapshot.manifest).toBe(false)
    expect(snapshot.manifest.streaming.records).toHaveLength(32)
    expect(snapshot.manifest.streaming.features[0]?.value.featureId).toBe(feature.featureId)
    const { snapshotId, contentHash, ...material } = snapshot.manifest
    expect(contentHash).toBe(canonicalHashV1(material))
    expect(snapshotId).toBe(canonicalHashV1({ ...material, contentHash }))
  })

  test('selects quote state as of observation even when a newer quote is incorporated before the request executes', () => {
    const initial = incorporate([...raw(), featureRecord])
    const later = rawRecord('quotes', 2, end + 4000, { bp: 132, ap: 133, bs: 100, as: 100 })
    const current = incorporateMarketRecord(initial, later, universe, end + 4000)
    const snapshot = Result.getOrThrow(constructStreamingSnapshot(cutFor(current), query))
    expect(snapshot.latestQuotes['AAPL']?.askPrice).toBe(131)
  })

  test('cannot create entry evidence without the required feature or a complete source barrier', () => {
    expect(Result.isFailure(constructStreamingSnapshot(cutFor(incorporate(raw())), query))).toBe(true)
    const cut = cutFor(incorporate([...raw(), featureRecord]))
    expect(Result.isFailure(constructStreamingSnapshot({ ...cut, positions: [] }, query))).toBe(true)
    expect(
      Result.isFailure(constructStreamingSnapshot(cut, { ...query, rangeStartAt: '2026-09-11T13:29:00.000Z' })),
    ).toBe(true)
  })
})

describe('explicit historical delivery model', () => {
  test('uses the same reducer and retains late feature availability and supplied computation time', () => {
    const input = {
      schemaVersion: 'bayn.historical-market-arrivals.v1',
      runId: 'a'.repeat(64),
      deliveryModel: {
        schemaVersion: 'bayn.supplied-arrival-times.v1',
        description: 'Raw ingestion plus 2s; feature publication plus 3s',
        tieBreak: 'availability-topic-partition-offset',
      },
      observedAtMs: end + 3000,
      events: [
        ...raw().map((record) => ({ record, availableAtMs: end + 3000 })),
        { record: featureRecord, availableAtMs: end + 5000 },
      ],
    }
    const before = Result.getOrThrow(replayHistoricalMarketArrivals(input, universe))
    expect(before.evidenceMode).toBe('simulated-consumer-availability')
    expect(Result.isFailure(select(before.projection, end + 3000))).toBe(true)
    const after = Result.getOrThrow(replayHistoricalMarketArrivals({ ...input, observedAtMs: end + 5000 }, universe))
    expect(Result.getOrThrow(select(after.projection, end + 5000)).feature.value.computedAtMs).toBe(
      feature.computedAtMs,
    )
    expect(after.inputHash).not.toBe(before.inputHash)
  })
})

describe('recorded streaming cut replay', () => {
  test('replays both raw-first and feature-first receipts to the identical snapshot identity', () => {
    for (const records of [
      [...raw(), featureRecord],
      [featureRecord, ...raw()],
    ]) {
      const snapshot = Result.getOrThrow(constructStreamingSnapshot(cutFor(incorporate(records)), query))
      const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
      const replay = Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows))
      expect(replay.manifest).toEqual(snapshot.manifest)
      expect(replay.bars).toEqual(snapshot.bars)
    }
  })
  test('rejects altered raw rows, future feature receipts, and forged local sequence', () => {
    const snapshot = Result.getOrThrow(
      constructStreamingSnapshot(cutFor(incorporate([...raw(), featureRecord])), query),
    )
    const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
    expect(Result.isFailure(reproduceStreamingSnapshot(snapshot.manifest, { ...rows, bars: rows.bars.slice(1) }))).toBe(
      true,
    )
    const changed = {
      ...snapshot.manifest,
      streaming: {
        ...snapshot.manifest.streaming,
        features: snapshot.manifest.streaming.features.map((receipt) => ({ ...receipt, availableAtMs: end + 4000 })),
      },
    }
    expect(Result.isFailure(reproduceStreamingSnapshot(changed, rows))).toBe(true)
    expect(
      Result.isFailure(
        reproduceStreamingSnapshot(
          { ...snapshot.manifest, streaming: { ...snapshot.manifest.streaming, sequence: 1 } },
          rows,
        ),
      ),
    ).toBe(true)
  })
})
