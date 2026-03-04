import { describe, expect, it } from 'vitest'

import { __private } from '../torghut-trading'

const rollingTrendInterval = {
  tz: 'America/New_York',
  startUtc: '2026-01-15T05:00:00.000Z',
  endUtc: '2026-01-16T05:00:00.000Z',
}

describe('torghut trading summary reason parsing', () => {
  it('splits semicolon-delimited risk reasons into individual tokens', () => {
    expect(__private.splitRiskReason('shorts_not_allowed;symbol_capacity_exhausted')).toEqual([
      'shorts_not_allowed',
      'symbol_capacity_exhausted',
    ])
  })

  it('keeps single reasons unchanged', () => {
    expect(__private.splitRiskReason('llm_error')).toEqual(['llm_error'])
  })

  it('classifies market session by post-open and pre-open rules', () => {
    expect(__private.classifySessionByMarketTime('2026-01-15T13:45:00.000Z', rollingTrendInterval.tz)).toBe('pre-open')
    expect(__private.classifySessionByMarketTime('2026-01-15T14:30:00.000Z', rollingTrendInterval.tz)).toBe('post-open')
    expect(__private.classifySessionByMarketTime('2026-01-15T18:00:00.000Z', rollingTrendInterval.tz)).toBe('post-open')
  })

  it('builds a bounded 5-day rejection trend with per-day session split', () => {
    const trend = __private.buildRolling5DayRejectionTrend(
      [
        {
          id: '1',
          createdAt: '2026-01-11T14:10:00.000Z',
          alpacaAccountLabel: 'paper',
          symbol: 'ABC',
          timeframe: '1m',
          status: 'rejected',
          rationale: null,
          riskReasons: ['shorts_not_allowed;llm_error'],
          strategyId: '1',
          strategyName: 'test',
        },
        {
          id: '2',
          createdAt: '2026-01-12T14:45:00.000Z',
          alpacaAccountLabel: 'paper',
          symbol: 'ABC',
          timeframe: '1m',
          status: 'rejected',
          rationale: null,
          riskReasons: ['qty_below_min'],
          strategyId: '1',
          strategyName: 'test',
        },
        {
          id: '3',
          createdAt: '2026-01-10T14:40:00.000Z',
          alpacaAccountLabel: 'paper',
          symbol: 'ABC',
          timeframe: '1m',
          status: 'rejected',
          rationale: null,
          riskReasons: ['llm_error'],
          strategyId: '1',
          strategyName: 'test',
        },
      ],
      rollingTrendInterval,
    )

    expect(trend.byDay).toHaveLength(2)
    expect(trend.byDay[0]).toEqual({
      day: '2026-01-11',
      rejectedCount: 1,
      preOpenCount: 1,
      postOpenCount: 0,
      topReasons: [
        { reason: 'shorts_not_allowed', count: 1 },
        { reason: 'llm_error', count: 1 },
      ],
    })
    expect(trend.byDay[1]).toEqual({
      day: '2026-01-12',
      rejectedCount: 1,
      preOpenCount: 0,
      postOpenCount: 1,
      topReasons: [{ reason: 'qty_below_min', count: 1 }],
    })
  })
})
