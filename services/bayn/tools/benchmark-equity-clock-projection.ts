import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Effect, Result } from 'effect'

import { sha256 } from '../src/hash'
import type { KafkaConsumedRecord } from '../src/market-data/streaming/kafka'
import { nativeArrivalCaptureId } from '../src/market-data/streaming/native-arrival'
import { makeNativeArrivalJournal } from '../src/market-data/streaming/native-arrival-journal'
import { nativeArrivalEpochFixture } from '../src/market-data/streaming/native-arrival.test-support'
import { emptyStreamingProjection, incorporateMarketRecord } from '../src/market-data/streaming/projection'
import type { StreamingUniverse } from '../src/market-data/streaming/raw-events'
import { CaptureDisposition } from '../src/market-data/streaming/transport-evidence'

/**
 * Offline quote-heavy full-path comparison, not a live Kafka or database benchmark.
 * Before applying the change, bundle the baseline projection with Bun's --target=node
 * --packages=external into services/bayn/.tmp/baseline.mjs. Bundle this tool the same
 * way and run it with Node, passing that baseline module path as the only argument.
 * Both reducers receive identical prebuilt records and the unchanged real capture
 * journal with an in-memory store. No broker, Kafka, database or provider is contacted.
 */
const baselinePath = process.argv[2]
if (baselinePath === undefined) throw new Error('Usage: benchmark-equity-clock-projection <baseline-module.mjs>')
const baseline: {
  readonly emptyStreamingProjection: typeof emptyStreamingProjection
  readonly incorporateMarketRecord: typeof incorporateMarketRecord
} = await import(pathToFileURL(resolve(baselinePath)).href)
if (typeof baseline.emptyStreamingProjection !== 'function' || typeof baseline.incorporateMarketRecord !== 'function')
  throw new Error('Baseline module does not export the projection reducer')

const count = 100_000
const start = Date.parse('2026-10-23T14:00:00.000Z')
const source: StreamingUniverse = {
  universeId: 'synthetic-equity-clock-benchmark',
  universeSymbolHash: 'a'.repeat(64),
  symbols: ['SPY', 'IWM', 'QQQ', 'AAPL'],
  topics: {
    bars: 'test.bars',
    quotes: 'test.quotes',
    trades: 'test.trades',
    features: 'test.features',
  },
}
const sources = [source] as const
const bootstrap = {
  ...nativeArrivalEpochFixture.bootstrap,
  observedAtMs: start,
  lowerTimestampMs: start - 1_800_000,
  partitions: ['quotes', 'trades'].map((channel) => ({
    topic: `test.${channel}`,
    partition: 0,
    logStartOffset: '0',
    startOffset: '0',
    endOffset: String(count),
  })),
}
const epoch = {
  ...nativeArrivalEpochFixture,
  bootstrap,
  sources,
  captureId: Result.getOrThrow(nativeArrivalCaptureId(nativeArrivalEpochFixture.build, bootstrap, sources)),
}
const records: readonly KafkaConsumedRecord[] = Array.from({ length: count }, (_, index) => {
  const channel = index % 10 === 0 ? 'trades' : 'quotes'
  const eventTs = new Date(start + index).toISOString()
  const value = JSON.stringify({
    provider: 'alpaca',
    feed: 'iex',
    delayClass: 'real_time_exchange_only',
    marketSession: 'regular',
    channel,
    symbol: source.symbols[index % source.symbols.length],
    eventTs,
    ingestTs: eventTs,
    version: 2,
    payload: channel === 'quotes' ? { bp: 100, ap: 101, bs: 100, as: 100, t: eventTs } : { p: 100, s: 100, t: eventTs },
  })
  const rawValue = Buffer.from(value)
  return {
    topic: source.topics[channel],
    partition: 0,
    offset: String(index),
    value,
    timestampMs: start + index,
    leaderEpoch: 1,
    rawValue,
    rawByteLength: rawValue.byteLength,
    rawValueSha256: sha256(rawValue),
  }
})

const implementations = {
  baseline,
  candidate: { emptyStreamingProjection, incorporateMarketRecord },
}
const run = async (implementation: typeof baseline, captureEnabled: boolean) => {
  let state = implementation.emptyStreamingProjection('synthetic-equity-clock-benchmark')
  let chunks = 0
  let compressedBytes = 0
  let durableSequence = 0
  const cpu = process.cpuUsage()
  const began = performance.now()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const capture = captureEnabled
          ? yield* makeNativeArrivalJournal(epoch, {
              begin: () => Effect.void,
              append: (batch) =>
                Effect.sync(() => {
                  chunks += batch.length
                  compressedBytes += batch.reduce((size, chunk) => size + chunk.compressed.byteLength, 0)
                }),
              end: (end) =>
                Effect.sync(() => {
                  durableSequence = end.durableConsumerSequence
                }),
            })
          : undefined
        for (const [index, record] of records.entries()) {
          if (index % 256 === 0) yield* Effect.yieldNow
          state = implementation.incorporateMarketRecord(state, record, source, start + index + 1000)
          if (capture !== undefined)
            yield* capture.observe({
              record,
              availableAtMs: start + index + 1000,
              consumerSequence: index + 1,
              projectionSequence: state.sequence,
              disposition: CaptureDisposition.Accepted,
              assignmentInvalidated: false,
            })
        }
      }),
    ),
  )
  const elapsedMs = performance.now() - began
  const consumed = process.cpuUsage(cpu)
  assert.equal(state.sequence, count)
  assert.equal(state.rejections.size, 0)
  if (captureEnabled) assert.equal(durableSequence, count)
  return {
    state,
    elapsedMs,
    cpuMs: (consumed.user + consumed.system) / 1000,
    chunks,
    compressedBytes,
  }
}

for (const capture of [false, true]) {
  let expected: ReturnType<typeof emptyStreamingProjection> | undefined
  for (let trial = 0; trial < 3; trial++) {
    const order = trial % 2 === 0 ? (['baseline', 'candidate'] as const) : (['candidate', 'baseline'] as const)
    for (const name of order) {
      const { state, ...measurements } = await run(implementations[name], capture)
      if (expected === undefined) expected = state
      else assert.deepEqual(state, expected)
      console.log(
        JSON.stringify({
          scenario: '90% equity quotes / 10% trades',
          runtime: process.version,
          trial,
          name,
          capture,
          count,
          ...measurements,
          recordsPerSecond: (count * 1000) / measurements.elapsedMs,
        }),
      )
    }
  }
}
