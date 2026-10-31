import { Result } from 'effect'
import { gzipSync } from 'node:zlib'
import { sha256 } from '../hash'
import { simulationFixture } from './simulated-streaming-fixture'
import { historicalRawArrivals } from './historical-streaming-fixture'
import {
  arrivalPosition,
  compareArrivalPositions,
  type HistoricalMarketArrival,
} from '../market-data/streaming/historical'
import {
  backtestSourcePartitions,
  validateBacktestSourceReceipt,
  type BacktestSourceManifest,
} from '../intraday-replay/source'

export const retainedReplayCaptureFixture = (manifest: BacktestSourceManifest) => {
  const text = JSON.stringify({
    schemaVersion: 'bayn.replay-source-capture.v2',
    capturedAt: new Date(manifest.coverageEndMs + 1).toISOString(),
    origin: 'Independently frozen deterministic capture fixture',
    coverageStartMs: manifest.coverageStartMs,
    coverageEndMs: manifest.coverageEndMs,
    marketSources: manifest.marketSources,
    positions: manifest.positions,
  })
  return validateBacktestSourceReceipt(text, sha256(text)).pipe(Result.getOrThrow)
}

export const retainReplayArrivals = (
  arrivals: readonly HistoricalMarketArrival[],
  marketSources: BacktestSourceManifest['marketSources'],
  deliveryModel: BacktestSourceManifest['deliveryModel'],
) => {
  const events = arrivals.toSorted((a, b) => compareArrivalPositions(arrivalPosition(a), arrivalPosition(b)))
  const body = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  const positions = new Map<
    string,
    { topic: string; partition: number; startOffset: string; endOffsetExclusive: string }
  >()
  for (const { record } of events) {
    const key = `${record.topic}:${record.partition}`
    const previous = positions.get(key)
    positions.set(key, {
      topic: record.topic,
      partition: record.partition,
      startOffset: previous?.startOffset ?? record.offset,
      endOffsetExclusive: String(BigInt(record.offset) + 1n),
    })
  }
  const manifest: BacktestSourceManifest = {
    schemaVersion: 'bayn.backtest-source.v2',
    encoding: 'ndjson-gzip',
    transport: 'captured-kafka',
    dataSha256: sha256(gzipSync(body)),
    recordCount: events.length,
    firstAvailableAtMs: events[0]?.availableAtMs ?? 0,
    lastAvailableAtMs: events.at(-1)?.availableAtMs ?? 0,
    coverageStartMs: events[0]?.availableAtMs ?? 0,
    coverageEndMs: events.at(-1)?.availableAtMs ?? 0,
    origin: 'deterministic unit fixture',
    positions: [...positions.values()].sort((a, b) =>
      a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : a.partition - b.partition,
    ),
    marketSources,
    deliveryModel,
  }
  const complete = {
    ...manifest,
    positions: backtestSourcePartitions(manifest).map(
      ({ topic, partition }) =>
        positions.get(`${topic}:${partition}`) ?? { topic, partition, startOffset: '0', endOffsetExclusive: '0' },
    ),
  }
  return { body, manifest: complete, capture: retainedReplayCaptureFixture(complete), events }
}

const retainedReplayFromSimulation = (
  input: ReturnType<typeof simulationFixture>,
  arrivals = input.input.arrivals.events,
) => ({
  ...retainReplayArrivals(
    arrivals.map((event) =>
      event.record.topic === input.cursor.marketSources[0].topics.features
        ? { ...event, record: { ...event.record, partition: 0 } }
        : event,
    ),
    input.cursor.marketSources,
    input.source.deliveryModel,
  ),
  input,
})

export const retainedReplayFixture = () => retainedReplayFromSimulation(simulationFixture())

/** Synthetic executable quotes exercise a funded entry and target exit within one signal window. */
export const momentumTradeReplayFixture = () => {
  const input = simulationFixture(undefined, undefined, undefined, true)
  const startMs = Date.parse(input.query.observedAt)
  const offsets = new Map<string, bigint>()
  for (const { record } of input.input.arrivals.events) {
    const key = `${record.topic}:${record.partition}`
    const offset = BigInt(record.offset)
    if (offset >= (offsets.get(key) ?? -1n)) offsets.set(key, offset)
  }
  const quotes = Array.from({ length: 200 }, (_, index) => {
    const availableAtMs = startMs + (index + 1) * 200
    const at = new Date(availableAtMs).toISOString()
    return historicalRawArrivals(
      {
        bars: [],
        trades: [],
        quotes: input.snapshot.quotes.map((quote) => {
          const key = `${quote.sourceTopic}:${quote.sourcePartition}`
          const offset = (offsets.get(key) ?? -1n) + 1n
          offsets.set(key, offset)
          return {
            ...quote,
            sourceOffset: String(offset),
            eventAt: at,
            ingestedAt: at,
            bidPrice: quote.bidPrice * (quote.symbol === 'AAPL' && index >= 49 ? 1.04 : 1),
            askPrice: quote.askPrice * (quote.symbol === 'AAPL' && index >= 49 ? 1.04 : 1),
            bidSize: 100,
            askSize: 100,
          }
        }),
      },
      availableAtMs,
    )
  }).flat()
  return retainedReplayFromSimulation(input, [...input.input.arrivals.events, ...quotes])
}
