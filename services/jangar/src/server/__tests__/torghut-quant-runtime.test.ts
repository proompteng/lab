import { describe, expect, it } from 'vitest'

import { __private } from '../torghut-quant-runtime'

describe('torghut quant runtime account selection', () => {
  it('always includes aggregate account frame when no accounts are present', () => {
    expect(__private.resolveStrategyAccountsForCompute([])).toEqual([''])
  })

  it('includes aggregate frame plus all non-empty account labels', () => {
    expect(__private.resolveStrategyAccountsForCompute(['paper-a', ' paper-b ', ''])).toEqual([
      '',
      'paper-a',
      'paper-b',
    ])
  })

  it('marks drawdown and sharpe alerts with required consecutive-frame thresholds', () => {
    const alerts = __private.evaluateAlerts({
      nowIso: '2026-02-18T15:00:00.000Z',
      policy: {
        maxDrawdown1d: 0.05,
        minSharpe5d: 0.5,
        maxSlippageBps15m: 50,
        maxRejectRate15m: 0.02,
        maxPipelineLagSeconds: 15,
        maxTaFreshnessSeconds: 120,
      },
      frame: {
        strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        account: 'paper',
        window: '1d',
        frameAsOf: '2026-02-18T15:00:00.000Z',
        alerts: [],
        metrics: [
          {
            metricName: 'max_drawdown',
            window: '1d',
            unit: 'ratio',
            valueNumeric: -0.08,
            status: 'ok',
            quality: 'good',
            formulaVersion: 'v1',
            asOf: '2026-02-18T15:00:00.000Z',
            freshnessSeconds: 0,
          },
        ],
      },
    })

    expect(alerts[0]?.breachKey).toBe('max_drawdown')
    expect(alerts[0]?.minConsecutive).toBe(2)
  })
})
