import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { ConfigProvider, Console, Effect, Result, Schema } from 'effect'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OrderSide, OrderStatus, OrderType } from '../src/execution/contracts'
import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import { parseAuditArguments, runAudit } from './audit-bayn-live-profitability'
import {
  analyzeProfitability,
  AuditInput,
  decodeAuditInput,
  renderAuditJson,
  renderAuditMarkdown,
} from './live-profitability-audit-core'

type Session = typeof AuditInput.fields.sessions.value.Type
type Order = Session['orders'][number]
type Fill = Session['fills'][number]
const blackFriday = '2026-11-27'
const monday = '2026-11-30'
const at = (time: string, date = blackFriday) => `${date}T${time}:00.000Z`
const session = {
  date: blackFriday,
  dayStartAt: at('05:00'),
  asOf: at('21:30'),
  calendar: { openAt: at('14:30'), closeAt: at('18:00') },
  openingEquityMicros: '100000000000',
  openingPositions: [],
  positionMarks: [],
  reconciliation: {
    at: at('21:10'),
    positionsAt: at('21:09'),
    exact: true,
    coversActivity: true,
    positionCount: 0,
    positions: [],
  },
  entries: [],
  orders: [],
  fills: [],
  controller: [
    {
      id: 'healthy',
      at: at('18:05'),
      noAdmissibleCut: false,
      closeMarketDataUnavailable: false,
      closeWindowExpired: false,
    },
  ],
  market: { bars: [], quotes: [] },
  postedFeeDebitMicros: '0',
  pendingFees: 0,
  missingFillEvents: 0,
  unverifiedDecisions: 0,
} satisfies Session

const wrap = (...sessions: Session[]): typeof AuditInput.Type => ({
  schemaVersion: 'bayn.live-profitability-evidence.v1',
  sessions,
})
const audited = (fixture: Session) => {
  const decoded = Schema.decodeUnknownSync(AuditInput)(wrap(fixture))
  const [score] = analyzeProfitability(decoded).sessions
  if (score === undefined) throw new Error('Expected session score')
  return score
}
const atoms = (shares: number) => (BigInt(shares) * 1_000_000_000n).toString()
const order = (partial: Partial<Order>): Order => ({
  id: 'entry',
  entryId: 'entry',
  parentId: null,
  symbol: 'QQQ',
  side: OrderSide.Buy,
  type: OrderType.Limit,
  status: OrderStatus.Filled,
  quantityAtoms: atoms(10),
  limitMicros: '100020000',
  stopMicros: null,
  exitReferenceMicros: null,
  openedAt: at('15:00'),
  terminalAt: at('15:01'),
  protective: false,
  ...partial,
})
const fill = (partial: Partial<Fill>): Fill => ({
  id: 'fill',
  orderId: 'entry',
  symbol: 'QQQ',
  side: OrderSide.Buy,
  at: at('15:01'),
  quantityAtoms: atoms(10),
  priceAtoms: '100010000000',
  feeMicros: '20000',
  realizedMicros: '0',
  ...partial,
})

