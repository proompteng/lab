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
  calendarCloses: [],
  closeReferences: [],
  stopPositionMarks: [],
  postClosePositions: [],
  controllerTicks: { observedTicks: 0, closeMarketDataUnavailableTicks: 0 },
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
  { symbol, side, intentId }: Pick<ReturnType<typeof leg>, 'symbol' | 'side' | 'intentId'>,
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
  quantityAtoms: '10000000000',
  filledQuantityAtoms: '10000000000',
  limitPriceMicros: null,
  stopPriceMicros: null,
  updatedAt: `${date}T17:00:03.000000000Z`,
  ...overrides,
})

const fill = (
  { symbol, side, intentId }: Pick<ReturnType<typeof leg>, 'symbol' | 'side' | 'intentId'>,
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
        atRegularCloseAtoms: side === buy ? '9000000000' : '-9000000000',
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
          atRegularCloseAtoms: '0',
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

const googl = {
  ...leg('GOOGL', sell, '103000000000'),
  referencePriceMicros: '271080000',
  signalBarCloseMicros: '271080000',
}
const earlyCloseBinding = {
  cycleId: 'orb',
  executionCloseAt: `${date}T22:00:00.000Z`,
  regularCloseAt: close.toISOString(),
}
const googlEntryFills = [
  fill(googl, 1, {
    sourceAt: `${date}T15:02:09.000000000Z`,
    quantityAtoms: '51000000000',
    priceAtoms: '271000000000',
  }),
  fill(googl, 2, {
    sourceAt: `${date}T15:02:09.000000001Z`,
    quantityAtoms: '52000000000',
    priceAtoms: '271050509615',
  }),
]
const googlEntry = order('orb', googl, {
  quantityAtoms: googl.quantityAtoms,
  filledQuantityAtoms: googl.quantityAtoms,
  limitPriceMicros: '270810000',
})
const googlStop = order('orb', googl, {
  orderId: 'stop-GOOGL',
  parentOrderId: googlEntry.orderId,
  side: buy,
  orderType: OrderType.StopLimit,
  status: OrderStatus.Expired,
  quantityAtoms: googl.quantityAtoms,
  filledQuantityAtoms: '0',
  stopPriceMicros: '275310000',
  limitPriceMicros: '275580000',
  updatedAt: `${date}T18:00:00.000000000Z`,
})
const positionMark = {
  symbol: 'GOOGL',
  observedAt: `${date}T17:59:00.000000000Z`,
  quantityAtoms: '-103000000000',
  markPriceMicros: '275880000',
  unrealizedPnlMicros: '-500010000',
}

test('replays the reported Black Friday short, expired stop, post-close inventory and retained tick count', () => {
  const later = new Date(`${date}T21:00:00.000Z`)
  const report = summarizeAlphaSession(
    date,
    later,
    fixture({
      entries: [{ cycleId: 'orb', phase: morning, legs: [googl] }],
      fills: googlEntryFills.toReversed(),
      orders: [googlEntry, googlStop],
      calendarCloses: [earlyCloseBinding],
      stopPositionMarks: [positionMark],
      postClosePositions: [{ ...positionMark, observedAt: `${date}T18:00:10.000000000Z` }],
      controllerTicks: { observedTicks: 5550, closeMarketDataUnavailableTicks: 5548 },
      inventory: [
        {
          symbol: 'GOOGL',
          openingAtoms: '0',
          openingBasisMicros: '0',
          closingAtoms: googl.quantityAtoms.replace(/^/, '-'),
          closingBasisMicros: '-27915626500',
          atRegularCloseAtoms: '-103000000000',
        },
      ],
    }),
  )
  // The original v1 fields still use the operator's CLI close; the new diagnostics disclose the disagreement.
  expect(report.regularCloseAt).toBe(later.toISOString())
  expect(report.status).toBe('PRE_CLOSE')
  const evidence = report.forensics
  const [short] = evidence.entryOrders
  expect(short).toMatchObject({
    filledQuantityAtoms: googl.quantityAtoms,
    limitPriceMicros: '270810000',
    exactVwapAtoms: {
      numerator: (51_000_000_000n * 271_000_000_000n + 52_000_000_000n * 271_050_509_615n).toString(),
      denominator: googl.quantityAtoms,
    },
  })
  expect(Number(short?.fillVwapAtoms) / 1e9).toBeCloseTo(271.0255, 7)
  expect(short?.versusSignalBarClose?.adverseBps).toBeCloseTo(2.01, 2)
  expect(short?.limitImprovementBps).toBeCloseTo(7.96, 2)
  expect(evidence.exitOrders).toEqual([])
  expect(evidence.stopLimits).toMatchObject([
    {
      status: 'STOP_BREACHED_UNFILLED',
      beyondLimit: true,
      terminalStatus: OrderStatus.Expired,
      stopPriceMicros: '275310000',
      limitPriceMicros: '275580000',
      worstMark: positionMark,
    },
  ])
  expect(evidence.sessionBoundary).toMatchObject({
    source: 'VERIFIED_DECISION_CALENDAR',
    regularCloseAt: close.toISOString(),
    isEarlyClose: true,
    cliRegularCloseAgrees: false,
    closeMarketDataUnavailableTicks: 5548,
    calendarComparisons: [{ ...earlyCloseBinding, executionCloseAfterRegularMs: 14_400_000 }],
    atCloseInventory: [{ symbol: 'GOOGL', quantityAtoms: '-103000000000' }],
    postCloseNonzeroPositions: [{ symbol: 'GOOGL', alsoOpenInLedgerAtRegularClose: true }],
  })
  expect(evidence.breakeven.roundTripProxyBps).toBeCloseTo(4.02, 2)
})

test('classifies partially filled and missed planned legs, separating multiple broker orders', () => {
  const partial = leg('AAPL', buy)
  const missed = leg('AMD', sell)
  const neverSubmitted = leg('AVGO', sell)
  const report = summarizeAlphaSession(
    date,
    close,
    fixture({
      entries: [{ cycleId: 'orb', phase: morning, legs: [partial, missed, neverSubmitted] }],
      orders: [
        order('orb', partial, {
          status: OrderStatus.Canceled,
          filledQuantityAtoms: '3000000000',
          limitPriceMicros: '101000000',
        }),
        order('orb', partial, {
          orderId: 'retry',
          status: OrderStatus.Canceled,
          filledQuantityAtoms: '2000000000',
          limitPriceMicros: '102000000',
        }),
        order('orb', missed, { status: OrderStatus.Rejected, filledQuantityAtoms: '0' }),
      ],
      fills: [
        fill(partial, 1, { priceAtoms: '100000000000', quantityAtoms: '3000000000' }),
        fill(partial, 2, { orderId: 'retry', priceAtoms: '101000000000', quantityAtoms: '2000000000' }),
      ],
    }),
  ).forensics
  expect(report).toMatchObject({ partialEntryLegs: 1, missedEntryLegs: 2 })
  expect(report.entryOrders).toMatchObject([
    { orderId: 'order-AAPL', filledQuantityAtoms: '3000000000', fillVwapAtoms: '100000000000' },
    { orderId: 'retry', filledQuantityAtoms: '2000000000', fillVwapAtoms: '101000000000' },
    { orderId: 'order-AMD', filledQuantityAtoms: '0', fillVwapAtoms: null, versusIntendedReference: null },
  ])
  expect(report.entryOrders[0]?.limitImprovementBps).toBeCloseTo(99.0099, 4)
  expect(report.entryOrders[0]?.versusIntendedReference?.adverseBps).toBe(0)
  expect(report.entryOrders[0]?.versusSignalBarClose?.adverseBps).toBeCloseTo(101.0101, 4)
})

test('matches each partial exit to an owned episode and uses a verified close reference or native trigger', () => {
  const planned = { ...leg('AAPL', buy), signalBarCloseMicros: '100000000' }
  const report = summarizeAlphaSession(
    date,
    close,
    fixture({
      entries: [{ cycleId: 'orb', phase: morning, legs: [planned] }],
      orders: [
        order('orb', planned),
        order('orb', planned, {
          orderId: 'stop',
          parentOrderId: 'order-AAPL',
          side: sell,
          orderType: OrderType.StopLimit,
          stopPriceMicros: '98000000',
          limitPriceMicros: '97000000',
          filledQuantityAtoms: '4000000000',
        }),
        order('orb', planned, {
          orderId: 'close',
          intentId: 'close-intent',
          side: sell,
          orderType: OrderType.Market,
          filledQuantityAtoms: '6000000000',
        }),
      ],
      fills: [
        fill(planned, 1),
        fill(planned, 2, { orderId: 'stop', side: sell, quantityAtoms: '4000000000', priceAtoms: '97500000000' }),
        fill(planned, 3, {
          orderId: 'close',
          intentId: 'close-intent',
          side: sell,
          quantityAtoms: '6000000000',
          priceAtoms: '96000000000',
        }),
      ],
      closeReferences: [
        { cycleId: 'orb', intentId: 'close-intent', symbol: 'AAPL', side: sell, referencePriceMicros: '96500000' },
        { cycleId: 'another', intentId: 'close-intent', symbol: 'AAPL', side: sell, referencePriceMicros: '96000000' },
      ],
    }),
  ).forensics
  expect(report.entryOrders).toHaveLength(1)
  expect(report.exitOrders).toMatchObject([
    {
      orderId: 'stop',
      fillVwapAtoms: '97500000000',
      versusEntrySignalBarClose: { adverseBps: 250 },
      versusCloseReference: null,
      protectiveTriggerPriceMicros: '98000000',
      versusProtectiveTrigger: { adverseMicros: '2000000' },
    },
    {
      orderId: 'close',
      fillVwapAtoms: '96000000000',
      closeReferencePriceMicros: '96500000',
      versusEntrySignalBarClose: { adverseBps: 400 },
      versusCloseReference: { adverseMicros: '3000000' },
      protectiveTriggerPriceMicros: null,
    },
  ])
})

test('uses only same-side-held pre-terminal marks and excludes partial stop fills', () => {
  const long = leg('AMD', buy)
  const stop = order('orb', long, {
    orderId: 'stop-AMD',
    parentOrderId: 'order-AMD',
    side: sell,
    orderType: OrderType.StopLimit,
    status: OrderStatus.Canceled,
    filledQuantityAtoms: '0',
    stopPriceMicros: '99000000',
    limitPriceMicros: '98000000',
    updatedAt: `${date}T18:00:00.000000000Z`,
  })
  const mark = { ...positionMark, symbol: 'AMD', quantityAtoms: '10000000000', markPriceMicros: '98500000' }
  const rows = fixture({
    entries: [{ cycleId: 'orb', phase: morning, legs: [long] }],
    orders: [order('orb', long), stop],
    fills: [fill(long, 1)],
  })
  const summarize = (overrides: Partial<AlphaSessionRows>) =>
    summarizeAlphaSession(date, close, { ...rows, ...overrides }).forensics.stopLimits
  const invalidMarks = [
    { ...mark, observedAt: `${date}T18:00:00.000000001Z`, markPriceMicros: '97000000' },
    { ...mark, observedAt: `${date}T17:00:01.123456788Z`, markPriceMicros: '97000000' },
    { ...mark, quantityAtoms: '-10000000000', markPriceMicros: '97000000' },
  ]
  expect(summarize({ stopPositionMarks: [...invalidMarks, mark] })).toMatchObject([
    { status: 'STOP_BREACHED_UNFILLED', beyondLimit: false, worstMark: mark },
  ])
  expect(summarize({ stopPositionMarks: invalidMarks })).toMatchObject([{ status: 'NO_MARK_EVIDENCE' }])
  expect(summarize({ stopPositionMarks: [{ ...mark, markPriceMicros: '99500000' }] })).toMatchObject([
    { status: 'NO_BREACH_OBSERVED' },
  ])
  expect(
    summarize({
      stopPositionMarks: [mark],
      orders: [order('orb', long), { ...stop, filledQuantityAtoms: '1000000000' }],
    }),
  ).toEqual([])
  expect(
    summarize({
      stopPositionMarks: [mark],
      fills: [fill(long, 1), fill(long, 2, { orderId: stop.orderId, side: sell, quantityAtoms: '1000000000' })],
    }),
  ).toEqual([])
  expect(
    summarize({
      stopPositionMarks: [mark],
      fills: [fill(long, 1), fill(long, 2, { orderId: 'manual-flat', side: sell })],
    }),
  ).toMatchObject([{ status: 'NO_MARK_EVIDENCE' }])
})

test('retains positions observed after a normal close even when later flat; does not invent tick evidence', () => {
  const normal = '2026-11-25'
  const regular = new Date(`${normal}T21:00:00.000Z`)
  const report = summarizeAlphaSession(
    normal,
    regular,
    fixture({
      cut: { queriedAt: new Date(`${normal}T22:00:00.000Z`) },
      postClosePositions: [
        { ...positionMark, observedAt: `${normal}T21:00:00.000000001Z` },
        { ...positionMark, symbol: 'AAPL', observedAt: `${normal}T21:00:00.000000000Z` },
        { ...positionMark, symbol: 'AMD', observedAt: `${normal}T21:00:01.000000000Z`, quantityAtoms: '0' },
      ],
      inventory: [
        {
          symbol: 'GOOGL',
          openingAtoms: '0',
          openingBasisMicros: '0',
          closingAtoms: '0',
          closingBasisMicros: '0',
          atRegularCloseAtoms: positionMark.quantityAtoms,
        },
      ],
    }),
  )
  expect(report.inventory.nonzero).toEqual([])
  expect(report.forensics.sessionBoundary).toMatchObject({
    isEarlyClose: false,
    source: 'CLI',
    closeMarketDataUnavailableTicks: null,
    postCloseNonzeroPositions: [{ symbol: 'GOOGL', alsoOpenInLedgerAtRegularClose: true }],
  })
  expect(
    summarizeAlphaSession(
      normal,
      regular,
      fixture({
        cut: { queriedAt: new Date(`${normal}T20:59:00.000Z`) },
        controllerTicks: { observedTicks: 123, closeMarketDataUnavailableTicks: 0 },
      }),
    ).forensics.sessionBoundary,
  ).toMatchObject({
    afterClose: false,
    postCloseNonzeroPositions: [],
    atCloseInventory: [],
    closeMarketDataUnavailableTicks: 0,
  })
})

test.each([
  ['100010000000', 2, 'PASS', 'PASS', 'PASS'],
  ['100030000000', 6, 'WARN', 'WARN', 'PASS'],
  ['100050000000', 10, 'WARN', 'FAIL', 'PASS'],
  ['100109600000', 21.92, 'WARN', 'FAIL', 'WARN'],
  ['100120000000', 24, 'FAIL', 'FAIL', 'FAIL'],
] as const)(
  'compares doubled entry cost at %s atoms to both empirical thresholds',
  (priceAtoms, roundTripProxyBps, verdict, v2, v3) => {
    const planned = { ...leg('AAPL', buy), signalBarCloseMicros: '100000000' }
    const report = summarizeAlphaSession(
      date,
      close,
      fixture({
        entries: [{ cycleId: 'orb', phase: morning, legs: [planned] }],
        fills: [fill(planned, 1, { priceAtoms })],
        orders: [order('orb', planned)],
      }),
    ).forensics.breakeven
    expect(report.roundTripProxyBps).toBeCloseTo(roundTripProxyBps, 10)
    expect(report).toMatchObject({
      verdict,
      complete: true,
      v2: { breakevenRoundTripBps: 6, verdict: v2 },
      v3: { breakevenRoundTripBps: 21.92, verdict: v3 },
    })
  },
)

test('warns on no fills, unavailable benchmarks, conflicting calendars or incomplete broker fills', () => {
  const absent = { ...leg('AMD', buy), signalBarCloseMicros: null, referencePriceMicros: null }
  const report = (overrides: Partial<AlphaSessionRows>) =>
    summarizeAlphaSession(date, close, fixture(overrides)).forensics
  const good = { ...leg('AAPL', buy), signalBarCloseMicros: null }
  const fills = [fill(good, 1, { priceAtoms: '100000000000' }), fill(absent, 2)]
  const entries: AlphaSessionRows['entries'] = [{ cycleId: 'orb', phase: morning, legs: [good, absent] }]
  const goodOrder = order('orb', good)
  const orders = [goodOrder, order('orb', absent)]
  expect(report({}).breakeven).toMatchObject({ verdict: 'WARN', roundTripProxyBps: null })
  expect(report({ entries, fills, orders }).breakeven).toMatchObject({
    verdict: 'WARN',
    complete: false,
    referenceFallbackOrders: 1,
    unbenchmarkedOrders: 1,
  })
  expect(
    report({
      entries,
      fills: fills.slice(0, 1),
      orders: [{ ...goodOrder, filledQuantityAtoms: '20000000000' }],
    }).breakeven,
  ).toMatchObject({ verdict: 'WARN', complete: false, benchmarkedOrders: 1 })
  expect(
    report({
      calendarCloses: [
        earlyCloseBinding,
        { ...earlyCloseBinding, cycleId: 'other', regularCloseAt: `${date}T21:00:00.000Z` },
      ],
    }).sessionBoundary,
  ).toMatchObject({ source: 'CLI_CALENDAR_CONFLICT' })
})
