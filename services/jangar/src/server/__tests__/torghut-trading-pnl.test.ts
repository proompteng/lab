import { describe, expect, it } from 'vitest'

import { computeRealizedPnlAverageCostLongOnly } from '~/server/torghut-trading-pnl'

describe('torghut trading pnl', () => {
  it('computes realized pnl with average-cost model (single buy then sell)', () => {
    const result = computeRealizedPnlAverageCostLongOnly([
      {
        executionId: 'e1',
        tradeDecisionId: 'd1',
        strategyId: 's1',
        strategyName: 'S',
        createdAt: '2026-02-10T14:30:00.000Z',
        symbol: 'AAPL',
        side: 'buy',
        filledQty: 10,
        avgFillPrice: 100,
      },
      {
        executionId: 'e2',
        tradeDecisionId: 'd2',
        strategyId: 's1',
        strategyName: 'S',
        createdAt: '2026-02-10T15:30:00.000Z',
        symbol: 'AAPL',
        side: 'sell',
        filledQty: 4,
        avgFillPrice: 110,
      },
    ])

    expect(result.realizedPnl).toBeCloseTo(40, 8)
    expect(result.closedQty).toBeCloseTo(4, 8)
    expect(result.winCount).toBe(1)
    expect(result.lossCount).toBe(0)
    expect(result.winRate).toBeCloseTo(1, 8)
    expect(result.bySymbol.AAPL?.realizedPnl).toBeCloseTo(40, 8)
    expect(result.bySymbol.AAPL?.closedQty).toBeCloseTo(4, 8)
  })

  it('uses average cost across multiple buys', () => {
    const result = computeRealizedPnlAverageCostLongOnly([
      {
        executionId: 'e1',
        tradeDecisionId: 'd1',
        strategyId: 's1',
        strategyName: 'S',
        createdAt: '2026-02-10T14:00:00.000Z',
        symbol: 'MSFT',
        side: 'buy',
        filledQty: 10,
        avgFillPrice: 100,
      },
      {
        executionId: 'e2',
        tradeDecisionId: 'd2',
        strategyId: 's1',
        strategyName: 'S',
        createdAt: '2026-02-10T14:01:00.000Z',
        symbol: 'MSFT',
        side: 'buy',
        filledQty: 10,
        avgFillPrice: 120,
      },
      {
        executionId: 'e3',
        tradeDecisionId: 'd3',
        strategyId: 's1',
        strategyName: 'S',
        createdAt: '2026-02-10T15:00:00.000Z',
        symbol: 'MSFT',
        side: 'sell',
        filledQty: 5,
        avgFillPrice: 130,
      },
    ])

    // avg cost = (10*100 + 10*120)/20 = 110
    // realized pnl = (130-110)*5 = 100
    expect(result.realizedPnl).toBeCloseTo(100, 8)
    expect(result.closedQty).toBeCloseTo(5, 8)
    expect(result.winRate).toBeCloseTo(1, 8)
  })

  it('clamps sells beyond current position and records a warning', () => {
    const result = computeRealizedPnlAverageCostLongOnly([
      {
        executionId: 'e1',
        tradeDecisionId: 'd1',
        strategyId: 's1',
        strategyName: 'S',
        createdAt: '2026-02-10T14:00:00.000Z',
        symbol: 'NVDA',
        side: 'buy',
        filledQty: 3,
        avgFillPrice: 200,
      },
      {
        executionId: 'e2',
        tradeDecisionId: 'd2',
        strategyId: 's1',
        strategyName: 'S',
        createdAt: '2026-02-10T14:30:00.000Z',
        symbol: 'NVDA',
        side: 'sell',
        filledQty: 5,
        avgFillPrice: 210,
      },
    ])

    // realized qty clamps to 3
    expect(result.realizedPnl).toBeCloseTo(30, 8)
    expect(result.closedQty).toBeCloseTo(3, 8)
    expect(result.warnings.some((warning) => warning.includes('exceeds position'))).toBe(true)
  })
})
