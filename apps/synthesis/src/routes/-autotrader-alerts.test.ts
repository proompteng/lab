import { describe, expect, test } from 'vitest'

import type { AutotraderSessionDetail } from '~/server/autotrader-schema'

import { getAutotraderRuntimeAlerts } from './-autotrader-alerts'

const now = new Date('2026-05-29T14:00:00Z')

const detailFor = (overrides: Partial<AutotraderSessionDetail> = {}): AutotraderSessionDetail => ({
  session: {
    id: 'session-1',
    agentRunName: 'autonomous-trader-market-open-test',
    mode: 'market_open',
    tradingDate: '2026-05-29',
    accountId: 'paper',
    goalEquity: '500000',
    openingEquity: '38457.11',
    closingEquity: null,
    realizedPnl: null,
    maxDrawdown: null,
    marketOpenAt: '2026-05-29T13:30:00Z',
    marketCloseAt: '2026-05-29T20:00:00Z',
    analysisHead: 'abc123',
    analysisContextHash: 'sha256:test',
    startedAt: '2026-05-29T13:15:00Z',
    finalizedAt: null,
    terminalReason: null,
    summary: {},
  },
  status: {
    sessionId: 'session-1',
    cycle: 1,
    phase: 'scan',
    equity: '38457.11',
    buyingPower: '1000',
    daytradeBuyingPower: '0',
    grossExposure: '0',
    netExposure: '0',
    realizedPnl: '0',
    unrealizedPnl: '0',
    currentAction: 'scanning',
    blocker: null,
    payload: {},
    updatedAt: '2026-05-29T13:59:30Z',
  },
  events: [],
  tradeTickets: [],
  riskChecks: [],
  orders: [],
  fills: [],
  positionSnapshots: [],
  scorecards: [],
  setupExamples: [],
  ...overrides,
})

