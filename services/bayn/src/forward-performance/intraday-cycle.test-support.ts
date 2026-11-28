import { withProviderSessions } from '../testing/market-calendar-fixture'
import { Result, Schema } from 'effect'
import { IntradayPerformanceManifestSchema } from './intraday-schema'
import { intradayPerformanceDecisionRequest, intradayPerformanceSessionQuery } from './intraday-volume'
import type { ForwardPerformanceIntradayMarketVolumeRequest } from './model'
import { streamingFixture } from '../testing/streaming-market-fixture'
import { IsoDateSchema } from '../schemas'
import { canonicalHashV1Result } from '../hash'

// The two recorded cuts use the same venue timetable and universe. Keep each cut's actual provider offsets,
// record counts, time window and content hashes rather than rebuilding them from synthetic bars.
const tradingDates = [
  '2026-09-10',
  '2026-09-11',
  '2026-09-14',
  '2026-09-15',
  '2026-09-16',
  '2026-09-17',
  '2026-09-18',
  '2026-09-21',
  '2026-09-22',
  '2026-09-23',
  '2026-09-24',
  '2026-09-25',
  '2026-09-28',
  '2026-09-29',
  '2026-09-30',
  '2026-10-01',
  '2026-10-02',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
  '2026-10-08',
  '2026-10-09',
] as const
const recordedCalendar = (start: (typeof tradingDates)[number], end: '2026-10-10' | '2026-10-11') =>
  withProviderSessions({
    source: 'alpaca-v2-calendar',
    sessions: tradingDates
      .filter((date) => date >= start)
      .map((date) => ({
        date,
        openAt: `${date}T13:30:00.000Z`,
        closeAt: `${date}T20:00:00.000Z`,
      })),
    timeZone: 'UTC',
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v2',
    requestedRange: { end, start },
  } as const)

const universe = [
  'AAPL',
  'AMD',
  'AMZN',
  'AVGO',
  'COHR',
  'CRDO',
  'IWM',
  'LITE',
  'MRVL',
  'MU',
  'NVDA',
  'QQQ',
  'SMH',
  'SNDK',
  'SPY',
  'WDC',
] as const
const sourceTopics = { bars: 'torghut.bars.1m.v1', quotes: 'torghut.quotes.v1', trades: 'torghut.trades.v1' } as const

const lineage = (
  sourceTopic: string,
  rows: ReadonlyArray<readonly [partition: number, firstOffset: string, lastOffset: string, count: number]>,
) =>
  rows.map(([sourcePartition, firstOffset, lastOffset, recordCount]) => ({
    lastOffset,
    firstOffset,
    recordCount,
    sourceTopic,
    sourcePartition,
  }))

const watermarks = (sourceTopic: string, rows: ReadonlyArray<readonly [partition: number, inclusiveOffset: string]>) =>
  rows.map(([sourcePartition, inclusiveLastOffset]) => ({ sourceTopic, sourcePartition, inclusiveLastOffset }))

