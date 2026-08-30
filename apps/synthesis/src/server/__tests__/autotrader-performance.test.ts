import { describe, expect, test } from 'vitest'

import { buildAutotraderSessionPerformance } from '../autotrader-performance'
import type { AutotraderSession } from '../autotrader-schema'

const session = (overrides: Partial<AutotraderSession> = {}): AutotraderSession => ({
  id: 'session-1',
  agentRunName: 'autonomous-trader-market-open-test',
  mode: 'market_open',
  tradingDate: '2026-06-03',
  accountId: 'paper-account',
  goalEquity: '500000',
  openingEquity: '30000',
  closingEquity: '30150',
  realizedPnl: '150',
  maxDrawdown: '45',
  marketOpenAt: '2026-06-03T13:30:00.000Z',
  marketCloseAt: '2026-06-03T20:00:00.000Z',
  analysisHead: null,
  analysisContextHash: null,
  startedAt: '2026-06-03T13:15:00.000Z',
  finalizedAt: '2026-06-03T20:05:00.000Z',
  terminalReason: 'market_closed',
  summary: {},
  ...overrides,
})

describe('buildAutotraderSessionPerformance', () => {
  test('uses distinct filled orders instead of raw fills for bounded execution rates', () => {
    const performance = buildAutotraderSessionPerformance(session(), {
      tradeTicketCount: 10,
      orderCount: 4,
      fillCount: 8,
      filledOrderCount: 2,
      realizedRObservationCount: 2,
      totalRealizedR: '-0.5',
    })

    expect(performance).toMatchObject({
      verdict: 'profitable',
      realizedPnl: '150',
      totalRealizedR: '-0.5',
      avgRealizedR: '-0.25',
      realizedRObservationCount: 2,
      filledOrderCount: 2,
      orderFillRate: '50',
      ticketOrderRate: '40',
      ticketFillRate: '20',
    })
  })

  test('caps impossible filled-order ratios caused by orphaned fill records', () => {
    const performance = buildAutotraderSessionPerformance(session(), {
      tradeTicketCount: 3,
      orderCount: 4,
      fillCount: 8,
      filledOrderCount: 6,
      realizedRObservationCount: 0,
      totalRealizedR: null,
    })

    expect(performance.orderFillRate).toBe('100')
    expect(performance.ticketFillRate).toBe('100')
    expect(performance.totalRealizedR).toBeNull()
    expect(performance.avgRealizedR).toBeNull()
  })
})