const googlBracketFailure: Session = {
  ...session,
  entries: [
    {
      id: 'googl-entry',
      sleeve: IntradayAlphaPhase.MorningOrb,
      symbol: 'GOOGL',
      side: OrderSide.Sell,
      quantityAtoms: atoms(103),
      signalMicros: '271080000',
      referenceMicros: '271080000',
      holdMinutes: 60,
    },
  ],
  orders: [
    order({
      id: 'googl-sell',
      entryId: 'googl-entry',
      symbol: 'GOOGL',
      side: OrderSide.Sell,
      quantityAtoms: atoms(103),
      limitMicros: '270810000',
      openedAt: '2026-11-27T15:02:08.000Z',
      terminalAt: '2026-11-27T15:02:09.000Z',
    }),
    order({
      id: 'googl-stop',
      entryId: 'googl-entry',
      parentId: 'googl-sell',
      symbol: 'GOOGL',
      type: OrderType.StopLimit,
      status: OrderStatus.Canceled,
      quantityAtoms: atoms(103),
      stopMicros: '275310000',
      limitMicros: '275580000',
      exitReferenceMicros: '275310000',
      openedAt: '2026-11-27T15:02:09.000Z',
      terminalAt: '2026-11-27T18:01:35.000Z',
      protective: true,
    }),
  ],
  fills: [
    fill({
      id: 'googl-fill',
      orderId: 'googl-sell',
      symbol: 'GOOGL',
      side: OrderSide.Sell,
      quantityAtoms: atoms(103),
      at: '2026-11-27T15:02:09.000Z',
      priceAtoms: '271025500000',
    }),
  ],
  positionMarks: [
    {
      symbol: 'GOOGL',
      at: '2026-11-27T18:01:34.000Z',
      quantityAtoms: atoms(-103),
      priceMicros: '275880000',
    },
  ],
  reconciliation: {
    ...session.reconciliation,
    positionCount: 1,
    positions: [{ symbol: 'GOOGL', quantityAtoms: atoms(-103), unrealizedMicros: '-500013500' }],
  },
  controller: [
    ...Array.from({ length: 354 }, (_, i) => ({
      id: `cut:${i}`,
      at: new Date(Date.parse('2026-11-27T15:02:21.000Z') + Math.floor((i * 10_739_000) / 353)).toISOString(),
      noAdmissibleCut: true,
      closeMarketDataUnavailable: false,
      closeWindowExpired: false,
    })),
    ...Array.from({ length: 5_548 }, (_, i) => ({
      id: `close:${i}`,
      at: new Date(Date.parse('2026-11-27T18:02:03.190Z') + Math.floor((i * 9_111_092) / 5_547)).toISOString(),
      noAdmissibleCut: false,
      closeMarketDataUnavailable: true,
      closeWindowExpired: false,
    })),
  ],
}

const healthy: Session = {
  ...session,
  entries: ['QQQ', 'SMH'].map((symbol) => ({
    id: symbol,
    sleeve: IntradayAlphaPhase.NoiseAreaTrend,
    symbol,
    side: OrderSide.Buy,
    quantityAtoms: atoms(10),
    signalMicros: '100000000',
    referenceMicros: '100005000',
    holdMinutes: 65,
  })),
  orders: ['QQQ', 'SMH'].flatMap((symbol) => [
    order({ id: `${symbol}-entry`, entryId: symbol, symbol }),
    order({
      id: `${symbol}-exit`,
      entryId: null,
      symbol,
      side: OrderSide.Sell,
      openedAt: at('15:30'),
      terminalAt: at('15:31'),
      limitMicros: '101980000',
      exitReferenceMicros: '102000000',
    }),
  ]),
  fills: ['QQQ', 'SMH'].flatMap((symbol) => [
    fill({
      id: `${symbol}-in-half-a`,
      orderId: `${symbol}-entry`,
      symbol,
      quantityAtoms: atoms(5),
      priceAtoms: '100005000000',
    }),
    fill({
      id: `${symbol}-in-half-b`,
      orderId: `${symbol}-entry`,
      symbol,
      quantityAtoms: atoms(5),
      priceAtoms: '100015000000',
    }),
    fill({
      id: `${symbol}-out`,
      orderId: `${symbol}-exit`,
      symbol,
      side: OrderSide.Sell,
      at: at('15:31'),
      priceAtoms: '101995000000',
      realizedMicros: '19850000',
    }),
  ]),
  postedFeeDebitMicros: '50000',
  market: {
    quotes: [],
    bars: [
      { symbol: 'QQQ', at: at('15:00'), feed: 'iex', closeMicros: '100020000' },
      { symbol: 'QQQ', at: at('15:00'), feed: 'sip', closeMicros: '100000000' },
      { symbol: 'QQQ', at: at('15:01'), feed: 'iex', closeMicros: '99990000' },
      { symbol: 'QQQ', at: at('15:01'), feed: 'sip', closeMicros: '100000000' },
      { symbol: 'SMH', at: at('15:00'), feed: 'iex', closeMicros: '100010000' },
    ],
  },
}