const recordedIntradayCycles = [
  {
    cycleId: 'c4b0a5b9bd46f3e2fc8b972809b400b19510cdcd444f2cb4ad1ee5f0bd4b2e99',
    session: '2026-09-10',
    windowOpenedAt: '2026-09-10T13:30:00+00:00',
    windowClosedAt: '2026-09-10T20:00:00+00:00',
    manifest: {
      feed: 'iex',
      lineage: [
        ...lineage(sourceTopics.bars, [
          [0, '1146333', '1146404', 30],
          [1, '1707896', '1708028', 29],
          [2, '2125204', '2125442', 150],
        ]),
        ...lineage(sourceTopics.quotes, [
          [1, '178161311', '178161311', 1],
          [3, '4709726', '4709726', 1],
          [4, '9884334', '9884334', 1],
          [6, '3507816', '3507816', 1],
          [8, '2308433', '2308433', 1],
          [9, '9189160', '9189160', 1],
          [12, '14462334', '14462334', 1],
        ]),
        ...lineage(sourceTopics.trades, [
          [0, '6398302', '6398302', 1],
          [1, '10213132', '10213132', 1],
          [2, '12465079', '12465101', 5],
        ]),
      ],
      symbols: ['AAPL', 'AMZN', 'IWM', 'NVDA', 'QQQ', 'SMH', 'SPY'],
      barCount: 209,
      calendar: recordedCalendar('2026-09-10', '2026-10-10'),
      universe: universe,
      delayClass: 'real_time_exchange_only',
      observedAt: '2026-09-10T19:50:27.072Z',
      quoteCount: 7,
      rangeEndAt: '2026-09-10T19:50:00.000Z',
      tradeCount: 7,
      universeId: 'torghut-core-equity-v2',
      sessionDate: '2026-09-10',
      rangeStartAt: '2026-09-10T19:20:00.000Z',
      sourceTopics: { ...sourceTopics },
      schemaVersion: 'bayn.intraday-market-snapshot.v1',
      barsContentHash: 'c04336843d74ecbcd167ab6f3fcbd4fac880a32cb9aea90ce8d8389eb9f66dea',
      candidateSymbols: ['AAPL', 'AMZN', 'IWM', 'NVDA', 'QQQ', 'SMH'],
      archiveWatermarks: [
        ...watermarks(sourceTopics.bars, [
          [0, '1146405'],
          [1, '1708031'],
          [2, '2125442'],
        ]),
        ...watermarks(sourceTopics.quotes, [
          [1, '178161311'],
          [3, '4709726'],
          [4, '9884334'],
          [6, '3507816'],
          [8, '2308433'],
          [9, '9189160'],
          [12, '14462334'],
        ]),
        ...watermarks(sourceTopics.trades, [
          [0, '6398302'],
          [1, '10213132'],
          [2, '12465101'],
        ]),
      ],
      maximumQuoteAgeMs: 2000,
      quotesContentHash: '7fa6c2d6381c52fc219701b4a13bdf677140823010f5e61a6cefa739eec639de',
      tradesContentHash: 'f4d7221cd77083dc784aea827f09c12e070b04e09d8c237263c6c2a23c283906',
      universeSymbolHash: '12d8e7ad3e0087e85c39f47896e77adde6bb8e029724a70aae1ef5fd393bddf1',
      candidateExclusions: [],
      minimumWatermarkLagMs: 2000,
    },
  },
  {
    cycleId: '04fc4a847370374fcae6866a808bb98a69e84dd55b97808e8265be1530ba353e',
    session: '2026-09-11',
    windowOpenedAt: '2026-09-11T13:30:00+00:00',
    windowClosedAt: '2026-09-11T20:00:00+00:00',
    manifest: {
      feed: 'iex',
      lineage: [
        ...lineage(sourceTopics.bars, [
          [0, '1146471', '1146559', 30],
          [1, '1708114', '1708255', 30],
          [2, '2125594', '2125830', 149],
        ]),
        ...lineage(sourceTopics.quotes, [
          [1, '178485127', '178485127', 1],
          [3, '4845243', '4845243', 1],
          [4, '10241845', '10241845', 1],
          [6, '3585389', '3585389', 1],
          [8, '2409817', '2409817', 1],
          [9, '9601595', '9601595', 1],
          [12, '14840410', '14840410', 1],
        ]),
        ...lineage(sourceTopics.trades, [
          [0, '6406339', '6406339', 1],
          [1, '10216677', '10216677', 1],
          [2, '12483161', '12483240', 5],
        ]),
      ],
      symbols: ['AAPL', 'AMZN', 'IWM', 'NVDA', 'QQQ', 'SMH', 'SPY'],
      barCount: 209,
      calendar: recordedCalendar('2026-09-11', '2026-10-11'),
      universe: universe,
      delayClass: 'real_time_exchange_only',
      observedAt: '2026-09-11T14:01:31.791Z',
      quoteCount: 7,
      rangeEndAt: '2026-09-11T14:01:00.000Z',
      tradeCount: 7,
      universeId: 'torghut-core-equity-v2',
      sessionDate: '2026-09-11',
      rangeStartAt: '2026-09-11T13:31:00.000Z',
      sourceTopics: { ...sourceTopics },
      schemaVersion: 'bayn.intraday-market-snapshot.v1',
      barsContentHash: '95af06f50199a0630109635a47c2ea9b03ff5620e5180bb906c24776760b563c',
      candidateSymbols: ['AAPL', 'AMZN', 'IWM', 'NVDA', 'QQQ', 'SMH'],
      archiveWatermarks: [
        ...watermarks(sourceTopics.bars, [
          [0, '1146559'],
          [1, '1708259'],
          [2, '2125832'],
        ]),
        ...watermarks(sourceTopics.quotes, [
          [1, '178485127'],
          [3, '4845243'],
          [4, '10241845'],
          [6, '3585389'],
          [8, '2409817'],
          [9, '9601595'],
          [12, '14840410'],
        ]),
        ...watermarks(sourceTopics.trades, [
          [0, '6406339'],
          [1, '10216677'],
          [2, '12483240'],
        ]),
      ],
      maximumQuoteAgeMs: 10000,
      quotesContentHash: '0a13c49ddd1176c71b2ecc107f6097fd3303aea5ceaf00d66d4262a49aefdcb5',
      tradesContentHash: '4ec8e452f47de1b01860b296975f195f9c3cdd20bb8625be3511f37e918984cf',
      universeSymbolHash: '12d8e7ad3e0087e85c39f47896e77adde6bb8e029724a70aae1ef5fd393bddf1',
      candidateExclusions: [],
      minimumWatermarkLagMs: 2000,
    },
  },
] as const

