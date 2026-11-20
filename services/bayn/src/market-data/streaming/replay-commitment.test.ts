import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result, canonicalJsonV1Result } from '../../hash'
import { simulationFixture } from '../../testing/simulated-streaming-fixture'
import { streamingFixture } from '../../testing/streaming-market-fixture'
import { persistIntradayRecordRows } from '../intraday/verification'
import type { IntradaySnapshotFailure } from '../intraday/model'
import { reproduceSimulatedSnapshot, reproduceStrategySnapshot, reproduceStreamingSnapshot } from './replay'
import { constructSimulatedSnapshot, type StrategyMarketSnapshot } from './snapshot'

const hash = (input: unknown) => Result.getOrThrow(canonicalHashV1Result(input))
const canonical = (input: unknown) => Result.getOrThrow(canonicalJsonV1Result(input))
const fixtures: Array<() => StrategyMarketSnapshot> = [
  () => streamingFixture().snapshot,
  () => {
    const { cursor, source, query } = simulationFixture()
    return Result.getOrThrow(constructSimulatedSnapshot(cursor, source, query))
  },
]

const different = (input: unknown): unknown => {
  if (typeof input === 'string') return `${input}0`
  if (typeof input === 'number') return input + 1
  if (typeof input === 'boolean') return !input
  if (Array.isArray(input)) return input.length === 0 ? ['unexpected'] : [different(input[0]), ...input.slice(1)]
  if (input !== null && typeof input === 'object') {
    const first = Object.entries(input)[0]
    if (first !== undefined) return { ...input, [first[0]]: different(first[1]) }
    return { unexpected: true }
  }
  return 'unexpected'
}

test.each(fixtures)('reproduces original manifest bytes and binds every supplied field: %p', (fixture) => {
  const snapshot = fixture()
  const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
  expect(canonical(Result.getOrThrow(reproduceStrategySnapshot(snapshot.manifest, rows)).manifest)).toBe(
    canonical(snapshot.manifest),
  )
  for (const [key, value] of Object.entries(snapshot.manifest)) {
    const altered = { ...snapshot.manifest, [key]: different(value) }
    expect(Result.isFailure(reproduceStrategySnapshot(altered, rows)), key).toBe(true)
  }
  for (const [key, value] of Object.entries(snapshot.manifest.streaming)) {
    const altered = {
      ...snapshot.manifest,
      streaming: { ...snapshot.manifest.streaming, [key]: different(value) },
    }
    expect(Result.isFailure(reproduceStrategySnapshot(altered, rows)), `streaming.${key}`).toBe(true)
  }
})

test.each(fixtures)(
  'self-consistent supplied hashes cannot replace reconstruction of source material: %p',
  (fixture) => {
    const snapshot = fixture()
    const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
    const { contentHash: _contentHash, snapshotId: _snapshotId, ...material } = snapshot.manifest
    for (const key of [
      'barCount',
      'quoteCount',
      'tradeCount',
      'barsContentHash',
      'quotesContentHash',
      'tradesContentHash',
    ] as const) {
      const altered = { ...material, [key]: different(material[key]) }
      const contentHash = hash(altered)
      const snapshotId = hash({ ...altered, contentHash })
      expect(Result.isFailure(reproduceStrategySnapshot({ ...altered, contentHash, snapshotId }, rows)), key).toBe(true)
    }
  },
)

test.each(fixtures)(
  'direct replay binds all metadata and does not trust a previously verified mutable graph: %p',
  (fixture) => {
    const snapshot = fixture()
    const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
    const manifest = { ...structuredClone(snapshot.manifest) }
    const replay = (): Result.Result<StrategyMarketSnapshot, IntradaySnapshotFailure> =>
      manifest.schemaVersion === 'bayn.streaming-market-snapshot.v1'
        ? reproduceStreamingSnapshot(manifest, rows)
        : reproduceSimulatedSnapshot(manifest, rows)
    expect(canonical(Result.getOrThrow(replay()).manifest)).toBe(canonical(snapshot.manifest))
    manifest.quoteCount += 1
    expect(Result.isFailure(replay())).toBe(true)
    manifest.quoteCount -= 1
    expect(canonical(Result.getOrThrow(replay()).manifest)).toBe(canonical(snapshot.manifest))
    manifest.contentHash = 'f'.repeat(64)
    expect(Result.isFailure(replay())).toBe(true)
    manifest.contentHash = snapshot.manifest.contentHash
    manifest.snapshotId = 'f'.repeat(64)
    expect(Result.isFailure(replay())).toBe(true)
  },
)