test('Black Friday: catches the GOOGL short gap-through, controller storm, timed exit, half-day close and stranded P&L', () => {
  const report = audited(googlBracketFailure)
  expect(report.verdict).toBe('FAIL')
  expect(report.controller).toMatchObject({ noAdmissibleCut: 354, closeMarketDataUnavailable: 5_548 })
  expect(report.entries[0]).toMatchObject({ fullyFilled: true })
  expect(report.entries[0]?.versusSignalBps).toBeCloseTo(2.01, 2)
  expect(report.entries[0]?.versusReferenceBps).toBeCloseTo(2.01, 2)
  expect(report.entries[0]?.versusLimitBps).toBeLessThan(0)
  expect(report.metrics).toMatchObject({
    entryFillRate: 1,
    observedStopCrosses: 1,
    stopLimitFillRate: 0,
    gapThroughIncidents: 1,
  })
  expect(report.protectiveStops[0]).toMatchObject({
    stopMicros: '275310000',
    limitMicros: '275580000',
    gapThrough: { source: 'POSITION_MARK', markPriceMicros: '275880000' },
  })
  expect(report.alerts).toEqual([
    'NO_ADMISSIBLE_CUT',
    'CLOSE_MARKET_DATA_UNAVAILABLE',
    'STOP_LIMIT_GAP_THROUGH',
    'MISSED_TIMED_EXIT',
    'REGULAR_CLOSE_BREACH',
    'NON_FLAT_EOD',
  ])
  expect(report.timedExitBreaches).toMatchObject([{ symbol: 'GOOGL', dueAt: '2026-11-27T16:02:09.000Z', flatAt: null }])
  expect(report.regularCloseBreaches).toMatchObject([{ symbol: 'GOOGL', regularCloseQuantity: '-103' }])
  expect(report.eodNonFlat).toMatchObject([
    { symbol: 'GOOGL', lastLedgerQuantity: '-103', lastBrokerQuantity: '-103', eodUnrealizedMicros: '-500013500' },
  ])
  expect(report.bySleeve[0]).toMatchObject({ sleeve: IntradayAlphaPhase.MorningOrb, eodUnrealizedMicros: '-500013500' })
  expect(report.slippageGate.promotion).toBe('INSUFFICIENT_EVIDENCE')
  const markdown = renderAuditMarkdown(analyzeProfitability(wrap(googlBracketFailure)))
  expect(markdown).toContain('stop $275.31 / limit $275.58')
  expect(markdown).toContain('NO_ADMISSIBLE_CUT: 354; CLOSE_MARKET_DATA_UNAVAILABLE: 5548')
  expect(markdown).toContain('regular close -103')
  expect(markdown).toContain('non-executable broker position mark $275.88')
})

test('a qualifying quote is reported instead of the broker mark, with its feed and first witnessed crossing', () => {
  const report = audited({
    ...googlBracketFailure,
    market: {
      bars: [],
      quotes: [
        { symbol: 'GOOGL', at: at('15:25'), feed: 'iex', bidMicros: '275290000', askMicros: '275300000' },
        { symbol: 'GOOGL', at: at('15:26'), feed: 'iex', bidMicros: '275650000', askMicros: '275660000' },
      ],
    },
  })
  expect(report.protectiveStops[0]?.gapThrough).toMatchObject({
    source: 'QUOTE',
    feed: 'iex',
    oppositePriceMicros: '275660000',
    firstObservedCrossAlreadyPastLimit: true,
  })
})

test('profitable, flat QQQ and SMH session passes with weighted partial fills and exact matched IEX/SIP drift', () => {
  const report = audited(healthy)
  expect(report.verdict).toBe('PASS')
  expect(report.alerts).toEqual([])
  expect(report.slippageGate).toMatchObject({
    samples: 2,
    meanBps: 1.490196,
    medianBps: 1.490196,
    promotionBps: 2.5,
    promotion: 'PASS',
    fullPeriodBreakevenBps: 11.2,
    fullPeriodBreakeven: 'PASS',
    recentBreakevenBps: 15.6,
  })
  expect(report.metrics).toMatchObject({
    fills: 6,
    realizedMicros: '39700000',
    netRealizedMicros: '39530000',
    directFeesMicros: '120000',
    unallocatedPostedFeesMicros: '50000',
    tradedNotionalMicros: '4040100000',
    annualizedTurnoverContribution: 10.181052,
    eodUnrealizedMicros: '0',
  })
  expect(report.bySleeve[0]).toMatchObject({ sleeve: IntradayAlphaPhase.NoiseAreaTrend, netRealizedMicros: '39580000' })
  expect(report.bySymbol).toMatchObject([
    { symbol: 'QQQ', entryVsSignal: { meanBps: 1 }, entryVsLimit: { meanBps: -0.9998 }, netRealizedMicros: '19790000' },
    { symbol: 'SMH', entryVsReference: { meanBps: 0.499975 } },
  ])
  expect(report.marketDrift).toMatchObject([
    { symbol: 'QQQ', meanBps: 0.5, medianBps: 0.5, absolute: { medianBps: 1.5 }, samples: 2, unmatchedMinutes: 0 },
    { symbol: 'SMH', samples: 0, meanBps: null, unmatchedMinutes: 1 },
  ])
  expect(renderAuditMarkdown(analyzeProfitability(wrap(healthy)))).toContain('1.49 / 1.49 bp (2 measured')
})