export const completedIntradayCycles = recordedIntradayCycles.map((cycle) => {
  const calendarMaterial = cycle.manifest.calendar
  const calendar = {
    ...calendarMaterial,
    normalizedResponseHash: Result.getOrThrow(canonicalHashV1Result(calendarMaterial)),
  }
  const material = { ...cycle.manifest, calendar }
  const hashed = { ...material, contentHash: Result.getOrThrow(canonicalHashV1Result(material)) }
  return { ...cycle, manifest: { ...hashed, snapshotId: Result.getOrThrow(canonicalHashV1Result(hashed)) } }
})

export const makeIntradayPerformanceFixture = () => {
  const cycle = completedIntradayCycles[1]
  const request: ForwardPerformanceIntradayMarketVolumeRequest = {
    cycleId: cycle.cycleId,
    decisionSnapshotId: cycle.manifest.snapshotId,
    decisionSnapshotAsOfSession: cycle.session,
    symbol: 'NVDA',
    executionSessionDate: cycle.session,
    windowOpenedAt: new Date(cycle.windowOpenedAt).toISOString(),
    windowClosedAt: new Date(cycle.windowClosedAt).toISOString(),
    evidenceCutoffAt: `${cycle.session}T21:00:00.000Z`,
    sourceFeed: 'iex',
    decisionManifest: Schema.decodeUnknownSync(IntradayPerformanceManifestSchema)(cycle.manifest),
  }
  return performanceSessionFixture(request)
}

export const makeStreamingPerformanceFixture = () => {
  const { snapshot } = streamingFixture()
  return performanceSessionFixture({
    cycleId: 'a'.repeat(64),
    decisionSnapshotId: snapshot.manifest.snapshotId,
    decisionSnapshotAsOfSession: Schema.decodeUnknownSync(IsoDateSchema)(snapshot.manifest.sessionDate),
    symbol: 'AAPL',
    executionSessionDate: Schema.decodeUnknownSync(IsoDateSchema)(snapshot.manifest.sessionDate),
    windowOpenedAt: '2026-09-04T13:30:00.000Z',
    windowClosedAt: '2026-09-04T20:00:00.000Z',
    evidenceCutoffAt: '2026-09-04T21:00:00.000Z',
    sourceFeed: 'iex',
    decisionManifest: snapshot.manifest,
  })
}

