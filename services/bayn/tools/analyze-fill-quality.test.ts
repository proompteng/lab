import { expect, test } from 'bun:test'
import { Console, Deferred, Effect, Exit, Fiber, FileSystem, Redacted, Result } from 'effect'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OrderSide, OrderStatus, OrderType } from '../src/execution/contracts'
import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import {
  analyzeFillQuality,
  FillOrderType,
  FillSide,
  type FillTimingEvidence,
  FillWindow,
  LegType,
  renderFillQualityJson,
  renderFillQualityMarkdown,
} from './analyze-fill-quality-core'
import { runFillQuality } from './analyze-fill-quality'
import {
  type AuditInput,
  decodeAuditInput,
  type MarketEvidence,
  SlippageBudgetStatus,
} from './live-profitability-audit-core'

type Session = AuditInput['sessions'][number]
type Order = Session['orders'][number]
type Fill = Session['fills'][number]
type Entry = Session['entries'][number]
type Timing = FillTimingEvidence['orders'][number]

const date = '2026-11-30'
const at = (time: string, day = date) => `${day}T${time}Z`
const atoms = (shares: number) => (BigInt(shares) * 1_000_000_000n).toString()
const session = (overrides: Partial<Session> = {}): Session => ({
  date,
  dayStartAt: at('05:00:00.000'),
  asOf: at('21:10:00.000'),
  calendar: { openAt: at('14:30:00.000'), closeAt: at('21:00:00.000') },
  openingEquityMicros: null,
  reconciliation: null,
  positionMarks: [],
  openingPositions: [],
  entries: [],
  orders: [],
  fills: [],
  controller: [],
  market: { bars: [], quotes: [] },
  postedFeeDebitMicros: '0',
  pendingFees: 0,
  missingFillEvents: 0,
  unverifiedDecisions: 0,
  ...overrides,
})
const entry = (overrides: Partial<Entry> = {}): Entry => ({
  id: 'plan',
  sleeve: IntradayAlphaPhase.NoiseAreaTrend,
  symbol: 'QQQ',
  side: OrderSide.Buy,
  quantityAtoms: atoms(4),
  signalMicros: '100000000',
  referenceMicros: '100000000',
  holdMinutes: 15,
  ...overrides,
})
const order = (overrides: Partial<Order> = {}): Order => ({
  id: 'entry',
  entryId: 'plan',
  parentId: null,
  symbol: 'QQQ',
  side: OrderSide.Buy,
  type: OrderType.Limit,
  status: OrderStatus.Filled,
  quantityAtoms: atoms(4),
  limitMicros: '100050000',
  stopMicros: null,
  exitReferenceMicros: null,
  openedAt: at('14:31:01.000000002'),
  terminalAt: at('14:31:03.000'),
  protective: false,
  ...overrides,
})
const fill = (overrides: Partial<Fill> = {}): Fill => ({
  id: 'buy',
  orderId: 'entry',
  symbol: 'QQQ',
  side: OrderSide.Buy,
  at: at('14:31:02.000000003'),
  quantityAtoms: atoms(4),
  priceAtoms: '100032000000',
  feeMicros: '0',
  realizedMicros: '0',
  ...overrides,
})
const clock = (overrides: Partial<Timing> = {}): Timing => ({
  date,
  orderId: 'entry',
  signalAt: at('14:31:00.000000001'),
  submittedAt: at('14:31:01.000000002'),
  ...overrides,
})
const quote = (
  time: string,
  bidMicros: string | null,
  askMicros: string | null,
  symbol = 'QQQ',
): MarketEvidence['quotes'][number] => ({ symbol, at: at(time), feed: 'iex', bidMicros, askMicros })
const bar = (
  time: string,
  feed: MarketEvidence['bars'][number]['feed'],
  closeMicros: string,
  symbol = 'QQQ',
  day = date,
): MarketEvidence['bars'][number] => ({ symbol, at: at(time, day), feed, closeMicros })
const evidence = (...sessions: Session[]): AuditInput => ({
  schemaVersion: 'bayn.live-profitability-evidence.v1',
  sessions,
})
const timings = (...orders: Timing[]): FillTimingEvidence => ({
  schemaVersion: 'bayn.fill-quality-timing-evidence.v1',
  orders,
})
const decoded = (...days: Session[]) => Result.getOrThrow(decodeAuditInput(evidence(...days)))
const analyze = (day: Session, clocks?: FillTimingEvidence, market?: MarketEvidence) =>
  Result.getOrThrow(analyzeFillQuality(decoded(day), clocks, market))