test('live promotion threshold is strict and distinct from research breakeven', () => {
  const withSlip = (exitMicros: string): Session => ({
    ...healthy,
    orders: healthy.orders.map((row) =>
      row.exitReferenceMicros === null ? row : { ...row, exitReferenceMicros: '101000000' },
    ),
    fills: healthy.fills.map((row) => (row.side === OrderSide.Buy ? row : { ...row, priceAtoms: `${exitMicros}000` })),
  })
  expect(audited(withSlip('100984850')).slippageGate).toMatchObject({
    medianBps: 2.5,
    promotion: 'FAIL',
    fullPeriodBreakeven: 'PASS',
  })
  expect(audited(withSlip('100896980')).slippageGate).toMatchObject({
    medianBps: 11.2,
    promotion: 'FAIL',
    fullPeriodBreakeven: 'FAIL',
  })
  expect(audited(withSlip('100984851')).slippageGate.promotion).toBe('PASS')
})

test('unmeasured, unreconciled, missing or unmatched evidence does not become flatness, zero P&L, or a pass', () => {
  expect(audited({ ...healthy, reconciliation: null }).evidence.eodEvidence).toBe(false)
  const report = audited({
    ...healthy,
    missingFillEvents: 1,
    reconciliation: null,
    orders: healthy.orders.map((row) => ({ ...row, exitReferenceMicros: null })),
  })
  expect(report.verdict).toBe('INSUFFICIENT_EVIDENCE')
  expect(report.metrics).toMatchObject({ realizedMicros: null, eodUnrealizedMicros: null, unmeasuredRoundTrips: 2 })
  expect(report.slippageGate).toMatchObject({ meanBps: null, promotion: 'INSUFFICIENT_EVIDENCE' })
  expect(
    audited({
      ...session,
      asOf: at('15:15'),
      reconciliation: null,
      controller: [],
      openingPositions: [{ symbol: 'QQQ', quantityAtoms: atoms(3) }],
    }).alerts,
  ).not.toContain('NON_FLAT_EOD')
  expect(audited({ ...healthy, pendingFees: 1 }).verdict).toBe('INSUFFICIENT_EVIDENCE')
  const openB0 = audited({
    ...healthy,
    fills: healthy.fills.filter(({ id }) => id !== 'SMH-out'),
    reconciliation: {
      ...session.reconciliation,
      positionCount: 1,
      positions: [{ symbol: 'SMH', quantityAtoms: atoms(10), unrealizedMicros: '10000' }],
    },
  })
  expect(openB0.slippageGate).toMatchObject({
    samples: 1,
    unmatchedFilledEntries: 1,
    promotion: 'INSUFFICIENT_EVIDENCE',
  })
  expect(openB0.alerts).toContain('NON_FLAT_EOD')
})

test('collar misses require executable-side evidence near submission, not just expiration', () => {
  const base = healthy.entries[0]
  if (base === undefined) throw new Error('Expected QQQ leg')
  const audit = (withQuote: boolean) =>
    audited({
      ...session,
      entries: [base],
      orders: [order({ entryId: base.id, status: OrderStatus.Expired })],
      market: {
        bars: [],
        quotes: withQuote
          ? [{ symbol: 'QQQ', at: at('15:00'), feed: 'iex', bidMicros: '100010000', askMicros: '100030000' }]
          : [],
      },
    })
  expect(audit(true).metrics).toMatchObject({ entryFillRate: 0, collarMissRate: 1, entryFullFillRate: 0 })
  expect(audit(false).metrics).toMatchObject({ entryFillRate: 0, collarMissRate: 0 })
})

