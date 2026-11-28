import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { emptyStreamingProjection, incorporateMarketRecord } from '../src/market-data/streaming/projection'
import type { KafkaMarketRecord, StreamingUniverse } from '../src/market-data/streaming/raw-events'

/**
 * Offline full-reducer comparison. Pass a bundled projection module from the base
 * revision. Both versions receive the same prebuilt synthetic records; validation,
 * hashing, immutable map updates and retention are included in the timed region.
 */
const baselinePath = process.argv[2]
if (baselinePath === undefined) throw new Error('Usage: benchmark-bar-projection <baseline-module.mjs>')
const baseline: {
  readonly emptyStreamingProjection: typeof emptyStreamingProjection
  readonly incorporateMarketRecord: typeof incorporateMarketRecord
} = await import(pathToFileURL(resolve(baselinePath)).href)
if (typeof baseline.emptyStreamingProjection !== 'function' || typeof baseline.incorporateMarketRecord !== 'function')
  throw new Error('Baseline module does not export the projection reducer')

const start = Date.parse('2026-10-12T13:30:00.000Z')
const universe: StreamingUniverse = {
  universeId: 'synthetic-bar-benchmark',
  universeSymbolHash: 'a'.repeat(64),
  symbols: ['AAPL'],
  topics: { bars: 'test.bars', quotes: 'test.quotes', trades: 'test.trades', features: 'test.features' },
}
const bar = (offset: number, minute: number, price = 100): KafkaMarketRecord => {
  const eventTs = new Date(start + minute * 60_000).toISOString()
  return {
    topic: universe.topics.bars,
    partition: 0,
    offset: String(offset),
    value: JSON.stringify({
      provider: 'alpaca',
      feed: 'iex',
      delayClass: 'real_time_exchange_only',
      marketSession: 'regular',
      channel: 'bars',
      symbol: 'AAPL',
      eventTs,
      ingestTs: new Date(start + 1000 * 60_000 + offset * 1000).toISOString(),
      version: 2,
      isFinal: true,
      payload: { o: price, h: 110, l: 90, c: 100, v: 10, vw: 100, n: 2, t: eventTs },
    }),
  }
}
const other = (channel: 'quotes' | 'trades', offset: number): KafkaMarketRecord => {
  const eventTs = new Date(start + offset * 1000).toISOString()
  return {
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
      eventTs,
      ingestTs: eventTs,
      version: 2,
      payload:
        channel === 'quotes' ? { bp: 100, ap: 101, bs: 100, as: 100, t: eventTs } : { p: 100, s: 100, t: eventTs },
    }),
  }
}
const availableAtMs = start + 100_000_000
const seed = (revisions: number) =>
  Array.from({ length: 61 * revisions }, (_, index) => bar(index, Math.floor(index / revisions)))
const sparse = seed(1)
const dense = seed(4)
const lastDense = dense.at(-1)
if (lastDense === undefined) throw new Error('Expected nonempty seed')
const scenarios = [
  {
    name: '61-row append',
    seed: sparse,
    records: Array.from({ length: 256 }, (_, index) => bar(1000 + index, 61 + index)),
  },
  {
    name: '244-row corrections',
    seed: dense,
    records: Array.from({ length: 256 }, (_, index) => bar(1000 + index, index % 61, 98 + (index % 5))),
  },
  {
    name: '244-row out-of-order',
    seed: dense,
    records: Array.from({ length: 256 }, (_, index) => bar(1000 + index, ((index * 97) % 261) - 100)),
  },
  { name: 'duplicate delivery', seed: dense, records: Array.from({ length: 256 }, () => lastDense) },
  {
    name: '90% quotes / 9% trades / 1% bars',
    seed: sparse,
    records: Array.from({ length: 1000 }, (_, index) =>
      index % 100 === 0
        ? bar(1000 + index, 61 + index / 100)
        : other(index % 10 === 0 ? 'trades' : 'quotes', 1000 + index),
    ),
  },
]
const implementations = {
  baseline,
  candidate: { emptyStreamingProjection, incorporateMarketRecord },
}
const run = (
  implementation: typeof baseline,
  state: ReturnType<typeof emptyStreamingProjection>,
  records: readonly KafkaMarketRecord[],
) => {
  for (const record of records) state = implementation.incorporateMarketRecord(state, record, universe, availableAtMs)
  return state
}
const median = (values: readonly number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
for (const scenario of scenarios) {
  const initial = {
    baseline: run(baseline, baseline.emptyStreamingProjection('benchmark'), scenario.seed),
    candidate: run(implementations.candidate, emptyStreamingProjection('benchmark'), scenario.seed),
  }
  assert.deepEqual(initial.candidate, initial.baseline)
  assert.equal(initial.candidate.rejections.size, 0)
  let before = initial.baseline
  let after = initial.candidate
  for (const record of scenario.records) {
    const previousBefore = before
    const previousAfter = after
    before = baseline.incorporateMarketRecord(before, record, universe, availableAtMs)
    after = incorporateMarketRecord(after, record, universe, availableAtMs)
    assert.deepEqual(after, before)
    assert.equal(after === previousAfter, before === previousBefore)
    assert.equal(after.bars === previousAfter.bars, before.bars === previousBefore.bars)
  }
  assert.equal(after.rejections.size, 0)
  for (const history of initial.candidate.bars.values()) Object.freeze(history)
  for (const history of initial.baseline.bars.values()) Object.freeze(history)
  for (let warmup = 0; warmup < 10; warmup++) {
    run(baseline, initial.baseline, scenario.records)
    run(implementations.candidate, initial.candidate, scenario.records)
  }
  const samples = { baseline: [] as number[], candidate: [] as number[] }
  const cpuSamples = { baseline: [] as number[], candidate: [] as number[] }
  const iterations = 20
  for (let round = 0; round < 7; round++) {
    const order = round % 2 === 0 ? (['baseline', 'candidate'] as const) : (['candidate', 'baseline'] as const)
    for (const name of order) {
      const cpu = process.cpuUsage()
      const began = performance.now()
      let checksum = 0
      for (let iteration = 0; iteration < iterations; iteration++)
        checksum += run(implementations[name], initial[name], scenario.records).sequence
      const elapsed = performance.now() - began
      const consumed = process.cpuUsage(cpu)
      assert(checksum > 0)
      samples[name].push((elapsed * 1000) / (iterations * scenario.records.length))
      cpuSamples[name].push((consumed.user + consumed.system) / (iterations * scenario.records.length))
    }
  }
  const summarize = (values: readonly number[]) => ({
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
  })
  console.log(
    JSON.stringify({
      scenario: scenario.name,
      runtime: process.version,
      recordsPerSample: iterations * scenario.records.length,
      samples: 7,
      baselineUs: summarize(samples.baseline),
      candidateUs: summarize(samples.candidate),
      baselineCpuUs: summarize(cpuSamples.baseline),
      candidateCpuUs: summarize(cpuSamples.candidate),
      speedup: median(samples.baseline) / median(samples.candidate),
      equivalence: 'exact full state and unchanged-history identities at every step',
    }),
  )
}
