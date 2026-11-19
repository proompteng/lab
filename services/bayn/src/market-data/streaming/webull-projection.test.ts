import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { Result } from 'effect'

import { jevSignalFor } from '../../jev/trading-signals'
import { jevRequestForSnapshot } from '../../jev/native.test-support'
import { streamingFixture } from '../../testing/streaming-market-fixture'
import { persistIntradayRecordRows } from '../intraday/verification'
import { emptyStreamingProjection, incorporateMarketRecord } from './projection'
import { reproduceStreamingSnapshot } from './replay'
import { constructStreamingSnapshot } from './snapshot'
import { WebullProducerClockDirection } from './webull-capture'
import { selectWebullBars, webullSnapshotEvidence } from './webull-projection'

const topic = 'dorvud.webull.raw.v1'
const fixture = streamingFixture()
const end = Date.parse(fixture.query.rangeEndAt)
const source = fixture.cut.projection.sources.get(fixture.query.universeId)
if (source === undefined) throw new Error('Missing fixture source')
const universe = { ...source, topics: { ...source.topics, webullBars: topic } }
const payloadBar = {
  time: new Date(end - 60_000).toISOString().replace('Z', '+0000'),
  trading_session: 'RTH',
  open: '100',
  high: '102',
  low: '99',
  close: '101.000000000000000001',
  volume: '25000',
}
const record = (
  offset = '0',
  close = payloadBar.close,
  receivedAtMs = end + 1000,
  options: {
    readonly gap?: string
    readonly symbols?: readonly string[]
    readonly minute?: number
    readonly empty?: boolean
  } = {},
) => {
  const symbols = options.symbols ?? ['AAPL', 'SPY']
  const bytes = Buffer.from(
    JSON.stringify(
      options.gap === undefined
        ? {
            result: symbols.map((symbol) => ({
              symbol,
              delay_minutes: '0',
              result: options.empty
                ? []
                : [
                    {
                      ...payloadBar,
                      close,
                      time: new Date(options.minute ?? end - 60_000).toISOString().replace('Z', '+0000'),
                    },
                  ],
            })),
          }
        : { channel: options.gap, symbols },
    ),
  )
  return {
    topic,
    partition: 0,
    offset,
    timestampMs: receivedAtMs,
    value: JSON.stringify({
      version: 1,
      provider: 'webull',
      feed: 'nasdaq_basic',
      captureId: `8e8cfeb4-538f-42bd-b2bf-${offset.padStart(12, '0')}`,
      receivedAt: new Date(receivedAtMs).toISOString(),
      source:
        options.gap === undefined
          ? {
              type: 'http',
              endpoint: '/market-data/stocks/bars/list',
              requestedSymbols: symbols,
              requestBody: JSON.stringify({
                symbols,
                category: 'US_STOCK',
                timespan: 'M1',
                count: '5',
                real_time_required: true,
                trading_sessions: 'PRE,RTH,ATH',
                start_time: end - 300_000,
                end_time: end - 1,
              }),
            }
          : { type: 'collector', operation: 'gap' },
      payloadBase64: bytes.toString('base64'),
      payloadSha256: createHash('sha256').update(bytes).digest('hex'),
    }),
  }
}
const initial = () => emptyStreamingProjection('webull-test', undefined, topic)
const select = (state: ReturnType<typeof initial>, at = end + 3000) =>
  selectWebullBars(state.webull, ['AAPL', 'SPY'], end, at)

const decisionCut = () => {
  const projection = incorporateMarketRecord(fixture.cut.projection, record(), universe, end + 1500)
  const position = { topic, partition: 0, offset: '1' }
  return {
    ...fixture.cut,
    projection,
    positions: [...fixture.cut.positions, position].toSorted((a, b) => a.topic.localeCompare(b.topic)),
    bootstrap: {
      ...fixture.cut.bootstrap,
      partitions: [
        ...fixture.cut.bootstrap.partitions,
        { topic, partition: 0, logStartOffset: '0', startOffset: '0', endOffset: '1' },
      ].toSorted((a, b) => a.topic.localeCompare(b.topic)),
    },
  }
}

test('native Webull evidence reaches model input without changing IEX chart or execution prices', () => {
  const snapshot = Result.getOrThrow(constructStreamingSnapshot(decisionCut(), fixture.query))
  const actual = Result.getOrThrow(jevRequestForSnapshot(snapshot, 'AAPL')).input
  const baseline = Result.getOrThrow(jevRequestForSnapshot(fixture.snapshot, 'AAPL')).input
  expect(actual.numericalState['webullContext']).toMatchObject({
    schemaVersion: 'bayn.jev-webull-entry-context.v1',
    provider: 'webull',
    feed: 'nasdaq_basic',
    symbol: 'AAPL',
    close: payloadBar.close,
    volume: payloadBar.volume,
    availableAt: new Date(end + 1500).toISOString(),
    availabilityLagMs: 1500,
  })
  expect(actual.chartSource).toEqual(baseline.chartSource)
  expect(actual.funding).toEqual(baseline.funding)
  expect(actual.numericalState['candidate']).toEqual(baseline.numericalState['candidate'])
  expect(baseline.numericalState['webullContext']).toBeNull()
})