test('uses the latest retained quote before a microsecond submission, not a quote one nanosecond after it', () => {
  const base = healthy.entries[0]
  if (base === undefined) throw new Error('Expected QQQ leg')
  const report = audited({
    ...session,
    entries: [base],
    orders: [order({ entryId: base.id, status: OrderStatus.Expired, openedAt: '2026-11-27T15:00:00.123456Z' })],
    market: {
      bars: [],
      quotes: [
        {
          symbol: 'QQQ',
          at: '2026-11-27T15:00:00.123456001Z',
          feed: 'iex',
          bidMicros: '100014000',
          askMicros: '100015000',
        },
        { symbol: 'QQQ', at: '2026-11-27T15:00:00.123Z', feed: 'iex', bidMicros: '100018000', askMicros: '100019000' },
        {
          symbol: 'QQQ',
          at: '2026-11-27T15:00:00.123455999Z',
          feed: 'iex',
          bidMicros: '100010000',
          askMicros: '100030000',
        },
      ],
    },
  })
  expect(report.metrics.collarMissRate).toBe(1)
})

test('preserves nanoseconds when ordering stop crossings and excluding quotes at or after termination', () => {
  const orderId = 'QQQ-stop'
  const report = audited({
    ...session,
    openingPositions: [{ symbol: 'QQQ', quantityAtoms: atoms(10) }],
    orders: [
      order({
        id: orderId,
        entryId: null,
        side: OrderSide.Sell,
        type: OrderType.StopLimit,
        status: OrderStatus.Canceled,
        openedAt: '2026-11-27T15:30:00.123Z',
        terminalAt: '2026-11-27T15:30:00.123457Z',
        stopMicros: '99000000',
        limitMicros: '98000000',
        protective: true,
      }),
    ],
    market: {
      bars: [],
      quotes: [
        { symbol: 'QQQ', at: '2026-11-27T15:30:00.123456999Z', feed: 'iex', bidMicros: '97000000', askMicros: null },
        { symbol: 'QQQ', at: '2026-11-27T15:30:00.123457Z', feed: 'iex', bidMicros: '96500000', askMicros: null },
        { symbol: 'QQQ', at: '2026-11-27T15:30:00.123456998Z', feed: 'iex', bidMicros: '98500000', askMicros: null },
        { symbol: 'QQQ', at: '2026-11-27T15:30:00.122999999Z', feed: 'iex', bidMicros: '96000000', askMicros: null },
      ],
    },
  })
  expect(report.protectiveStops).toMatchObject([
    {
      orderId,
      observedQuotes: 2,
      stopCrossed: true,
      gapThrough: {
        source: 'QUOTE',
        at: '2026-11-27T15:30:00.123456999Z',
        firstObservedCrossAlreadyPastLimit: false,
      },
    },
  ])
})

test('long protective stop fills on a crossing; later quotes cannot invent a gap after termination', () => {
  const withStop: Session = {
    ...healthy,
    orders: healthy.orders.map((row) =>
      row.id === 'QQQ-exit'
        ? {
            ...row,
            entryId: 'QQQ',
            parentId: 'QQQ-entry',
            protective: true,
            type: OrderType.StopLimit,
            stopMicros: '102000000',
            limitMicros: '101980000',
          }
        : row,
    ),
    market: {
      ...healthy.market,
      quotes: [
        { symbol: 'QQQ', at: at('15:30'), feed: 'iex', bidMicros: '101995000', askMicros: '102001000' },
        { symbol: 'QQQ', at: at('15:32'), feed: 'iex', bidMicros: '101000000', askMicros: '101010000' },
      ],
    },
  }
  expect(audited(withStop).metrics).toMatchObject({
    stopLimitFillRate: 1,
    observedStopCrosses: 1,
    gapThroughIncidents: 0,
  })
})