const one = (value: number) => ({ samples: 1, mean: value, median: value })
const unobserved = { samples: 0, mean: null, median: null }

test('attributes signed buy and sell price moves, spread, residual and nanosecond-preserving latency', () => {
  const exit = order({
    id: 'exit',
    entryId: null,
    side: OrderSide.Sell,
    type: OrderType.Market,
    limitMicros: null,
    exitReferenceMicros: '100000000',
    openedAt: at('15:03:00.000'),
    terminalAt: at('15:03:02.000'),
  })
  const report = analyze(
    session({
      entries: [entry(), entry({ id: 'smh-plan', symbol: 'SMH' })],
      orders: [
        order(),
        exit,
        order({
          id: 'stop',
          parentId: 'smh-entry',
          entryId: 'smh-plan',
          symbol: 'SMH',
          side: OrderSide.Sell,
          type: OrderType.StopLimit,
          protective: true,
          stopMicros: '100000000',
          limitMicros: '99900000',
          exitReferenceMicros: '100000000',
          terminalAt: at('16:30:01.000'),
        }),
      ],
      fills: [
        fill(),
        fill({ id: 'sell', orderId: exit.id, side: exit.side, at: at('15:03:01.500'), priceAtoms: '99990000000' }),
        fill({
          id: 'stop-fill',
          orderId: 'stop',
          symbol: 'SMH',
          side: OrderSide.Sell,
          at: at('16:30:00.000'),
          priceAtoms: '100000000000',
        }),
      ],
      market: {
        bars: [],
        quotes: [
          quote('14:31:01.000000001', '100008000', '100012000'),
          quote('14:31:02.000000003', '100027000', '100033000'),
          quote('15:03:00.000', '99994000', '99996000'),
          quote('15:03:01.500', '99988000', '99992000'),
        ],
      },
    }),
    timings(clock(), clock({ orderId: 'exit', signalAt: null, submittedAt: exit.openedAt })),
  )
  expect(report.schemaVersion).toBe('bayn.fill-quality-attribution.v1')
  const [buy, sell, stop] = report.byLegType
  expect(buy).toMatchObject({
    value: LegType.Entry,
    realizedSlippageBps: one(3.2),
    signalToSubmitMs: one(1000.000001),
    submitToFillMs: one(1000.000001),
    referenceToSubmitBps: one(1),
    submitToFillDriftBps: one(2),
    spreadBps: one(0.3),
    executionResidualBps: one(-0.1),
    fullyDecomposedFills: 1,
  })
  expect(sell).toMatchObject({
    value: LegType.Exit,
    realizedSlippageBps: one(1),
    signalToSubmitMs: unobserved,
    submitToFillMs: one(1500),
    referenceToSubmitBps: one(0.5),
    submitToFillDriftBps: one(0.5),
    spreadBps: one(0.2),
    executionResidualBps: one(-0.2),
    fullyDecomposedFills: 1,
  })
  expect(stop).toMatchObject({ value: LegType.ProtectiveStop, realizedSlippageBps: one(0), spreadBps: unobserved })
  expect(report.bySide.map((row) => [row.value, row.fills])).toEqual([
    [FillSide.Buy, 1],
    [FillSide.Sell, 2],
  ])
  expect(report.byOrderType.map((row) => row.value)).toEqual([
    FillOrderType.Limit,
    FillOrderType.Market,
    FillOrderType.StopLimit,
  ])
  expect(report.bySymbol.map((row) => row.value)).toEqual(['QQQ', 'SMH'])
  expect(report.byTimeOfDay.map((row) => [row.value, row.fills])).toEqual([
    [FillWindow.Open, 1],
    [FillWindow.Morning, 1],
    [FillWindow.Midday, 1],
  ])
  expect(report.overall).toMatchObject({
    fills: 3,
    fullyDecomposedFills: 2,
    realizedSlippageBps: { samples: 3, median: 1 },
  })
})