test('the existing consumer accepts native batches once and retains real first availability', () => {
  const state = incorporateMarketRecord(initial(), record(), universe, end + 1500)
  expect(state.sequence).toBe(1)
  expect(state.offsets.get(`${topic}:0`)).toBe('0')
  expect(select(state).map((bar) => bar.value.symbol)).toEqual(['AAPL', 'SPY'])
  expect(select(state)[0]?.value.close).toBe(payloadBar.close)
  const replay = incorporateMarketRecord(state, record(), universe, end + 2000)
  expect(replay).toBe(state)
  const repeated = incorporateMarketRecord(state, record('1', payloadBar.close, end + 2000), universe, end + 2500)
  expect(select(repeated)[0]?.delivery.availableAtMs).toBe(end + 1500)
  expect(select(repeated)[0]?.delivery.record.offset).toBe('0')
  expect(repeated.webull.bars.get('AAPL')).toHaveLength(1)
  expect(select(state, end + 1499)).toHaveLength(0)
  expect(selectWebullBars(state.webull, ['AAPL'], end + 60_000, end + 61_000)).toHaveLength(0)
  expect(select(state, end + 61_000)).toHaveLength(0)
})

test('late original arrivals and late corrections cannot qualify; earlier cuts still reproduce the earlier value', () => {
  const late = incorporateMarketRecord(initial(), record(), universe, end + 10_001)
  expect(select(late, end + 20_000)).toHaveLength(0)
  const original = incorporateMarketRecord(initial(), record(), universe, end + 1500)
  const correction = incorporateMarketRecord(original, record('1', '100.9', end + 11_000), universe, end + 11_100)
  expect(select(correction)[0]?.value.close).toBe(payloadBar.close)
  expect(select(correction, end + 12_000)).toHaveLength(0)
  const reversion = incorporateMarketRecord(
    correction,
    record('2', payloadBar.close, end + 12_000),
    universe,
    end + 12_100,
  )
  expect(select(reversion, end + 13_000)).toHaveLength(0)
  expect(select(reversion)[0]?.delivery.record.offset).toBe('0')
  const emptyMinute = incorporateMarketRecord(
    initial(),
    record('0', payloadBar.close, end + 1000, { minute: end - 120_000 }),
    universe,
    end + 1500,
  )
  expect(select(emptyMinute)).toHaveLength(0)
})

test('bar gaps and invalid captures remove only optional context, with scope and as-of availability preserved', () => {
  const original = incorporateMarketRecord(initial(), record(), universe, end + 1500)
  const mqttGap = incorporateMarketRecord(
    original,
    record('1', undefined, end + 2000, { gap: 'mqtt' }),
    universe,
    end + 2000,
  )
  expect(select(mqttGap)).toHaveLength(2)
  const barGap = incorporateMarketRecord(
    mqttGap,
    record('2', undefined, end + 2500, { gap: 'bars', symbols: ['AAPL'] }),
    universe,
    end + 2500,
  )
  expect(select(barGap).map((bar) => bar.value.symbol)).toEqual(['SPY'])
  expect(select(barGap, end + 2499)).toHaveLength(2)
  const invalid = incorporateMarketRecord(original, { ...record('1'), value: '{' }, universe, end + 2000)
  expect(select(invalid)).toHaveLength(0)
  expect(invalid.rejections).toBe(original.rejections)
  expect(invalid.bars).toBe(original.bars)
  const conflicting = incorporateMarketRecord(original, record('0', '100.9'), universe, end + 2000)
  expect(select(conflicting)).toHaveLength(0)
})

test.each([-6000, 6000])(
  'clock difference %i retains its diagnostic and globally withholds even an empty background response',
  (difference) => {
    const original = decisionCut().projection
    const native = record('1', undefined, end + 1000, { symbols: ['ZZZZ'], empty: true })
    const rejected = incorporateMarketRecord(
      original,
      { ...native, timestampMs: native.timestampMs + difference },
      universe,
      end + 8000,
    )
    expect(select(rejected, end + 7999).map((bar) => bar.value.symbol)).toEqual(['AAPL', 'SPY'])
    expect(select(rejected, end + 8000)).toHaveLength(0)
    expect(rejected.webull.rejections.at(-1)).toEqual({
      availableAtMs: end + 8000,
      sequence: original.sequence + 1,
      reason: 'Webull timestamp violates the producer clock contract',
      producerClock: {
        kafkaTimestampMs: native.timestampMs + difference,
        collectorReceivedAtMs: native.timestampMs,
        kafkaMinusCollectorReceiptMs: difference,
        maximumDifferenceMs: 5000,
        direction:
          difference > 0
            ? WebullProducerClockDirection.KafkaAfterCollectorReceipt
            : WebullProducerClockDirection.KafkaBeforeCollectorReceipt,
      },
    })
    expect(rejected.webull.bars).toBe(original.webull.bars)
    expect(rejected.rejections).toBe(original.rejections)
    expect(rejected.bars).toBe(original.bars)
    expect(rejected.quotes).toBe(original.quotes)
    expect(rejected.trades).toBe(original.trades)
    expect(rejected.features).toBe(original.features)
  },
)

