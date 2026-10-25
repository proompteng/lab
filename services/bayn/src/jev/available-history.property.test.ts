import { JevPurpose } from './portfolio'
import { expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { reproduceStreamingSnapshot } from '../market-data/streaming/replay'
import { checkProperty } from '../testing/property-test-support'
import { streamingFixture, streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { jevObservationForSnapshot, nativeJevBatchResult, nativeJevFixture } from './native.test-support'
import { decideJevEntry } from './decision'
import { JevBatchPlanVersion } from './batch'
import { makeJevObservation } from './observation'
import { makeJevEntryQuery } from './observation-query'
import { defaultJevProtocolDocument } from './protocol'
import { jevSignalFor, makeJevTradingSignalBatch, makeJevTradingSignalRequest } from './trading-signals'
import type { VerifiedStrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import { constructStreamingSnapshot } from '../market-data/streaming/snapshot'

const base = streamingFixture()
const observationBase = Result.getOrThrow(jevObservationForSnapshot(base.snapshot)).payload
const requestFor = (snapshot: VerifiedStrategyMarketSnapshot, symbol: string) =>
  makeJevObservation({ ...observationBase, snapshot }).pipe(
    Result.flatMap((observation) => makeJevTradingSignalRequest(observation.payload, symbol)),
  )
const endMs = Date.parse(base.query.rangeEndAt)
const iso = (ms: number) => new Date(ms).toISOString()

test('property: a valid chosen model action controls entry without an additional probability floor', () => {
  const fixture = nativeJevFixture(undefined, undefined, 'jev-native-test', {
    ...defaultJevProtocolDocument,
    candidateSymbols: ['AAPL'],
  })
  const observation = fixture.observation.payload
  const decidedAt = new Date(Date.parse(observation.observedAt) + 100).toISOString()
  const batchPlan = Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation,
      expiresAt: new Date(Date.parse(observation.observedAt) + fixture.protocol.inferenceValidityMs).toISOString(),
      planVersion: JevBatchPlanVersion.V6,
    }),
  )
  checkProperty(
    'jev-chosen-entry-action',
    fc.property(fc.constantFrom('enter', 'wait', 'avoid'), fc.integer({ min: 334, max: 649 }), (action, score) => {
      const target = Result.getOrThrow(
        decideJevEntry({
          observation,
          batchPlan,
          batchResult: nativeJevBatchResult(batchPlan, decidedAt, () => action, score / 1000),
          decidedAt,
        }),
      )
      expect(target.selectedSymbols).toEqual(action === 'enter' ? ['AAPL'] : [])
      const weight = Object.values(target.targetWeights).reduce((sum, value) => sum + value, 0)
      expect(weight).toBeLessThanOrEqual(0.2)
      expect(action === 'enter' ? weight > 0 : weight === 0).toBe(true)
    }),
  )
}, 150_000)
interface History {
  readonly minutes: number
  readonly candidateMinutes: readonly boolean[]
  readonly benchmarkMinutes: readonly boolean[]
  readonly backfillDelayMs: number
}
const history: fc.Arbitrary<History> = fc.record({
  minutes: fc.integer({ min: 1, max: 30 }),
  candidateMinutes: fc.array(fc.boolean(), { minLength: 29, maxLength: 29 }),
  benchmarkMinutes: fc.array(fc.boolean(), { minLength: 29, maxLength: 29 }),
  backfillDelayMs: fc.integer({ min: 0, max: 1999 }),
})

const sparseFixture = (input: History) => {
  const query = {
    ...base.query,
    symbols: ['AAPL', 'AMZN', 'SPY'],
    candidateSymbols: ['AAPL', 'AMZN'],
  }
  const bars = base.archive.bars
    .filter((bar) => {
      if (!query.symbols.includes(bar.symbol)) return false
      const minutesAgo = (endMs - Date.parse(bar.eventAt)) / 60_000
      const present = bar.symbol === 'SPY' ? input.benchmarkMinutes : input.candidateMinutes
      return minutesAgo <= input.minutes && (minutesAgo === 1 || present[minutesAgo - 2] === true)
    })
    .map((bar) =>
      Date.parse(bar.eventAt) === endMs - 60_000 ? bar : { ...bar, ingestedAt: iso(endMs + input.backfillDelayMs) },
    )
  return {
    query,
    raw: {
      bars,
      quotes: base.archive.quotes.filter((quote) => query.symbols.includes(quote.symbol)),
      trades: base.archive.trades.filter((trade) => query.symbols.includes(trade.symbol)),
    },
  }
}