test.each([
  [date, '05', '14', '15', '16', '19', '20', '21'],
  ['2026-07-01', '04', '13', '14', '15', '18', '19', '20'],
] as const)(
  'buckets actual fills in half-open New York intervals on %s',
  (day, midnight, open, ten, eleven, two, three, close) => {
    const times = [
      at(`${open}:29:59.999999999`, day),
      at(`${open}:30:00.000`, day),
      at(`${ten}:00:00.000`, day),
      at(`${eleven}:30:00.000`, day),
      at(`${two}:00:00.000`, day),
      at(`${three}:30:00.000`, day),
      at(`${close}:00:00.000`, day),
    ]
    const report = analyze(
      session({
        date: day,
        dayStartAt: at(`${midnight}:00:00.000`, day),
        asOf: at(`${close}:10:00.000`, day),
        calendar: { openAt: at(`${open}:30:00.000`, day), closeAt: at(`${close}:00:00.000`, day) },
        fills: times.map((time, index) => fill({ id: String(index), at: time })),
      }),
    )
    expect(report.byTimeOfDay.map((row) => [row.value, row.fills])).toEqual([
      [FillWindow.Open, 1],
      [FillWindow.Morning, 1],
      [FillWindow.Midday, 1],
      [FillWindow.Afternoon, 1],
      [FillWindow.Close, 1],
      [FillWindow.Outside, 2],
    ])
  },
)

test('does not assign a regular bucket after the provider early close, or any bucket without a calendar', () => {
  const day = session({
    calendar: { openAt: at('14:30:00.000'), closeAt: at('18:00:00.000') },
    fills: [fill({ at: at('18:00:00.000') })],
  })
  expect(analyze(day).byTimeOfDay[0]?.value).toBe(FillWindow.Outside)
  expect(analyze({ ...day, calendar: null }).byTimeOfDay[0]?.value).toBeNull()
})

test('missing bindings, benchmarks, quotes and explicit clocks are not attributed or converted to zero', () => {
  const report = analyze(
    session({
      entries: [entry({ signalMicros: null })],
      orders: [order(), order({ id: 'no-plan', entryId: null, symbol: 'XLK' })],
      fills: [
        fill(),
        fill({ id: 'missing-order', orderId: 'not-found' }),
        fill({ id: 'mismatch', orderId: 'no-plan' }),
      ],
    }),
  )
  expect(report.overall).toMatchObject({
    fills: 3,
    realizedSlippageBps: one(3.2),
    signalToSubmitMs: unobserved,
    submitToFillMs: unobserved,
    referenceToSubmitBps: unobserved,
    submitToFillDriftBps: unobserved,
    spreadBps: unobserved,
    executionResidualBps: unobserved,
    collar: { candidateAttempts: 0, observedAttempts: 0, misses: null, missRate: null },
  })
  expect(report.byLegType).toMatchObject([
    { value: LegType.Entry, fills: 1 },
    { value: null, fills: 2 },
  ])
  expect(report.byOrderType).toMatchObject([
    { value: 'limit', fills: 1 },
    { value: null, fills: 2 },
  ])
  expect(report.sessions[0]).toMatchObject({
    unresolvedFills: 2,
    b0: { mean: null, median: null, status: 'INSUFFICIENT_EVIDENCE' },
  })
  expect(report.marketDispersion).toBeNull()
  expect(analyze(session()).overall.realizedSlippageBps).toEqual(unobserved)
})

