import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { simulationFixture } from '../../testing/simulated-streaming-fixture'
import { persistIntradayRecordRows } from '../intraday/verification'
import { executionMarketDataBinding } from '../../observe-composition/intraday-market-data'
import { reconstructBoundIntradaySnapshot } from '../../shadow-decision-contract'
import { constructSimulatedSnapshot, constructStreamingSnapshot } from './snapshot'
import { reproduceSimulatedSnapshot } from './replay'
import { streamingFixture } from '../../testing/streaming-market-fixture'

test('simulated input cut round trips through execution binding with original timestamps and no live authority', () => {
  const fixture = simulationFixture(Date.parse('2026-09-12T12:00:00Z'))
  const snapshot = Result.getOrThrow(constructSimulatedSnapshot(fixture.cursor, fixture.source, fixture.query))
  const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
  expect(snapshot.manifest.schemaVersion).toBe('bayn.simulated-market-snapshot.v1')
  expect(snapshot.manifest.streaming.features).toHaveLength(7)
  expect(
    snapshot.manifest.streaming.features.every(
      ({ value }) => value.computedAtMs === fixture.source.regeneratedFeaturesRecordedAtMs,
    ),
  ).toBe(true)
  expect(Result.getOrThrow(reproduceSimulatedSnapshot(snapshot.manifest, rows)).manifest).toEqual(snapshot.manifest)
  const binding = Result.getOrThrow(executionMarketDataBinding(snapshot))
  expect(binding.schemaVersion).toBe('bayn.execution-market-data-binding.v4')
  if (binding.schemaVersion !== 'bayn.execution-market-data-binding.v4') throw new Error('wrong binding')
  expect(reconstructBoundIntradaySnapshot(binding, rows)?.manifest).toEqual(snapshot.manifest)
  const live = streamingFixture()
  expect(
    Result.isFailure(constructStreamingSnapshot({ ...live.cut, projection: fixture.cursor.projection }, fixture.query)),
  ).toBe(true)
})

test('simulation rejects wrong run, changed payload, future cut, and noncanonical source positions', () => {
  const { cursor, source, query } = simulationFixture()
  expect(Result.isFailure(constructSimulatedSnapshot(cursor, { ...source, runId: 'f'.repeat(64) }, query))).toBe(true)
  expect(
    Result.isFailure(constructSimulatedSnapshot(cursor, source, { ...query, observedAt: '2026-09-04T14:30:00.000Z' })),
  ).toBe(true)
  const snapshot = Result.getOrThrow(constructSimulatedSnapshot(cursor, source, query))
  const rows = Result.getOrThrow(persistIntradayRecordRows(snapshot))
  expect(Result.isFailure(reproduceSimulatedSnapshot(snapshot.manifest, { ...rows, quotes: [] }))).toBe(true)
  const positions = snapshot.manifest.streaming.positions
  expect(
    Result.isFailure(
      reproduceSimulatedSnapshot(
        { ...snapshot.manifest, streaming: { ...snapshot.manifest.streaming, positions: [...positions].reverse() } },
        rows,
      ),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      reproduceSimulatedSnapshot(
        {
          ...snapshot.manifest,
          streaming: {
            ...snapshot.manifest.streaming,
            positions: positions.map((value) => ({ ...value, offset: '0' })),
          },
        },
        rows,
      ),
    ),
  ).toBe(true)
})