test('late flatten does not erase a half-day close breach or a missed timed exit', () => {
  const late = {
    ...healthy,
    orders: healthy.orders.map((row) =>
      row.side === OrderSide.Sell ? { ...row, openedAt: at('18:05'), terminalAt: at('18:06') } : row,
    ),
    fills: healthy.fills.map((row) => (row.side === OrderSide.Sell ? { ...row, at: at('18:06') } : row)),
  }
  const report = audited(late)
  expect(report.alerts).toEqual(['MISSED_TIMED_EXIT', 'REGULAR_CLOSE_BREACH', 'POST_REGULAR_CLOSE_ACTIVITY'])
  expect(report.eodNonFlat).toEqual([])
  expect(report.bySleeve[0]).toMatchObject({ sleeve: IntradayAlphaPhase.NoiseAreaTrend, regularCloseBreaches: 2 })
  expect(report.postCloseFillIds).toEqual(['QQQ-out', 'SMH-out'])
})

test('JSON is invariant to row ordering and rejects duplicate and malformed boundaries', () => {
  const reversed = {
    ...healthy,
    entries: healthy.entries.toReversed(),
    orders: healthy.orders.toReversed(),
    fills: healthy.fills.toReversed(),
    market: { ...healthy.market, bars: healthy.market.bars.toReversed() },
  }
  const later: Session = {
    ...session,
    date: monday,
    dayStartAt: at('05:00', monday),
    asOf: at('15:00', monday),
    calendar: null,
    reconciliation: null,
    controller: [],
  }
  const full = analyzeProfitability(wrap(later, healthy))
  expect(full.schemaVersion).toBe('bayn.live-profitability-audit.v1')
  expect(renderAuditJson(full)).toBe(renderAuditJson(analyzeProfitability(wrap(reversed, later))))
  expect(Result.isFailure(decodeAuditInput(wrap(healthy, healthy)))).toBe(true)
  expect(Result.isFailure(decodeAuditInput({ ...wrap(healthy), extraField: true }))).toBe(true)
  expect(
    Result.isFailure(
      decodeAuditInput(
        wrap({
          ...healthy,
          fills: [fill({ priceAtoms: 'NaN' })],
        }),
      ),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      decodeAuditInput(
        wrap({
          ...healthy,
          reconciliation: { ...session.reconciliation, positionCount: 1 },
        }),
      ),
    ),
  ).toBe(true)
  expect(Result.isFailure(decodeAuditInput(wrap({ ...healthy, fills: [fill({}), fill({})] })))).toBe(true)
})

test('parses inclusive selections strictly and rejects ambiguous, missing and out-of-range arguments', () => {
  expect(parseAuditArguments(['--to', monday, '--from', blackFriday, '--format', 'json'])).toMatchObject({
    _tag: 'Success',
    success: { dates: [blackFriday, '2026-11-28', '2026-11-29', monday], format: 'json' },
  })
  for (const args of [
    [],
    ['--session', '2026-02-29'],
    ['--session', blackFriday, '--from', blackFriday],
    ['--from', '2026-01-01', '--to', monday],
    ['--from', monday, '--to', blackFriday],
    ['--session', blackFriday, '--format', 'csv'],
    ['--session', blackFriday, '--session', monday],
    ['--from', blackFriday],
    ['--session', blackFriday, '--fixture'],
  ])
    expect(Result.isFailure(parseAuditArguments(args))).toBe(true)
})

test('fixture CLI selects only requested dates and runs without account or database configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bayn-live-audit-'))
  try {
    const path = join(dir, 'fixture.json')
    await writeFile(path, JSON.stringify(wrap(healthy)))
    const received: string[] = []
    const capture = {
      ...globalThis.console,
      log: (value: unknown) => {
        received.push(String(value))
      },
    }
    await Effect.runPromise(
      runAudit(['--session', blackFriday, '--format', 'json', '--fixture', path]).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off -- test runtime boundary
        Effect.provide(NodeServices.layer),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
        Effect.provideService(Console.Console, capture),
      ),
    )
    expect(received).toEqual([renderAuditJson(analyzeProfitability(wrap(healthy)))])
    const missing = await Effect.runPromise(
      runAudit(['--session', monday, '--fixture', path]).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off -- test runtime boundary
        Effect.provide(NodeServices.layer),
        Effect.result,
      ),
    )
    expect(Result.isFailure(missing)).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