test('uses the freshest same-feed quote at or before the event, without falling back from unusable quotes', () => {
  const day = session({ entries: [entry()], orders: [order()], fills: [fill()] })
  const submit = quote('14:31:00.000000002', '100008000', '100012000') // exactly one second old
  const good = quote('14:31:02.000000003', '100027000', '100033000')
  const later = quote('14:31:02.000000004', '108000000', '109000000')
  const sip = { ...good, feed: 'sip' as const, askMicros: '120000000' }
  const metrics = (quotes: MarketEvidence['quotes']) => analyze(day, timings(clock()), { bars: [], quotes }).overall
  expect(metrics([submit, sip, later, good, good])).toMatchObject({
    referenceToSubmitBps: one(1),
    submitToFillDriftBps: one(2),
    spreadBps: one(0.3),
  })
  expect(metrics([{ ...submit, at: at('14:31:00.000000001') }, good])).toMatchObject({
    referenceToSubmitBps: unobserved,
    submitToFillDriftBps: unobserved,
    spreadBps: one(0.3),
  })
  expect(metrics([submit, good, { ...good, askMicros: '100035000' }])).toMatchObject({
    referenceToSubmitBps: one(1),
    submitToFillDriftBps: unobserved,
    spreadBps: unobserved,
    executionResidualBps: unobserved,
  })
  expect(
    metrics([submit, good, { ...good, at: at('14:31:02.000000002') }, { ...good, bidMicros: null }]),
  ).toMatchObject({
    spreadBps: unobserved,
    executionResidualBps: unobserved,
  })
  expect(metrics([submit, { ...good, bidMicros: null }])).toMatchObject({
    submitToFillDriftBps: unobserved,
    spreadBps: unobserved,
    executionResidualBps: one(-0.1),
  })
  expect(metrics([submit, sip, later])).toMatchObject({ spreadBps: unobserved, executionResidualBps: unobserved })
})

test('counts only observed zero-fill canceled/expired entry limit attempts as measurable collars', () => {
  const attempts = [
    order({ id: 'miss', status: OrderStatus.Expired }),
    order({ id: 'inside', status: OrderStatus.Canceled, symbol: 'SMH', entryId: 'smh-plan', side: OrderSide.Sell }),
    order({ id: 'unknown', status: OrderStatus.Canceled, symbol: 'XLK', entryId: 'xlk-plan' }),
    order({ id: 'partial-canceled', status: OrderStatus.Canceled }),
    order({ id: 'rejected', status: OrderStatus.Rejected }),
    order({ id: 'protective-close', status: OrderStatus.Expired, protective: true }),
  ]
  const day = session({
    entries: [
      entry(),
      entry({ id: 'smh-plan', symbol: 'SMH', side: OrderSide.Sell }),
      entry({ id: 'xlk-plan', symbol: 'XLK' }),
    ],
    orders: attempts,
    fills: [fill({ orderId: 'partial-canceled', quantityAtoms: atoms(1) })],
    market: {
      bars: [],
      quotes: [
        quote('14:31:01.000', null, '100050001'),
        quote('14:31:01.000', '100050000', null, 'SMH'),
        quote('14:31:01.000', '100010000', null, 'XLK'),
      ],
    },
  })
  const clocks = timings(...attempts.map(({ id }) => clock({ orderId: id })))
  const report = analyze(day, clocks)
  expect(report.overall.collar).toEqual({ candidateAttempts: 3, observedAttempts: 2, misses: 1, missRate: 0.5 })
  expect(report.bySymbol.map(({ value, collar }) => [value, collar.misses])).toEqual([
    ['QQQ', 1],
    ['SMH', 0],
    ['XLK', null],
  ])
  expect(report.byTimeOfDay[0]).toMatchObject({ value: FillWindow.Open, collar: { misses: 1 } })
  for (const unknown of [analyze(day), analyze({ ...day, missingFillEvents: 1 }, clocks)]) {
    expect(unknown.overall.collar).toEqual({ candidateAttempts: 3, observedAttempts: 0, misses: null, missRate: null })
  }
})

