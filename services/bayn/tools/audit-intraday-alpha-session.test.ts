import { expect, test } from 'bun:test'

import { OrderSide, OrderStatus, OrderType } from '../src/execution/contracts'
import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import { summarizeAlphaSession } from './audit-intraday-alpha-session'
import type { AlphaSessionRows } from './intraday-alpha-session-postgres'

const date = '2026-11-27'
const close = new Date(`${date}T18:00:00.000Z`)
const secondsAfterClose = new Date(`${date}T18:00:10.000Z`)
const reconciled = new Date(`${date}T18:00:15.000Z`)
const buy = OrderSide.Buy
const sell = OrderSide.Sell
const morning = IntradayAlphaPhase.MorningOrb
const midday = IntradayAlphaPhase.MiddayReversion

const fixture = (overrides: Partial<AlphaSessionRows> = {}): AlphaSessionRows => ({
  cut: { queriedAt: new Date(`${date}T18:01:00.000Z`) },
  entries: [],
  unverifiedDecisions: 0,
  unaccountedFillEvents: 0,
  nonterminalIntents: 0,
  fills: [],
  orders: [],
  inventory: [],
  cancellations: [],
  fees: [],
  reconciliation: {
    status: 'EXACT',
    reconciledAt: reconciled,
    positionCount: 0,
    discrepancies: 0,
    positionsObservedAt: secondsAfterClose,
    coversSessionEvidence: true,
  },
  ...overrides,
})

const leg = (symbol: string, side: OrderSide, quantityAtoms = '10000000000') => ({
  intentId: `entry-${symbol}`,
  symbol,
  side,
  quantityAtoms,
  referencePriceMicros: '100000000',
  signalBarCloseMicros: '99000000',
})

const order = (
  cycleId: string,
  { symbol, side, intentId }: ReturnType<typeof leg>,
  overrides: Partial<AlphaSessionRows['orders'][number]> = {},
): AlphaSessionRows['orders'][number] => ({
  orderId: `order-${symbol}`,
  parentOrderId: null,
  intentId,
  cycleId,
  symbol,
  side,
  orderType: OrderType.Limit,
  status: OrderStatus.Filled,
  protectionTag: 'Bracket',
  ...overrides,
})

const fill = (
  { symbol, side, intentId }: ReturnType<typeof leg>,
  n: number,
  overrides: Partial<AlphaSessionRows['fills'][number]> = {},
): AlphaSessionRows['fills'][number] => ({
  fillId: `fill-${n}`,
  sourceAt: `${date}T17:00:${String(n).padStart(2, '0')}.123456789Z`,
  orderId: `order-${symbol}`,
  intentId,
  symbol,
  side,
  quantityAtoms: '10000000000',
  priceAtoms: '101000000000',
  grossMicros: '0',
  feeMicros: '10000',
  accountingBound: true,
  ...overrides,
})

test('matches short entries and same-intent protective children without counting the exit as entry slippage', () => {
  const planned = leg('AAPL', sell)
  const report = summarizeAlphaSession(
    date,
    close,
    fixture({
      entries: [{ cycleId: 'orb', phase: morning, legs: [planned] }],
      fills: [
        fill(planned, 2, {
          side: buy,
          orderId: 'stop-AAPL',
          priceAtoms: '99500000000',
          feeMicros: '20000',
          grossMicros: '15000000',
        }),
        fill(planned, 1),
      ],
      orders: [
        order('orb', planned),
        order('orb', planned, {
          side: buy,
          orderId: 'stop-AAPL',
          parentOrderId: 'order-AAPL',
          orderType: OrderType.StopLimit,
        }),
      ],
      cancellations: [
        { cycleId: 'orb', acknowledged: true, released: true },
        { cycleId: 'orb', acknowledged: false, released: false },
      ],
      fees: [
        { posted: true, netAmountMicros: '-70000' },
        { posted: false, netAmountMicros: '-30000' },
      ],
    }),
  )
  expect(report.status).toBe('RECONCILED_ATTRIBUTION')
  expect(report.engines[0]).toMatchObject({
    phase: morning,
    fills: 2,
    accountedFills: 2,
    realizedGrossMicros: '15000000',
    knownDirectFillFeesMicros: '30000',
    realizedNetAfterDirectFillFeesMicros: '14970000',
    protection: {
      latestOrdersByRoleAndStatus: { 'Bracket:FILLED': 1, 'CHILD_STOP_LIMIT:FILLED': 1 },
      verifiedCancelCommands: 2,
      brokerCancelReceipts: 1,
      releaseProofs: 1,
    },
  })
  expect(report.baskets[0]?.legs[0]).toMatchObject({
    filledQuantityAtoms: '10000000000',
    fillVwapMicros: '101000000',
    filledNotionalMicros: '1010000000',
    versusIntendedReference: { adverseMicros: '-10000000', adverseBps: -100 },
    versusSignalBarClose: { adverseMicros: '-20000000' },
  })
  expect(report.account).toMatchObject({
    unallocatedPostedEquityFeeDebitMicros: '70000',
    pendingEquityFeeActivities: 1,
    knownNetAfterDirectAndPostedEquityFeesMicros: '14900000',
    allBrokerCostsFinal: false,
  })
  expect(report.reconciliation.flatExact).toBe(true)
})