export const makeStreamingPartitionPerformanceFixture = () => {
  const { request, archive, bars } = makeStreamingPerformanceFixture()
  const manifest = request.decisionManifest
  if (manifest.schemaVersion !== 'bayn.streaming-market-snapshot.v1') throw new Error('expected streaming fixture')
  const { contentHash: _contentHash, snapshotId: _snapshotId, ...original } = manifest
  const position = { topic: manifest.sourceTopics.bars, partition: 1, offset: '0' }
  const material = {
    ...original,
    streaming: {
      ...manifest.streaming,
      positions: [...manifest.streaming.positions, position].toSorted(
        (left, right) => left.topic.localeCompare(right.topic) || left.partition - right.partition,
      ),
      bootstrap: {
        ...manifest.streaming.bootstrap,
        partitions: [
          ...manifest.streaming.bootstrap.partitions,
          {
            topic: position.topic,
            partition: position.partition,
            logStartOffset: '0',
            startOffset: '0',
            endOffset: '0',
          },
        ].toSorted((left, right) => left.topic.localeCompare(right.topic) || left.partition - right.partition),
      },
    },
  }
  const hashed = { ...material, contentHash: Result.getOrThrow(canonicalHashV1Result(material)) }
  const decisionManifest = { ...hashed, snapshotId: Result.getOrThrow(canonicalHashV1Result(hashed)) }
  return {
    request: { ...request, decisionManifest, decisionSnapshotId: decisionManifest.snapshotId },
    archive: {
      ...archive,
      archiveWatermarks: [
        ...archive.archiveWatermarks,
        { sourceTopic: position.topic, sourcePartition: position.partition, inclusiveLastOffset: '390' },
      ].toSorted(
        (left, right) =>
          left.sourceTopic.localeCompare(right.sourceTopic) || left.sourcePartition - right.sourcePartition,
      ),
    },
    bars: bars.map((bar, index) =>
      index % 2 === 0 ? bar : { ...bar, source_partition: '1', source_offset: String(index) },
    ),
  }
}

const performanceSessionFixture = (request: ForwardPerformanceIntradayMarketVolumeRequest) => {
  const original = Result.getOrThrow(intradayPerformanceDecisionRequest(request))
  const archive = {
    ...intradayPerformanceSessionQuery(request, original),
    archiveWatermarks: original.archiveWatermarks.map((watermark) => ({
      ...watermark,
      inclusiveLastOffset: String(BigInt(watermark.inclusiveLastOffset) + 390n),
    })),
  }
  // Synthetic session prices and volumes exercise report arithmetic, not strategy profitability.
  const bars = Array.from({ length: 390 }, (_, index) => ({
    provider: 'alpaca',
    universe_id: archive.universeId,
    universe_symbol_hash: archive.universeSymbolHash,
    feed: 'iex',
    market_session: 'regular',
    delay_class: 'real_time_exchange_only',
    symbol: request.symbol,
    event_at: new Date(Date.parse(request.windowOpenedAt) + index * 60_000).toISOString(),
    ingested_at: new Date(Date.parse(request.windowOpenedAt) + (index + 1) * 60_000 + 2_000).toISOString(),
    source_topic: archive.sourceTopics.bars,
    source_partition: '0',
    source_offset: String(index + 1),
    schema_version: '1',
    channel: 'bars',
    is_final: '1',
    open: '221.65',
    high: '221.65',
    low: '218.69',
    close: '218.69',
    volume: '100.00000000',
    vwap: null,
    trade_count: '1',
  }))
  return { request, archive, bars }
}