test('the CLI entry point keeps stdout report-only and emits redacted failures to stderr', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bayn-fill-quality-'))
  const path = join(directory, 'private_input_marker')
  const run = () =>
    Bun.spawnSync(
      [process.execPath, join(import.meta.dir, 'analyze-fill-quality.ts'), '--fixture', path, '--format', 'json'],
      { stdout: 'pipe', stderr: 'pipe' },
    )
  try {
    writeFileSync(path, JSON.stringify(evidence(session())))
    const valid = run()
    expect(valid.exitCode).toBe(0)
    expect(valid.stderr.toString()).toBe('')
    expect(valid.stdout.toString().trimEnd()).toBe(renderFillQualityJson(analyze(session())))

    writeFileSync(path, '{ "private_input_marker": invalid }')
    const invalid = run()
    expect(invalid.exitCode).toBe(1)
    expect(invalid.stdout.toString()).toBe('')
    expect(invalid.stderr.toString()).toContain('FillQualityInputError')
    expect(invalid.stderr.toString()).not.toContain('private_input_marker')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

const trip = (index: number, entryPriceAtoms: string, symbol = 'QQQ') => {
  const entryId = `plan-${index}`
  const buyId = `buy-${index}`
  const sellId = `sell-${index}`
  const minute = `14:${32 + index}`
  const base = { symbol, type: OrderType.Market, limitMicros: null }
  return {
    entries: [entry({ id: entryId, symbol })],
    orders: [
      order({ ...base, id: buyId, entryId, openedAt: at(`${minute}:00.000`), terminalAt: at(`${minute}:01.000`) }),
      order({
        ...base,
        id: sellId,
        entryId: null,
        side: OrderSide.Sell,
        exitReferenceMicros: '100000000',
        openedAt: at(`${minute}:02.000`),
        terminalAt: at(`${minute}:03.000`),
      }),
    ],
    fills: [
      fill({ symbol, id: buyId, orderId: buyId, at: at(`${minute}:01.000`), priceAtoms: entryPriceAtoms }),
      fill({
        symbol,
        id: sellId,
        orderId: sellId,
        side: OrderSide.Sell,
        at: at(`${minute}:03.000`),
        priceAtoms: '100000000000',
      }),
    ],
  }
}

test('B0 checks unrounded QQQ/SMH round trips strictly below 2.5 bp, not other fills or displayed values', () => {
  const qqq = trip(0, '100024999999')
  const xlk = trip(1, '100100000000', 'XLK')
  const below = analyze(
    session({
      entries: [...qqq.entries, ...xlk.entries],
      orders: [...qqq.orders, ...xlk.orders],
      fills: [...qqq.fills, ...xlk.fills],
    }),
  )
  expect(below.sessions[0]?.b0).toMatchObject({ status: 'PASS', budgetBps: 2.5, samples: 1 })
  expect(below.sessions[0]?.b0.mean).toBeCloseTo(2.4999999, 9)
  expect(below.overall.fills).toBe(4)
  expect(analyze(session(trip(0, '100025000000', 'SMH'))).sessions[0]?.b0).toMatchObject({
    status: 'FAIL',
    mean: 2.5,
    median: 2.5,
  })
  expect(analyze(session({ ...qqq, missingFillEvents: 1 })).sessions[0]?.b0.status).toBe(
    SlippageBudgetStatus.Insufficient,
  )
  expect(
    analyze(
      session({
        ...qqq,
        orders: qqq.orders.map((row) => ({ ...row, exitReferenceMicros: null })),
      }),
    ).sessions[0]?.b0,
  ).toMatchObject({ status: 'INSUFFICIENT_EVIDENCE', unmeasuredRoundTrips: 1, mean: null, median: null })
})

test.each([
  [[0, 0, 9], 3, 0],
  [[-9, 3, 3], -1, 3],
] as const)('B0 fails if either the mean or the median breaches (%j)', (bps, mean, median) => {
  const trips = bps.map((value, index) => trip(index, (100_000_000_000n + BigInt(value) * 10_000_000n).toString()))
  const report = analyze(
    session({
      entries: trips.flatMap((row) => row.entries),
      orders: trips.flatMap((row) => row.orders),
      fills: trips.flatMap((row) => row.fills),
    }),
  )
  expect(report.sessions[0]?.b0).toMatchObject({ status: 'FAIL', samples: 3 })
  expect(report.sessions[0]?.b0.mean).toBeCloseTo(mean, 12)
  expect(report.sessions[0]?.b0.median).toBeCloseTo(median, 12)
})

test('B0 rejects exact equality across both legs even when binary floating point would round below', () => {
  const rows = trip(0, '100000006000')
  const report = analyze(
    session({
      ...rows,
      fills: rows.fills.map((row) => (row.side === OrderSide.Sell ? { ...row, priceAtoms: '99975006000' } : row)),
    }),
  )
  // 0.0006 bp on entry plus 2.4994 bp on exit.
  expect(report.sessions[0]?.b0).toMatchObject({ status: 'FAIL', mean: 2.5, median: 2.5 })
})

test('B0 keeps quantity-weighted partial fills within a round trip separate from fill record distributions', () => {
  const rows = trip(0, '100010000000')
  const [buy, sell] = rows.fills
  if (buy === undefined || sell === undefined) throw new Error('Expected synthetic buy and sell')
  const report = analyze(
    session({
      ...rows,
      fills: [
        { ...buy, at: at('14:32:00.500'), quantityAtoms: atoms(1) },
        { ...buy, id: 'partial', quantityAtoms: atoms(3), priceAtoms: '100030000000' },
        sell,
      ],
    }),
  )
  expect(report.sessions[0]?.b0).toMatchObject({ status: 'FAIL', samples: 1, mean: 2.5, median: 2.5 })
  expect(report.byLegType[0]?.realizedSlippageBps).toEqual({ samples: 2, mean: 2, median: 2 })
})

test('overlays completed same-symbol minute pairs, unmatched minutes and conflicts without borrowing future data', () => {
  const pair = (time: string, iex = '100010000') => [bar(time, 'iex', iex), bar(time, 'sip', '100000000')]
  const day = session({
    asOf: at('16:32:30.000'),
    market: {
      quotes: [],
      bars: [
        ...pair('14:29:00.000'), // before open
        ...pair('14:59:00.000'),
        ...pair('14:58:00.000', '99980000'),
        ...pair('16:32:00.000'), // not completed by the cut
      ],
    },
  })
  const market = {
    quotes: [],
    bars: [
      bar('14:59:00.000', 'iex', '100010000'), // identical duplicate
      ...pair('15:00:00.000'),
      bar('15:00:00.000', 'iex', '100020000'), // conflict
      bar('16:31:00.000', 'sip', '100000000', 'SMH'),
      bar('16:31:00.000', 'iex', '100000000', 'XLK'), // not a match for SMH
    ],
  } satisfies MarketEvidence
  const report = analyze(day, undefined, market)
  expect(report.marketDispersion).toMatchObject([
    {
      symbol: 'QQQ',
      timeOfDay: FillWindow.Open,
      samples: 2,
      meanBps: -0.5,
      medianBps: -0.5,
      absolute: { meanBps: 1.5 },
    },
    { symbol: 'QQQ', timeOfDay: FillWindow.Morning, samples: 0, meanBps: null, medianBps: null, conflictingMinutes: 1 },
    { symbol: 'SMH', timeOfDay: FillWindow.Midday, samples: 0, unmatchedMinutes: 1 },
    { symbol: 'XLK', timeOfDay: FillWindow.Midday, samples: 0, unmatchedMinutes: 1 },
  ])
  expect(analyze({ ...day, calendar: null }, undefined, market).marketDispersion).toBeNull()
  expect(
    analyze({
      ...day,
      asOf: at('18:10:00.000'),
      calendar: { openAt: at('14:30:00.000'), closeAt: at('18:00:00.000') },
      market: { bars: pair('18:00:00.000'), quotes: [] },
    }).marketDispersion,
  ).toBeNull()
  expect(renderFillQualityMarkdown(report)).toContain('| QQQ | 09:30-10:00 | -0.5 / -0.5 (n=2) |')
})

test('both renderers are stable under evidence ordering, including multiple sessions and duplicate quotes', () => {
  const base = session({
    entries: [entry()],
    orders: [order()],
    fills: [fill(), fill({ id: 'partial', priceAtoms: '100050000000', quantityAtoms: atoms(1) })],
    market: {
      quotes: [
        quote('14:31:01.000', '100000000', '100010000'),
        quote('14:31:02.000', '100010000', '100020000'),
        quote('14:31:02.000000000', '100010000', '100030000'),
      ],
      bars: [bar('14:58:00.000', 'sip', '100000000'), bar('14:58:00.000', 'iex', '100010000')],
    },
  })
  const early = '2026-11-27'
  const other = session({
    date: early,
    dayStartAt: at('05:00:00.000', early),
    asOf: at('18:10:00.000', early),
    calendar: { openAt: at('14:30:00.000', early), closeAt: at('18:00:00.000', early) },
  })
  const first = Result.getOrThrow(analyzeFillQuality(decoded(base, other), timings(clock())))
  const second = Result.getOrThrow(
    analyzeFillQuality(
      decoded(other, {
        ...base,
        fills: base.fills.toReversed(),
        market: { quotes: base.market.quotes.toReversed(), bars: base.market.bars.toReversed() },
      }),
      timings(clock()),
    ),
  )
  expect(renderFillQualityJson(first)).toBe(renderFillQualityJson(second))
  expect(renderFillQualityMarkdown(first)).toBe(renderFillQualityMarkdown(second))
  expect(first.sessions.map((row) => row.date)).toEqual(['2026-11-27', date])
})

test.each([
  [[clock({ orderId: 'unbound' })], 'UNKNOWN_ORDER'],
  [[clock(), clock()], 'DUPLICATE_ORDER'],
  [[clock({ signalAt: at('14:31:01.000000003') })], 'SIGNAL_AFTER_SUBMIT'],
  [[clock({ submittedAt: at('21:10:00.000000001') })], 'SUBMIT_AFTER_CUT'],
  [[clock({ submittedAt: at('14:31:02.000000004') })], 'SUBMIT_AFTER_EXECUTION'],
] as const)('rejects contradictory timing rows (%s)', (rows, kind) => {
  const result = analyzeFillQuality(
    decoded(session({ entries: [entry()], orders: [order()], fills: [fill()] })),
    timings(...rows),
  )
  expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'FillTimingError', cause: { kind } } })
})