test('distinguishes four touched legs from four fully filled legs and weights partial entry fills', () => {
  const legs = [leg('AAPL', buy), leg('AMZN', buy), leg('AMD', sell), leg('AVGO', sell)]
  const report = summarizeAlphaSession(
    date,
    close,
    fixture({
      entries: [{ cycleId: 'midday', phase: midday, legs }],
      fills: legs.flatMap((planned, index) => [
        fill(planned, 2 * index, { quantityAtoms: '4000000000', priceAtoms: '100500000000' }),
        fill(planned, 2 * index + 1, { quantityAtoms: '5000000000', priceAtoms: '101400000000' }),
      ]),
      orders: legs.map((planned) => order('midday', planned, { status: OrderStatus.Canceled })),
      inventory: legs.map(({ symbol, side }) => ({
        symbol,
        openingAtoms: '0',
        openingBasisMicros: '0',
        closingAtoms: side === buy ? '9000000000' : '-9000000000',
        closingBasisMicros: side === buy ? '909000000' : '-909000000',
      })),
    }),
  )
  expect(report.midday).toEqual({
    baskets: 1,
    intendedFourLegBaskets: 1,
    anyFillOnAllFour: 1,
    fullyFilledFourLegBaskets: 0,
  })
  expect(report.baskets[0]).toMatchObject({ filledLegs: 4, fullyFilledLegs: 0, signedFilledEntryNotionalMicros: '0' })
  expect(report.baskets[0]?.legs[0]).toMatchObject({
    fillVwapMicros: '101000000',
    filledQuantityAtoms: '9000000000',
    versusIntendedReference: { adverseMicros: '9000000', adverseBps: 100 },
  })
  expect(report.status).toBe('PARTIAL')
  expect(report.inventory.closingLedgerFlat).toBe(false)
})

test('requires account-bound accounting and withholds reconciliation when close evidence or orders are incomplete', () => {
  const planned = leg('AAPL', buy)
  const report = summarizeAlphaSession(
    date,
    close,
    fixture({
      entries: [{ cycleId: 'orb', phase: morning, legs: [planned] }],
      unaccountedFillEvents: 1,
      fills: [fill(planned, 0, { accountingBound: false, grossMicros: '20000000' })],
      orders: [order('orb', planned, { status: OrderStatus.PartiallyFilled })],
      reconciliation: {
        status: 'EXACT',
        reconciledAt: reconciled,
        positionCount: 0,
        discrepancies: 0,
        positionsObservedAt: new Date(`${date}T17:59:59.999Z`),
        coversSessionEvidence: false,
      },
    }),
  )
  expect(report.status).toBe('PARTIAL')
  expect(report.engines[0]).toMatchObject({
    fills: 1,
    accountedFills: 0,
    knownGrossMicros: '0',
    realizedGrossMicros: null,
  })
  expect(report.inventory.workingOrders).toBe(1)
  expect(report.reconciliation).toMatchObject({ reconciledAfterClose: false, flatExact: false })
})

test('preserves account totals but refuses strategy ownership for mixed or carried-in inventory', () => {
  const planned = leg('AAPL', buy)
  const booked = leg('AMD', sell)
  const report = summarizeAlphaSession(
    date,
    close,
    fixture({
      entries: [{ cycleId: 'orb', phase: morning, legs: [planned, booked] }],
      fills: [
        fill(planned, 1),
        fill(planned, 2, { intentId: null, orderId: 'external-buy' }),
        fill(planned, 3, {
          side: sell,
          intentId: null,
          orderId: 'external-sell',
          quantityAtoms: '20000000000',
          grossMicros: '20000000',
        }),
        fill(booked, 4, { grossMicros: '3000000' }),
      ],
      orders: [order('orb', planned), order('orb', booked)],
      inventory: [
        {
          symbol: 'AMD',
          openingAtoms: '10000000000',
          openingBasisMicros: '800000000',
          closingAtoms: '0',
          closingBasisMicros: '0',
        },
      ],
    }),
  )
  expect(report.status).toBe('PARTIAL')
  expect(report.account.unattributed).toMatchObject({ fills: 4, knownGrossMicros: '23000000' })
  expect(report.engines[0]?.knownGrossMicros).toBe('0')
  expect(report.inventory.openingLedgerFlat).toBe(false)
})

test('reports pre-close, missing v2 execution and unverified evidence as different states', () => {
  expect(
    summarizeAlphaSession(date, close, fixture({ cut: { queriedAt: new Date(`${date}T17:59:00Z`) } })).status,
  ).toBe('PRE_CLOSE')
  expect(summarizeAlphaSession(date, close, fixture({ reconciliation: null })).status).toBe('NO_VERIFIED_V2_EXECUTION')
  expect(summarizeAlphaSession(date, close, fixture({ unverifiedDecisions: 1 })).status).toBe('PARTIAL')
})

test('an unsettled intent cannot be treated as flat and exact merely because it has no broker order', () => {
  const planned = leg('AAPL', buy)
  const report = summarizeAlphaSession(
    date,
    close,
    fixture({
      entries: [{ cycleId: 'orb', phase: morning, legs: [planned] }],
      nonterminalIntents: 1,
    }),
  )
  expect(report.status).toBe('PARTIAL')
  expect(report.inventory).toMatchObject({ workingOrders: 0, currentNonterminalIntentsBeforeSessionEnd: 1 })
  expect(report.reconciliation.flatExact).toBe(false)
})