test('a recorded decision cut binds native proof and replays without changing IEX bars or pricing', () => {
  const cut = decisionCut()
  const projection = cut.projection
  const snapshot = Result.getOrThrow(constructStreamingSnapshot(cut, fixture.query))
  expect(snapshot.bars).toEqual(fixture.snapshot.bars)
  expect(snapshot.latestQuotes).toEqual(fixture.snapshot.latestQuotes)
  expect(snapshot.manifest.streaming.webull?.bars.map((bar) => bar.symbol)).toEqual(['AAPL', 'SPY'])
  expect(snapshot.manifest.streaming.webull?.captures).toHaveLength(1)
  const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
  expect(Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows)).manifest).toEqual(snapshot.manifest)
  const gapped = incorporateMarketRecord(
    projection,
    record('1', undefined, end + 1700, { gap: 'bars', symbols: ['AAPL'] }),
    universe,
    end + 1800,
  )
  const gapSnapshot = Result.getOrThrow(
    constructStreamingSnapshot(
      {
        ...cut,
        projection: gapped,
        positions: cut.positions.map((position) =>
          position.topic === topic ? { ...position, offset: '2' } : position,
        ),
      },
      fixture.query,
    ),
  )
  expect(gapSnapshot.manifest.streaming.webull?.bars.map((bar) => bar.symbol)).toEqual(['SPY'])
  expect(
    Result.getOrThrow(
      reproduceStreamingSnapshot(gapSnapshot.manifest, Result.getOrThrow(persistIntradayRecordRows(gapSnapshot))),
    ).manifest,
  ).toEqual(gapSnapshot.manifest)
  const evidence = snapshot.manifest.streaming.webull
  if (evidence === undefined) throw new Error('Missing Webull evidence')
  const first = evidence.captures[0]
  if (first === undefined) throw new Error('Missing native proof')
  for (const mutation of [
    { ...evidence, captures: [{ ...first, record: { ...first.record, value: '{}' } }] },
    { ...evidence, captures: [{ ...first, availableAtMs: end + 10_001 }] },
    { ...evidence, captures: [{ ...first, sequence: projection.sequence + 1 }] },
    { ...evidence, captures: [{ ...first, record: { ...first.record, offset: '1' } }] },
    { ...evidence, bars: [...evidence.bars, evidence.bars[0]!] },
    { ...evidence, topic: universe.topics.bars },
  ]) {
    const manifest = { ...snapshot.manifest, streaming: { ...snapshot.manifest.streaming, webull: mutation } }
    expect(Result.isFailure(reproduceStreamingSnapshot(manifest, rows))).toBe(true)
  }
})

test('an IEX-excluded candidate retains independent Webull evidence without becoming tradable', () => {
  const cut = decisionCut()
  const bars = new Map(cut.projection.bars)
  bars.set(
    'AAPL',
    (bars.get('AAPL') ?? []).filter((bar) => Date.parse(bar.value.eventAt) !== end - 60_000),
  )
  const snapshot = Result.getOrThrow(
    constructStreamingSnapshot({ ...cut, projection: { ...cut.projection, bars } }, fixture.query),
  )
  expect(snapshot.manifest.candidateExclusions?.some((entry) => entry.symbol === 'AAPL')).toBe(true)
  expect(snapshot.manifest.streaming.webull?.bars.map((bar) => bar.symbol)).toEqual(['AAPL', 'SPY'])
  expect(Result.isFailure(jevSignalFor(snapshot, 'AAPL'))).toBe(true)
  const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
  expect(Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows)).manifest).toEqual(snapshot.manifest)
})

test('native evidence does not grow with recovery polls and never refreshes old bars', () => {
  let state = initial()
  for (let i = 0; i < 100; i++)
    state = incorporateMarketRecord(
      state,
      record(String(i), payloadBar.close, end + 1000 + i),
      universe,
      end + 1500 + i,
    )
  expect(state.webull.bars.get('AAPL')).toHaveLength(1)
  expect(webullSnapshotEvidence(state.webull, ['AAPL', 'SPY'], end, end + 3000)?.captures).toHaveLength(1)
  expect(select(state)[0]?.delivery.availableAtMs).toBe(end + 1500)
})
