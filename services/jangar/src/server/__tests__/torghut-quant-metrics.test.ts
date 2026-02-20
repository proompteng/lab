import { describe, expect, it } from 'vitest'

import { __private } from '../torghut-quant-metrics'

describe('torghut quant metrics helpers', () => {
  it('computes gross/net exposure and concentration from alpaca positions', () => {
    const positions = [
      { symbol: 'AAPL', market_value: '1000' },
      { symbol: 'MSFT', market_value: '-250' },
      { symbol: 'TSLA', market_value: 750 },
    ]

    const exposure = __private.computeExposure(positions)
    expect(exposure.grossExposure).toBe(2000)
    expect(exposure.netExposure).toBe(1500)
    expect(exposure.positionCount).toBe(3)
    expect(exposure.top1Pct).toBeCloseTo(0.5, 6) // 1000 / 2000
    expect(exposure.top5Pct).toBeCloseTo(1, 6) // all positions
  })

  it('computes max drawdown from an equity curve', () => {
    const series = [
      { asOf: '2026-02-12T00:00:00.000Z', equity: 100 },
      { asOf: '2026-02-12T00:01:00.000Z', equity: 110 },
      { asOf: '2026-02-12T00:02:00.000Z', equity: 99 },
      { asOf: '2026-02-12T00:03:00.000Z', equity: 105 },
    ]

    const dd = __private.computeMaxDrawdown(series)
    // Peak 110 to trough 99 => -10%
    expect(dd.maxDrawdown).toBeCloseTo(-0.1, 6)
    expect(dd.drawdownDurationMinutes).toBe(1)
  })

  it('computes route provenance continuity ratios from execution metadata', () => {
    const route = __private.computeRouteProvenance([
      {
        executionId: 'e-1',
        tradeDecisionId: 'd-1',
        strategyId: 's-1',
        strategyName: 's',
        createdAt: '2026-02-18T15:00:00.000Z',
        symbol: 'AAPL',
        side: 'buy',
        filledQty: 1,
        avgFillPrice: 100,
        timeframe: '1m',
        alpacaAccountLabel: 'paper',
        executionExpectedAdapter: 'lean',
        executionActualAdapter: 'lean',
        executionFallbackCount: 0,
      },
      {
        executionId: 'e-2',
        tradeDecisionId: 'd-2',
        strategyId: 's-1',
        strategyName: 's',
        createdAt: '2026-02-18T15:01:00.000Z',
        symbol: 'MSFT',
        side: 'buy',
        filledQty: 1,
        avgFillPrice: 100,
        timeframe: '1m',
        alpacaAccountLabel: 'paper',
        executionExpectedAdapter: 'lean',
        executionActualAdapter: 'alpaca',
        executionFallbackCount: 1,
      },
      {
        executionId: 'e-3',
        tradeDecisionId: 'd-3',
        strategyId: 's-1',
        strategyName: 's',
        createdAt: '2026-02-18T15:02:00.000Z',
        symbol: 'NVDA',
        side: 'buy',
        filledQty: 1,
        avgFillPrice: 100,
        timeframe: '1m',
        alpacaAccountLabel: 'paper',
        executionExpectedAdapter: 'unknown',
        executionActualAdapter: 'unknown',
        executionFallbackCount: 0,
      },
      {
        executionId: 'e-4',
        tradeDecisionId: 'd-4',
        strategyId: 's-1',
        strategyName: 's',
        createdAt: '2026-02-18T15:03:00.000Z',
        symbol: 'TSLA',
        side: 'buy',
        filledQty: 1,
        avgFillPrice: 100,
        timeframe: '1m',
        alpacaAccountLabel: 'paper',
        executionExpectedAdapter: null,
        executionActualAdapter: 'lean',
        executionFallbackCount: 0,
      },
    ])

    expect(route.routeTotal).toBe(4)
    expect(route.routeCoverageRatio).toBeCloseTo(0.75, 6)
    expect(route.routeUnknownRatio).toBeCloseTo(0.25, 6)
    expect(route.routeFallbackRatio).toBeCloseTo(0.25, 6)
  })
})