describe('getAutotraderRuntimeAlerts', () => {
  test('flags stale status heartbeat during market hours', () => {
    const detail = detailFor({
      status: {
        ...detailFor().status!,
        updatedAt: '2026-05-29T13:58:00Z',
      },
    })

    expect(getAutotraderRuntimeAlerts(detail, now)).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'stale-heartbeat', severity: 'critical' })]),
    )
  })

  test('does not flag stale heartbeat before regular market hours', () => {
    const detail = detailFor({
      status: {
        ...detailFor().status!,
        updatedAt: '2026-05-29T13:00:00Z',
      },
    })

    expect(getAutotraderRuntimeAlerts(detail, new Date('2026-05-29T13:10:00Z'))).toEqual([])
  })

  test('flags guard-finalized market sessions after the AgentRun ended early', () => {
    const base = detailFor()
    const detail = detailFor({
      session: {
        ...base.session,
        finalizedAt: '2026-06-01T20:00:54.011Z',
        terminalReason: 'market_closed',
        summary: {
          guard: 'autotrader-session-guard',
          reason: 'market close reached after original AgentRun job completed early',
        },
      },
    })

    expect(getAutotraderRuntimeAlerts(detail, new Date('2026-06-01T21:00:00Z'))).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'market-session-ended-early', severity: 'critical' })]),
    )
  })

  test('does not bury guard-finalized sessions under stale zero-exposure risk alerts', () => {
    const base = detailFor()
    const detail = detailFor({
      session: {
        ...base.session,
        finalizedAt: '2026-06-01T20:00:54.011Z',
        terminalReason: 'market_closed',
        summary: {
          guard: 'autotrader-session-guard',
          reason: 'market close reached after original AgentRun job completed early',
          finalOpenOrders: 0,
          finalPositions: 0,
        },
      },
      orders: [
        {
          sessionId: 'session-1',
          ticketId: null,
          clientOrderId: 'atr-20260601-stale-SPY-01',
          brokerOrderId: null,
          symbol: 'SPY',
          instrument: 'etf',
          side: 'buy',
          quantity: '1',
          orderType: 'limit',
          orderClass: null,
          limitPrice: '500',
          stopPrice: null,
          takeProfitLimitPrice: null,
          stopLossStopPrice: null,
          stopLossLimitPrice: null,
          status: 'submitted',
          rejectReason: null,
          brokerPayload: {},
          updatedAt: '2026-06-01T15:59:20Z',
        },
      ],
      positionSnapshots: [
        {
          id: 'pos-1',
          sessionId: 'session-1',
          symbol: 'SPY',
          quantity: '1',
          marketValue: '500',
          averageEntryPrice: '500',
          unrealizedPnl: '0',
          capturedAt: '2026-06-01T15:59:30Z',
          brokerPayload: {},
        },
      ],
    })

    expect(getAutotraderRuntimeAlerts(detail, new Date('2026-06-01T21:00:00Z')).map((alert) => alert.key)).toEqual([
      'market-session-ended-early',
    ])
  })

  test('flags market sessions finalized before regular close', () => {
    const base = detailFor()
    const detail = detailFor({
      session: {
        ...base.session,
        finalizedAt: '2026-05-29T16:09:44.000Z',
        terminalReason: 'market_closed',
      },
    })

    expect(getAutotraderRuntimeAlerts(detail, new Date('2026-05-29T21:00:00Z'))).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'market-session-ended-early', severity: 'critical' })]),
    )
  })

  test('does not flag target-reached sessions that finish before regular close', () => {
    const base = detailFor()
    const detail = detailFor({
      session: {
        ...base.session,
        finalizedAt: '2026-05-29T16:09:44.000Z',
        terminalReason: 'target_reached',
      },
    })

    expect(getAutotraderRuntimeAlerts(detail, new Date('2026-05-29T21:00:00Z'))).toEqual([])
  })

  test('treats replaced orders as terminal for reconciliation alerts', () => {
    const detail = detailFor({
      orders: [
        {
          sessionId: 'session-1',
          ticketId: null,
          clientOrderId: 'atr-20260529-test-1-NVDA-01',
          brokerOrderId: null,
          symbol: 'NVDA',
          instrument: 'stock',
          side: 'buy',
          quantity: '1',
          orderType: 'limit',
          orderClass: null,
          limitPrice: '100',
          stopPrice: null,
          takeProfitLimitPrice: null,
          stopLossStopPrice: null,
          stopLossLimitPrice: null,
          status: 'replaced',
          rejectReason: null,
          brokerPayload: {},
          updatedAt: '2026-05-29T13:59:20Z',
        },
      ],
    })

    expect(getAutotraderRuntimeAlerts(detail, now).map((alert) => alert.key)).not.toContain(
      'unreconciled-order:atr-20260529-test-1-NVDA-01',
    )
  })

  test('flags nonterminal orders older than 30 seconds', () => {
    const detail = detailFor({
      orders: [
        {
          sessionId: 'session-1',
          ticketId: null,
          clientOrderId: 'atr-20260529-test-1-NVDA-01',
          brokerOrderId: null,
          symbol: 'NVDA',
          instrument: 'stock',
          side: 'buy',
          quantity: '1',
          orderType: 'limit',
          orderClass: null,
          limitPrice: '100',
          stopPrice: null,
          takeProfitLimitPrice: null,
          stopLossStopPrice: null,
          stopLossLimitPrice: null,
          status: 'submitted',
          rejectReason: null,
          brokerPayload: {},
          updatedAt: '2026-05-29T13:59:20Z',
        },
      ],
    })

    expect(getAutotraderRuntimeAlerts(detail, now)).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'unreconciled-order:atr-20260529-test-1-NVDA-01' })]),
    )
  })

  test('does not flag broker-attached protective OCO orders as unreconciled', () => {
    const detail = detailFor({
      orders: [
        {
          sessionId: 'session-1',
          ticketId: null,
          clientOrderId: 'atr-20260529-test-1-AVGO-oco-repair-01',
          brokerOrderId: 'alpaca-oco-1',
          symbol: 'AVGO',
          instrument: 'stock',
          side: 'sell',
          quantity: '5',
          orderType: 'limit',
          orderClass: 'oco',
          limitPrice: '488.40',
          stopPrice: null,
          takeProfitLimitPrice: null,
          stopLossStopPrice: '481.40',
          stopLossLimitPrice: '481.10',
          status: 'accepted',
          rejectReason: null,
          brokerPayload: {},
          updatedAt: '2026-05-29T13:59:20Z',
        },
      ],
      positionSnapshots: [
        {
          id: 'pos-avgo',
          sessionId: 'session-1',
          symbol: 'AVGO',
          quantity: '5',
          marketValue: '2417.25',
          averageEntryPrice: '483.194',
          unrealizedPnl: '1.28',
          capturedAt: '2026-05-29T13:59:30Z',
          brokerPayload: {},
        },
      ],
    })

    expect(getAutotraderRuntimeAlerts(detail, now).map((alert) => alert.key)).not.toContain(
      'unreconciled-order:atr-20260529-test-1-AVGO-oco-repair-01',
    )
  })

  test('flags positions with no confirmed protection or managed-loop fallback', () => {
    const detail = detailFor({
      positionSnapshots: [
        {
          id: 'pos-1',
          sessionId: 'session-1',
          symbol: 'SPY',
          quantity: '1',
          marketValue: '500',
          averageEntryPrice: '500',
          unrealizedPnl: '0',
          capturedAt: '2026-05-29T13:59:30Z',
          brokerPayload: {},
        },
      ],
    })

    expect(getAutotraderRuntimeAlerts(detail, now)).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'unprotected-position:SPY' })]),
    )
  })

  test('accepts broker-attached protection and active managed-loop fallbacks', () => {
    const withBracket = detailFor({
      orders: [
        {
          sessionId: 'session-1',
          ticketId: null,
          clientOrderId: 'atr-20260529-test-1-SPY-01',
          brokerOrderId: 'alpaca-1',
          symbol: 'SPY',
          instrument: 'etf',
          side: 'buy',
          quantity: '1',
          orderType: 'limit',
          orderClass: 'bracket',
          limitPrice: '500',
          stopPrice: null,
          takeProfitLimitPrice: '505',
          stopLossStopPrice: '498',
          stopLossLimitPrice: '497.95',
          status: 'accepted',
          rejectReason: null,
          brokerPayload: {},
          updatedAt: '2026-05-29T13:59:50Z',
        },
      ],
      positionSnapshots: [
        {
          id: 'pos-1',
          sessionId: 'session-1',
          symbol: 'SPY',
          quantity: '1',
          marketValue: '500',
          averageEntryPrice: '500',
          unrealizedPnl: '0',
          capturedAt: '2026-05-29T13:59:30Z',
          brokerPayload: {},
        },
      ],
    })
    const withManagedLoop = detailFor({
      status: {
        ...detailFor().status!,
        payload: { protection: { symbol: 'TSLA', managedLoopActive: true } },
      },
      positionSnapshots: [
        {
          id: 'pos-2',
          sessionId: 'session-1',
          symbol: 'TSLA',
          quantity: '-1',
          marketValue: '180',
          averageEntryPrice: '180',
          unrealizedPnl: '0',
          capturedAt: '2026-05-29T13:59:30Z',
          brokerPayload: {},
        },
      ],
    })

    expect(getAutotraderRuntimeAlerts(withBracket, now).map((alert) => alert.key)).not.toContain(
      'unprotected-position:SPY',
    )
    expect(getAutotraderRuntimeAlerts(withManagedLoop, now).map((alert) => alert.key)).not.toContain(
      'unprotected-position:TSLA',
    )
  })
})
