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
})
