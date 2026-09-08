import { describe, expect, test } from 'bun:test'

import { Result, Schema } from 'effect'

import { strictParseOptions } from '../schemas'
import { PersistedStrategyDecisionSchema, RuntimeStrategyDecisionSchema } from './runtime-decision'

const hash = (character: string): string => character.repeat(64)
const observedAt = '2026-07-22T13:35:01.000Z'

const legacyDecisions = [
  {
    schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1',
    signalDate: '2026-07-22',
    covarianceWindow: {
      returnCount: 1,
      firstSession: '2026-07-21',
      lastSession: '2026-07-22',
      sessionsHash: hash('1'),
    },
    estimatedAnnualizedPortfolioVolatility: 0.1,
    exposureScale: 1,
    targetWeights: { AMD: 0 },
    signals: [
      {
        symbol: 'AMD',
        horizons: [{ horizonSessions: 1, return: 0, normalizedTrend: 0 }],
        dailyVolatility: 0.1,
        annualizedVolatility: 0.1,
        compositeScore: 0,
        positiveScore: 0,
        eligible: true,
        uncappedWeight: 0,
        cappedWeight: 0,
        targetWeight: 0,
      },
    ],
  },
  {
    schemaVersion: 'bayn.opening-drive.target.v1',
    strategy: 'opening-drive-momentum',
    sessionDate: '2026-07-22',
    snapshotId: hash('2'),
    observedAt,
    calendarHash: hash('3'),
    selectedSymbols: [],
    targetWeights: { AMD: 0 },
    signals: [
      {
        symbol: 'AMD',
        openingPriceMicros: '100000000',
        rangeHighPriceMicros: '101000000',
        rangeLowPriceMicros: '99000000',
        bidPriceMicros: '100000000',
        askPriceMicros: '100100000',
        quoteObservedAt: observedAt,
        breakoutTradePriceMicros: '100000000',
        breakoutTradeObservedAt: observedAt,
        openingReturnBps: 0,
        breakoutBps: -100,
        rangeLocationPpm: 500_000,
        spreadBps: 10,
        openingDollarVolumeMicros: '100000000',
        eligible: false,
        rejectionReasons: ['opening-return', 'breakout'],
        rank: null,
      },
    ],
  },
  {
    schemaVersion: 'bayn.intraday-momentum.target.v1',
    strategy: 'intraday-momentum',
    sessionDate: '2026-07-22',
    snapshotId: hash('4'),
    observedAt,
    calendarHash: hash('5'),
    selectedSymbols: [],
    targetWeights: { AMD: 0 },
    signals: [
      {
        symbol: 'AMD',
        referencePriceMicros: '100000000',
        rangeHighPriceMicros: '101000000',
        rangeLowPriceMicros: '99000000',
        bidPriceMicros: '100000000',
        askPriceMicros: '100100000',
        bidSizeMicros: '1000000',
        askSizeMicros: '1000000',
        quoteObservedAt: observedAt,
        confirmationTradePriceMicros: '100000000',
        confirmationTradeObservedAt: observedAt,
        lookbackReturnBps: 0,
        breakoutBps: -100,
        rangeLocationPpm: 500_000,
        spreadBps: 10,
        eligible: false,
        rejectionReasons: ['lookback-return'],
        rank: null,
      },
    ],
  },
] as const

describe('strategy decision persistence boundary', () => {
  test('decodes immutable legacy evidence without making it executable', () => {
    const decodePersisted = Schema.decodeUnknownResult(PersistedStrategyDecisionSchema, strictParseOptions)
    const decodeRuntime = Schema.decodeUnknownResult(RuntimeStrategyDecisionSchema, strictParseOptions)

    for (const decision of legacyDecisions) {
      expect(Result.isSuccess(decodePersisted(decision))).toBeTrue()
      expect(Result.isFailure(decodeRuntime(decision))).toBeTrue()
    }
  })
})