const invoke = async (args: readonly string[], files: ReadonlyMap<string, string> = new Map()) => {
  const reads: string[] = []
  const stdout: string[] = []
  const fallback = FileSystem.makeNoop({})
  const result = await Effect.runPromise(
    runFillQuality(args).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: (path) => {
            reads.push(path)
            const value = files.get(path)
            return value === undefined ? fallback.readFileString(path) : Effect.succeed(value)
          },
        }),
      ),
      Effect.provideService(Console.Console, {
        ...globalThis.console,
        log: (value: string) => {
          stdout.push(value)
        },
      }),
      Effect.result,
    ),
  )
  return { result, reads, stdout }
}

test('CLI emits requested JSON or default Markdown and only reads the supplied files', async () => {
  const day = session({ entries: [entry()], orders: [order()], fills: [fill()] })
  const timing = timings(clock())
  const market = { bars: [bar('14:31:00.000', 'sip', '100000000')], quotes: [] }
  const files = new Map([
    ['fixture', JSON.stringify(evidence(day))],
    ['timing', JSON.stringify(timing)],
    ['market', JSON.stringify(market)],
  ])
  const json = await invoke(
    ['--format', 'json', '--market-evidence', 'market', '--fixture', 'fixture', '--timing-evidence', 'timing'],
    files,
  )
  expect(json).toEqual({
    reads: ['fixture', 'timing', 'market'],
    stdout: [renderFillQualityJson(analyze(day, timing, market))],
    result: Result.succeed(undefined),
  })
  const markdown = await invoke(['--fixture', 'fixture'], files)
  expect(markdown.stdout[0]).toContain('# Bayn fill-quality attribution')
  expect(markdown.stdout[0]).toContain('null (no completed regular-session minute evidence)')
  const help = await invoke(['--help'])
  expect(help.stdout[0]).toContain('Usage:')
  expect(help.reads).toEqual([])
})

