import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { streamingFixture, streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { reproduceStreamingSnapshot } from '../market-data/streaming/replay'
import { makeJevEntryQuery } from './observation-query'
import { defaultJevProtocolDocument } from './protocol'
import { jevSignalFor } from './trading-signals'
import { jevRequestForSnapshot } from './native.test-support'

test('equity observations start with the first completed minute after the broker open', () => {
  const { query } = streamingFixture()
  const request = makeJevEntryQuery({
    protocol: defaultJevProtocolDocument,
    calendar: query.calendar,
    sessionDate: query.sessionDate,
    observedAtMs: Date.parse('2026-09-04T13:31:02Z'),
    candidates: ['AAPL'],
  })
  expect(request.rangeStartAt).toBe('2026-09-04T13:30:00.000Z')
  expect(request.rangeEndAt).toBe('2026-09-04T13:31:00.000Z')
})

test('sparse real history exposes gaps and leaves absent return horizons unknown', () => {
  const { query, archive } = streamingFixture()
  const { snapshot, rows } = streamingFixtureFromRaw(
    {
      ...archive,
      bars: archive.bars.filter((bar) => bar.symbol !== 'AAPL' || bar.eventAt !== '2026-09-04T14:25:00.000Z'),
    },
    query,
  )
  const signal = Result.getOrThrow(jevSignalFor(snapshot, 'AAPL')).state
  expect(signal.priceWindow.observedBarCount).toBe(29)
  expect(signal.priceWindow.missingMinuteAt).toEqual(['2026-09-04T14:25:00.000Z'])
  expect(signal.returnsBps['5']).toBeNull()
  expect(signal.recent15mVolumeToPrior15m).toBeNull()
  expect(Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows)).manifest.snapshotId).toBe(
    snapshot.manifest.snapshotId,
  )
})

test('candidate and benchmark use the same actual reference minute despite different history starts', () => {
  const { query, archive } = streamingFixture()
  const { snapshot } = streamingFixtureFromRaw(
    {
      ...archive,
      bars: archive.bars.filter(
        (bar) =>
          (bar.symbol !== 'AAPL' || bar.eventAt >= '2026-09-04T14:07:00.000Z') &&
          (bar.symbol !== 'SPY' || bar.eventAt >= '2026-09-04T14:03:00.000Z'),
      ),
    },
    query,
  )
  const request = Result.getOrThrow(jevRequestForSnapshot(snapshot, 'AAPL'))
  const state = JSON.parse(request.body).state
  expect(state.candidate.priceWindow.referenceAt).toBe('2026-09-04T14:07:00.000Z')
  expect(state.benchmark.priceWindow.referenceAt).toBe('2026-09-04T14:03:00.000Z')
  expect(state.relativeSignals.referenceAt).toBe('2026-09-04T14:07:00.000Z')
  expect(state.relativeSignals.lookbackMinutes).toBeCloseTo(23 + 2 / 60)
})

test('late real historical backfill is usable without altering its arrival timestamp', () => {
  const { query, archive } = streamingFixture()
  const { snapshot, rows } = streamingFixtureFromRaw(
    {
      ...archive,
      bars: archive.bars.map((bar) =>
        bar.eventAt === '2026-09-04T14:10:00.000Z' ? { ...bar, ingestedAt: '2026-09-04T14:30:01.000Z' } : bar,
      ),
    },
    query,
  )
  expect(snapshot.manifest.candidateExclusions).toEqual([])
  expect(
    snapshot.bars.find((bar) => bar.symbol === 'AAPL' && bar.eventAt === '2026-09-04T14:10:00.000Z')?.ingestedAt,
  ).toBe('2026-09-04T14:30:01.000Z')
  expect(Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows)).manifest.snapshotId).toBe(
    snapshot.manifest.snapshotId,
  )
})

test('a real completed minute is sufficient and its exact evidence reproduces', () => {
  const { protocol, query } = streamingFixture()
  const request = { ...query, rangeStartAt: '2026-09-04T14:29:00.000Z' }
  const raw = makeIntradayMomentumTestSnapshot(protocol, { ...query, archiveWatermarks: [] }, {})
  const { snapshot, rows } = streamingFixtureFromRaw(
    { ...raw, bars: raw.bars.filter((bar) => Date.parse(bar.eventAt) >= Date.parse(request.rangeStartAt)) },
    request,
  )
  expect(snapshot.manifest.candidateExclusions).toEqual([])
  expect(Result.getOrThrow(jevSignalFor(snapshot, 'AAPL')).state.bars1m).toHaveLength(1)
  expect(Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows)).manifest.snapshotId).toBe(
    snapshot.manifest.snapshotId,
  )
})
