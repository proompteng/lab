import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { jevObservationForSnapshot, jevRequestForSnapshot } from '../../jev/native.test-support'
import { JevBatchPlanVersion, JevCandidatePlanStatus, JevEntryExclusion } from '../../jev/batch'
import { jevSignalFor, jevStalePricingSymbols, makeJevTradingSignalBatch } from '../../jev/trading-signals'
import { cryptoMarketFixture } from '../../testing/crypto-market-fixture'
import { streamingFixture } from '../../testing/streaming-market-fixture'
import { IntradayCandidateEvidencePolicy } from '../intraday/model'
import { persistIntradayRecordRows } from '../intraday/verification'
import { reproduceStreamingSnapshot } from './replay'
import { constructStreamingSnapshot } from './snapshot'

test('crypto with fresh quotes and verified bars reaches assessment without inventing a trade', () => {
  const fixture = cryptoMarketFixture('ETH/USD', { missingTradeSymbols: ['ETH/USD', 'BTC/USD'] })
  const snapshot = Result.getOrThrow(
    constructStreamingSnapshot(fixture.cut, {
      ...fixture.query,
      candidateEvidencePolicy: IntradayCandidateEvidencePolicy.MarketQuotes,
    }),
  )
  expect(snapshot.manifest.candidateExclusions).toEqual([])
  expect(snapshot.trades).toEqual([])
  expect(jevStalePricingSymbols(snapshot)).toEqual([])
  const candidate = Result.getOrThrow(jevSignalFor(snapshot, 'ETH/USD'))
  expect(candidate.prices.trade).toBeNull()
  expect(candidate.state.latestTrade).toBeNull()
  const request = Result.getOrThrow(jevRequestForSnapshot(snapshot, 'ETH/USD'))
  const state = JSON.parse(request.body).numericalState
  expect(state.candidate.latestTrade).toBeNull()
  expect(state.candidate.currentPriceSignals.breakoutPricingBasis).toBe('CURRENT_BID')
  expect(state.units.latestTrade).toContain('null when no actual trade')
  const reproduced = Result.getOrThrow(
    reproduceStreamingSnapshot(snapshot.manifest, Result.getOrThrow(persistIntradayRecordRows(snapshot))),
  )
  expect(reproduced.manifest.snapshotId).toBe(snapshot.manifest.snapshotId)
  expect(reproduced.trades).toEqual([])
})

test('the market policy preserves the equity requirement for an actual window trade', () => {
  const fixture = streamingFixture()
  const tradeHistory = new Map(fixture.cut.projection.tradeHistory)
  tradeHistory.delete('AAPL')
  const snapshot = Result.getOrThrow(
    constructStreamingSnapshot(
      { ...fixture.cut, projection: { ...fixture.cut.projection, tradeHistory } },
      { ...fixture.query, candidateEvidencePolicy: IntradayCandidateEvidencePolicy.MarketQuotes },
    ),
  )
  expect(snapshot.manifest.candidateExclusions).toContainEqual({
    symbol: 'AAPL',
    reason: 'not-ready',
    message: 'intraday snapshot lacks a trade for candidate symbol',
  })
  expect(Result.isFailure(jevRequestForSnapshot(snapshot, 'AAPL'))).toBe(true)
})

test('optional crypto trade context retains the real price and age when present', () => {
  const fixture = cryptoMarketFixture('ETH/USD', { tradeLagMs: 60_000 })
  const snapshot = Result.getOrThrow(
    constructStreamingSnapshot(fixture.cut, {
      ...fixture.query,
      candidateEvidencePolicy: IntradayCandidateEvidencePolicy.MarketQuotes,
    }),
  )
  const trade = snapshot.trades.find((entry) => entry.symbol === 'ETH/USD')
  if (trade === undefined) throw new Error('Expected an actual contextual trade')
  const candidate = Result.getOrThrow(jevSignalFor(snapshot, 'ETH/USD'))
  expect(candidate.state.latestTrade).toEqual({ price: trade.price, size: trade.size, ageMs: 61_000 })
})

test('a missing crypto print cannot admit a stale executable quote', () => {
  expect(() => cryptoMarketFixture('ETH/USD', { quoteLagMs: 10_000, missingTradeSymbols: ['ETH/USD'] })).toThrow(
    'No candidate has complete raw data',
  )
})

test('a missing crypto print cannot admit a quote with no displayed ask size', () => {
  const { snapshot } = cryptoMarketFixture('ETH/USD', { quoteAskSize: 0, missingTradeSymbols: ['ETH/USD'] })
  const observation = Result.getOrThrow(jevObservationForSnapshot(snapshot))
  const batch = Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation: observation.payload,
      expiresAt: new Date(Date.parse(snapshot.manifest.observedAt) + 10_000).toISOString(),
      planVersion: JevBatchPlanVersion.V7,
    }),
  )
  expect(batch.candidates.find((entry) => entry.symbol === 'ETH/USD')).toMatchObject({
    status: JevCandidatePlanStatus.Excluded,
    reason: JevEntryExclusion.DisplayedSize,
  })
})