test('interrupting the fixture read finalizes it once without reading supplements or emitting a report', async () => {
  let reads = 0
  let finalized = 0
  const stdout: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(
        runFillQuality(['--fixture', 'fixture', '--market-evidence', 'market']).pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              readFileString: () => {
                reads++
                return Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(
                    Effect.sync(() => {
                      finalized++
                    }),
                  ),
                )
              },
            }),
          ),
          Effect.provideService(Console.Console, {
            ...globalThis.console,
            log: (value: string) => {
              stdout.push(value)
            },
          }),
        ),
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    }),
  )
  expect(reads).toBe(1)
  expect(finalized).toBe(1)
  expect(stdout).toEqual([])
})

test('a file service defect is not converted into a report or an expected input failure', async () => {
  const exit = await Effect.runPromiseExit(
    runFillQuality(['--fixture', 'fixture']).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({ readFileString: () => Effect.die('fixture boundary defect') }),
      ),
    ),
  )
  expect(Exit.hasDies(exit)).toBe(true)
})

test.each([
  [],
  ['--fixture'],
  ['--fixture', ' '],
  ['--fixture', '--format'],
  ['--format', 'json'],
  ['--fixture', 'path', '--format', 'xml'],
  ['--fixture', 'path', '--fixture', 'other'],
  ['--fixture', 'path', '--session', date],
  ['--fixture', 'path', '--help'],
])('CLI fails closed on invalid arguments (%j)', async (...args) => {
  const { reads, stdout, result } = await invoke(args)
  expect(reads).toEqual([])
  expect(stdout).toEqual([])
  expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'FillQualityUsageError' } })
})

