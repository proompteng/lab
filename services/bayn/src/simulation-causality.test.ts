import { describe, expect, test } from 'bun:test'

import { defaultExecutionModel, MICROS } from './execution-model'
import { canonicalHashV1 } from './hash'
import { simulate, type AlignedSession, type SimulationTarget } from './simulation'
import { fixtureProtocol } from './test-fixtures'
import {
  DataFeed,
  DataSource,
  PriceAdjustment,
  PublicationSchema,
  type DecisionPlan,
  type IsoDate,
  type SimulationProtocol,
} from './types'

const symbols = ['AAA', 'BBB'] as const

const bar = (symbol: string, sessionDate: IsoDate, open: number, close = 100) => ({
  symbol,
  sessionDate,
  open,
  high: Math.max(open, close),
  low: Math.min(open, close),
  close,
  volume: 1_000_000,
  source: DataSource.Alpaca,
  sourceFeed: DataFeed.Sip,
  adjustment: PriceAdjustment.All,
  publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
})

const sessions = (secondOpen = 100): readonly AlignedSession[] => [
  {
    date: '2026-01-02',
    bars: Object.fromEntries(symbols.map((symbol) => [symbol, bar(symbol, '2026-01-02', 100)])),
  },
  {
    date: '2026-01-05',
    bars: Object.fromEntries(symbols.map((symbol) => [symbol, bar(symbol, '2026-01-05', secondOpen)])),
  },
  {
    date: '2026-01-06',
    bars: Object.fromEntries(symbols.map((symbol) => [symbol, bar(symbol, '2026-01-06', 100)])),
  },
]

const plan = (signalDate: IsoDate, targetWeights: Readonly<Record<string, number>>): DecisionPlan => ({
  schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1',
  signalDate,
  covarianceWindow: {
    returnCount: 1,
    firstSession: signalDate,
    lastSession: signalDate,
    sessionsHash: canonicalHashV1([signalDate]),
  },
  estimatedAnnualizedPortfolioVolatility: 0,
  exposureScale: 1,
  targetWeights,
  signals: symbols.map((symbol) => ({
    symbol,
    horizons: [{ horizonSessions: 1, return: 0, normalizedTrend: 0 }],
    dailyVolatility: 0,
    annualizedVolatility: 0,
    compositeScore: 0,
    positiveScore: 0,
    eligible: true,
    uncappedWeight: targetWeights[symbol],
    cappedWeight: targetWeights[symbol],
    targetWeight: targetWeights[symbol],
  })),
})

const protocol: SimulationProtocol = {
  universe: symbols,
  directVolatilityTarget: fixtureProtocol.directVolatilityTarget,
  initialCapitalMicros: (100n * MICROS).toString(),
  executionModel: {
    ...defaultExecutionModel,
    partialFills: { ...defaultExecutionModel.partialFills, probabilityPpm: 0 },
  },
  thresholds: fixtureProtocol.thresholds,
}

const targets: readonly SimulationTarget[] = [
  {
    signalIndex: 0,
    executionIndex: 1,
    weights: { AAA: 1, BBB: 0 },
    decision: plan('2026-01-02', { AAA: 1, BBB: 0 }),
  },
  {
    signalIndex: 1,
    executionIndex: 2,
    weights: { AAA: 0, BBB: 1 },
    decision: plan('2026-01-05', { AAA: 0, BBB: 1 }),
  },
]

const run = (input: readonly AlignedSession[]) => simulate(input, targets, 1, protocol, MICROS, 'a'.repeat(64), true)

const requests = (result: ReturnType<typeof run>, sessionDate: IsoDate) =>
  result.simulation?.orders
    .filter((order) => order.sessionDate === sessionDate)
    .map(({ decisionId, sessionDate: date, symbol, side, requestedQuantityMicros }) => ({
      decisionId,
      sessionDate: date,
      symbol,
      side,
      requestedQuantityMicros,
    }))

describe('live-causal simulation', () => {
  test('keeps planned order requests invariant when the unseen execution open changes', () => {
    const baseline = run(sessions())
    const gapped = run(sessions(150))

    expect(requests(gapped, '2026-01-05')).toEqual(requests(baseline, '2026-01-05'))
    expect(gapped.metrics.endingEquityMicros).not.toBe(baseline.metrics.endingEquityMicros)
    expect(gapped.simulation?.orders.some((order) => order.status === 'partially-filled')).toBe(true)
  })

  test('does not fund a planned rotation buy with proceeds from its planned sell', () => {
    const result = run(sessions())
    const rotationOrders = result.simulation?.orders.filter((order) => order.sessionDate === '2026-01-06') ?? []
    const priorCash = result.simulation?.dailyMarks.find((mark) => mark.sessionDate === '2026-01-05')?.cashMicros

    expect(BigInt(priorCash ?? '0')).toBeLessThan(BigInt(defaultExecutionModel.precision.minimumBuyNotionalMicros))
    expect(rotationOrders.some((order) => order.side === 'sell')).toBe(true)
    expect(rotationOrders.some((order) => order.side === 'buy')).toBe(false)
  })
})