test('property: sparse observed history admits actual completed bars and reproduces their exact evidence', () => {
  checkProperty(
    'jev-available-history-replay',
    fc.property(history, (input) => {
      const { raw, query } = sparseFixture(input)
      const { snapshot, rows } = streamingFixtureFromRaw(raw, query)
      expect(snapshot.manifest.candidateExclusions).toEqual([])
      for (const symbol of query.symbols) {
        const bars = raw.bars.filter((bar) => bar.symbol === symbol)
        const state = Result.getOrThrow(jevSignalFor(snapshot, symbol)).state
        expect(state.priceWindow.observedBarCount).toBe(bars.length)
        expect(state.priceWindow.referenceAt).toBe(bars[0]?.eventAt)
        expect(state.priceWindow.missingMinuteAt).toHaveLength(30 - bars.length)
        expect(state.bars1m).toHaveLength(bars.length)
        for (const minutes of [1, 5, 15, 30]) {
          const reference = bars.find((bar) => Date.parse(bar.eventAt) === endMs - minutes * 60_000)
          expect(state.returnsBps[String(minutes)] === null).toBe(reference === undefined)
        }
      }
      const request = Result.getOrThrow(requestFor(snapshot, 'AAPL'))
      const state = JSON.parse(request.body).state
      const common = raw.bars.find(
        (bar) =>
          bar.symbol === 'AAPL' && raw.bars.some((other) => other.symbol === 'SPY' && other.eventAt === bar.eventAt),
      )
      expect(state.relativeSignals.referenceAt).toBe(common?.eventAt)
      const replay = Result.getOrThrow(reproduceStreamingSnapshot(snapshot.manifest, rows))
      expect(replay.manifest.snapshotId).toBe(snapshot.manifest.snapshotId)
      expect(replay.bars).toEqual(snapshot.bars)
    }),
  )
})

test('property: historical coverage never substitutes for the latest completed candidate or benchmark minute', () => {
  checkProperty(
    'jev-available-history-current-minute',
    fc.property(history, (input) => {
      const { raw, query } = sparseFixture(input)
      const withoutLatest = (symbol: string) => ({
        ...raw,
        bars: raw.bars.filter((bar) => bar.symbol !== symbol || Date.parse(bar.eventAt) !== endMs - 60_000),
      })
      const { snapshot } = streamingFixtureFromRaw(withoutLatest('AAPL'), query)
      expect(snapshot.manifest.candidateExclusions?.map((entry) => entry.symbol)).toEqual(['AAPL'])
      expect(Result.isFailure(requestFor(snapshot, 'AAPL'))).toBe(true)
      expect(() => streamingFixtureFromRaw(withoutLatest('SPY'), query)).toThrow()
    }),
  )
})

test('property: a replay cannot authorize bars whose recorded arrival is after the observation cut', () => {
  checkProperty(
    'jev-available-history-future-arrival',
    fc.property(history, fc.integer({ min: 1, max: 60_000 }), (input, futureMs) => {
      const { raw, query } = sparseFixture(input)
      const { snapshot, rows, cut } = streamingFixtureFromRaw(raw, query)
      const availableAtMs = Date.parse(query.observedAt) + futureMs
      const futureManifest = {
        ...snapshot.manifest,
        streaming: {
          ...snapshot.manifest.streaming,
          features: snapshot.manifest.streaming.features.map((receipt) => ({ ...receipt, availableAtMs })),
        },
      }
      expect(Result.isFailure(reproduceStreamingSnapshot(futureManifest, rows))).toBe(true)
      const futureCut = {
        ...cut,
        projection: {
          ...cut.projection,
          bars: new Map(
            [...cut.projection.bars].map(([symbol, bars]) => [symbol, bars.map((bar) => ({ ...bar, availableAtMs }))]),
          ),
        },
      }
      expect(Result.isFailure(constructStreamingSnapshot(futureCut, query))).toBe(true)
    }),
  )
})

test('property: exchange queries admit the first completed minute and clamp context to the actual open', () => {
  checkProperty(
    'jev-available-history-session-boundary',
    fc.property(fc.integer({ min: 1, max: 120 }), fc.integer({ min: 0, max: 59_999 }), (minutes, extraMs) => {
      const openMs = Date.parse('2026-09-04T13:30:00Z')
      const query = makeJevEntryQuery({
        protocol: defaultJevProtocolDocument,
        calendar: base.query.calendar,
        sessionDate: base.query.sessionDate,
        observedAtMs: openMs + minutes * 60_000 + 2000 + extraMs,
        candidates: ['AAPL'],
      })
      expect(query.rangeEndAt).toBe(iso(openMs + minutes * 60_000))
      expect(query.rangeStartAt).toBe(iso(openMs + Math.max(0, minutes - 30) * 60_000))
    }),
  )
})

test('property: settled entry cash fees cannot alter a future management judgment', () => {
  const fixture = nativeJevFixture(JevPurpose.Manage)
  const portfolio = fixture.portfolio
  if (portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected a held position')
  const baseline = Result.getOrThrow(makeJevTradingSignalRequest(fixture.observation.payload, 'AAPL'))
  checkProperty(
    'jev-management-sunk-cost-independence',
    fc.property(fc.integer({ min: 0, max: 100_000_000 }), (feeMicros) => {
      const observation = Result.getOrThrow(
        makeJevObservation({
          ...fixture.input,
          portfolio: {
            ...portfolio,
            entryFills: portfolio.entryFills.map((fill) => ({ ...fill, feeMicros: String(feeMicros) })),
          },
        }),
      )
      const actual = Result.getOrThrow(makeJevTradingSignalRequest(observation.payload, 'AAPL'))
      expect(actual.requestHash).toBe(baseline.requestHash)
      expect(actual.body).toBe(baseline.body)
      expect(observation.payload.portfolio).toMatchObject({
        entryFills: portfolio.entryFills.map((fill) => ({ ...fill, feeMicros: String(feeMicros) })),
      })
    }),
  )
}, 150_000)