test.each([
  ['--fixture', undefined],
  ['--fixture', '{private_input_marker'],
  ['--fixture', JSON.stringify({ ...evidence(session()), private_input_marker: 'not evidence' })],
  ['--fixture', JSON.stringify({ schemaVersion: 'bayn.live-profitability-audit.v1', sessions: [] })],
  [
    '--timing-evidence',
    JSON.stringify({ ...timings(), orders: [{ ...clock(), submittedAt: 'private_input_marker' }] }),
  ],
  ['--market-evidence', JSON.stringify({ bars: [], quotes: [quote('14:31:00', '200000000', '100000000')] })],
] as const)('CLI redacts structured causes for bad input in %s', async (source, content) => {
  const files = new Map([['fixture', JSON.stringify(evidence(session()))]])
  const args = ['--fixture', 'fixture']
  if (source !== '--fixture') args.push(source, 'private_input_marker')
  const target = source === '--fixture' ? 'fixture' : 'private_input_marker'
  if (content === undefined) {
    files.delete(target)
    args[1] = 'private_input_marker'
  } else files.set(target, content)
  const { stdout, result } = await invoke(args, files)
  expect(stdout).toEqual([])
  expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'FillQualityInputError', source } })
  if (Result.isFailure(result) && result.failure._tag === 'FillQualityInputError') {
    expect(JSON.stringify(result.failure.cause)).toBe('"<redacted>"')
    expect(Redacted.value(result.failure.cause)._tag).toBe(content === undefined ? 'PlatformError' : 'SchemaError')
    expect(JSON.stringify(result.failure)).not.toContain('private_input_marker')
  }
})
