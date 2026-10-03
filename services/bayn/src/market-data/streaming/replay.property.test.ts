import { expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { canonicalHashV1 } from '../../hash'
import { checkProperty } from '../../testing/property-test-support'
import { streamingFixture } from '../../testing/streaming-market-fixture'
import { reproduceStreamingSnapshot } from './replay'
import { decodeIntradayBarRows } from '../intraday/rows'

test('property: retained receipt order reproduces a snapshot independently of physical row order', () => {
  checkProperty(
    'streaming-replay-order',
    fc.property(
      fc.integer({ min: -500, max: 500 }),
      fc.integer({ min: -500, max: 500 }),
      fc.nat(),
      (firstReturn, secondReturn, seed) => {
        const { snapshot, rows } = streamingFixture({ AAPL: firstReturn / 10_000, AMZN: secondReturn / 10_000 })
        const shuffle = <T>(values: readonly T[]): T[] =>
          fc.sample(fc.shuffledSubarray([...values], { minLength: values.length, maxLength: values.length }), {
            seed,
            numRuns: 1,
          })[0]
        const reordered = { bars: shuffle(rows.bars), quotes: shuffle(rows.quotes), trades: shuffle(rows.trades) }
        // Arrival order remains bound by retained receipts; only storage enumeration is permuted.
        const replay = Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, reordered))
        expect(replay).toEqual(snapshot)
        expect(canonicalHashV1(replay.manifest)).toBe(canonicalHashV1(snapshot.manifest))
        const index = seed % rows.bars.length
        const tampered = {
          ...reordered,
          bars: Result.getOrThrow(decodeIntradayBarRows(reordered.bars)).map((row, rowIndex) =>
            rowIndex === index ? { ...row, volume: Number(row.volume) + 1 } : row,
          ),
        }
        expect(reproduceStreamingSnapshot(snapshot.manifest, tampered)).toMatchObject({ _tag: 'Failure' })
        expect(reproduceStreamingSnapshot(snapshot.manifest, { ...reordered, quotes: [] })).toMatchObject({
          _tag: 'Failure',
        })
      },
    ),
    20,
  )
}, 150_000)
