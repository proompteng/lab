import { Data, Result, Schema } from 'effect'

import { OrderSide, OrderStatus, OrderType } from '../src/execution/contracts'
import { compareIntradayInstants, intradayInstantNanos, millisecondsAsNanos } from '../src/market-data/intraday/time'
import { IsoDateSchema, StrictNonEmptyStringSchema, UtcSourceTimestampSchema } from '../src/schemas'
import {
  analyzeProfitability,
  type AuditInput,
  bindAuditOrder,
  completedMarketMinutes,
  group,
  type MarketEvidence,
  matchAuditEntry,
  SlippageBudgetStatus,
  summarizeMarketMinutes,
  summarizeObservations,
} from './live-profitability-audit-core'

export const FillTimingEvidence = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.fill-quality-timing-evidence.v1'),
  orders: Schema.Array(
    Schema.Struct({
      date: IsoDateSchema,
      orderId: StrictNonEmptyStringSchema,
      signalAt: Schema.NullOr(UtcSourceTimestampSchema),
      submittedAt: UtcSourceTimestampSchema,
    }),
  ),
})
export type FillTimingEvidence = typeof FillTimingEvidence.Type
type Timing = FillTimingEvidence['orders'][number]
type Session = AuditInput['sessions'][number]
type Order = Session['orders'][number]
type Quote = MarketEvidence['quotes'][number]

enum TimingIssue {
  UnknownOrder = 'UNKNOWN_ORDER',
  DuplicateOrder = 'DUPLICATE_ORDER',
  SignalAfterSubmit = 'SIGNAL_AFTER_SUBMIT',
  SubmitAfterCut = 'SUBMIT_AFTER_CUT',
  SubmitAfterExecution = 'SUBMIT_AFTER_EXECUTION',
}

class FillTimingError extends Data.TaggedError('FillTimingError')<{
  readonly message: string
  readonly cause: { readonly rowIndex: number; readonly kind: TimingIssue }
}> {}

const indexTiming = ({ sessions }: AuditInput, rows: FillTimingEvidence['orders']) =>
  Result.gen(function* () {
    const timings = new Map<string, Map<string, Timing>>()
    if (rows.length === 0) return timings
    const execution = new Map(
      sessions.map((session) => [
        session.date,
        {
          session,
          orders: new Map(session.orders.map((order) => [order.id, order])),
          fills: group(session.fills, (fill) => fill.orderId),
        },
      ]),
    )
    for (const [rowIndex, row] of rows.entries()) {
      const { date, orderId, signalAt, submittedAt } = row
      const day = execution.get(date)
      const order = day?.orders.get(orderId)
      const forDate = timings.get(date) ?? new Map<string, Timing>()
      const invalid = (kind: TimingIssue) =>
        Result.fail(
          new FillTimingError({
            message: `Invalid timing evidence at orders[${rowIndex}]: ${kind}.`,
            cause: { rowIndex, kind },
          }),
        )
      if (day === undefined || order === undefined) return yield* invalid(TimingIssue.UnknownOrder)
      if (forDate.has(orderId)) return yield* invalid(TimingIssue.DuplicateOrder)
      if (signalAt !== null && compareIntradayInstants(signalAt, submittedAt) > 0)
        return yield* invalid(TimingIssue.SignalAfterSubmit)
      if (compareIntradayInstants(submittedAt, day.session.asOf) > 0) return yield* invalid(TimingIssue.SubmitAfterCut)
      if (
        (order.terminalAt !== null && compareIntradayInstants(submittedAt, order.terminalAt) > 0) ||
        (day.fills.get(orderId) ?? []).some(
          (fill) => bindAuditOrder(fill, order) !== undefined && compareIntradayInstants(submittedAt, fill.at) > 0,
        )
      )
        return yield* invalid(TimingIssue.SubmitAfterExecution)
      forDate.set(orderId, row)
      timings.set(date, forDate)
    }
    return timings
  })

export enum FillWindow {
  Open = '09:30-10:00',
  Morning = '10:00-11:30',
  Midday = '11:30-14:00',
  Afternoon = '14:00-15:30',
  Close = '15:30-16:00',
  Outside = 'outside_regular_session',
}

export enum LegType {
  Entry = 'entry',
  Exit = 'exit',
  ProtectiveStop = 'protective_stop',
}

export enum FillSide {
  Buy = 'buy',
  Sell = 'sell',
}

export enum FillOrderType {
  Market = 'market',
  Limit = 'limit',
  StopLimit = 'stop_limit',
}

const orderType = {
  [OrderType.Market]: FillOrderType.Market,
  [OrderType.Limit]: FillOrderType.Limit,
  [OrderType.StopLimit]: FillOrderType.StopLimit,
}
const newYorkTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const windowFor = (calendar: Session['calendar'], at: string): FillWindow | null => {
  if (calendar === null) return null
  if (compareIntradayInstants(at, calendar.openAt) < 0 || compareIntradayInstants(at, calendar.closeAt) >= 0)
    return FillWindow.Outside
  const time = newYorkTime.format(Date.parse(at))
  if (time < '09:30' || time >= '16:00') return FillWindow.Outside
  if (time < '10:00') return FillWindow.Open
  if (time < '11:30') return FillWindow.Morning
  if (time < '14:00') return FillWindow.Midday
  if (time < '15:30') return FillWindow.Afternoon
  return FillWindow.Close
}

const quoteMaxAge = millisecondsAsNanos(1_000)
const makeQuoteLookup = (session: Session, additionalQuotes: MarketEvidence['quotes']) => {
  const inCut = [...session.market.quotes, ...additionalQuotes].filter(
    ({ feed, at }) =>
      feed === 'iex' &&
      compareIntradayInstants(at, session.dayStartAt) >= 0 &&
      compareIntradayInstants(at, session.asOf) <= 0,
  )
  const bySymbol = new Map<string, { readonly at: bigint; quote: Quote | null }[]>()
  for (const [symbol, quotes] of group(inCut, ({ symbol }) => symbol)) {
    const points: { readonly at: bigint; quote: Quote | null }[] = []
    for (const quote of quotes.sort((a, b) => compareIntradayInstants(a.at, b.at))) {
      const latest = points.at(-1)
      const at = intradayInstantNanos(quote.at)
      if (latest?.at !== at) points.push({ at, quote })
      else if (
        latest.quote !== null &&
        (latest.quote.bidMicros !== quote.bidMicros || latest.quote.askMicros !== quote.askMicros)
      )
        latest.quote = null
    }
    bySymbol.set(symbol, points)
  }
  return (symbol: string, timestamp: string) => {
    const points = bySymbol.get(symbol) ?? []
    const at = intradayInstantNanos(timestamp)
    let low = 0
    let high = points.length
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      const candidate = points[mid]
      if (candidate !== undefined && candidate.at <= at) low = mid + 1
      else high = mid
    }
    // Never look past a more recent withdrawn or conflicting quote for an older price.
    const latest = points[low - 1]
    return latest === undefined || at - latest.at > quoteMaxAge ? null : latest.quote
  }
}

const priceAtoms = (micros: string | null): bigint | null => (micros === null ? null : BigInt(micros) * 1_000n)
const executablePrice = (quote: Quote | null, side: OrderSide) =>
  priceAtoms((side === OrderSide.Buy ? quote?.askMicros : quote?.bidMicros) ?? null)
const midpoint = (quote: Quote | null) =>
  quote === null || quote.bidMicros === null || quote.askMicros === null
    ? null
    : (BigInt(quote.bidMicros) + BigInt(quote.askMicros)) * 500n
const elapsedMs = (later: string, earlier: string) =>
  Number(intradayInstantNanos(later) - intradayInstantNanos(earlier)) / 1_000_000

const fillMetrics = (
  fill: Session['fills'][number],
  referenceMicros: string | null,
  timing: Timing | undefined,
  atSubmit: Quote | null,
  atFill: Quote | null,
) => {
  const reference = priceAtoms(referenceMicros)
  const direction = fill.side === OrderSide.Buy ? 1n : -1n
  const deltaBps = (next: bigint | null, prev: bigint | null) =>
    next === null || prev === null || reference === null
      ? null
      : Number(direction * (next - prev) * 10_000n) / Number(reference)
  const submittedMid = midpoint(atSubmit)
  const filledMid = midpoint(atFill)
  const executable = executablePrice(atFill, fill.side)
  const executed = BigInt(fill.priceAtoms)
  return {
    realizedSlippageBps: deltaBps(executed, reference),
    signalToSubmitMs: timing?.signalAt == null ? null : elapsedMs(timing.submittedAt, timing.signalAt),
    submitToFillMs: timing === undefined ? null : elapsedMs(fill.at, timing.submittedAt),
    referenceToSubmitBps: deltaBps(submittedMid, reference),
    submitToFillDriftBps: deltaBps(filledMid, submittedMid),
    spreadBps: deltaBps(executable, filledMid),
    executionResidualBps: deltaBps(executed, executable),
  }
}

type Dimensions = {
  readonly timeOfDay: FillWindow | null
  readonly symbol: string
  readonly side: FillSide
  readonly legType: LegType | null
  readonly orderType: FillOrderType | null
}
type Observation = Dimensions &
  ({ readonly fill: ReturnType<typeof fillMetrics> } | { readonly collarMiss: boolean | null })

const classifyOrder = (order: Order, entry: ReturnType<typeof matchAuditEntry>) => {
  if (entry !== undefined) return LegType.Entry
  if (order.protective && order.type === OrderType.StopLimit) return LegType.ProtectiveStop
  return order.protective || order.exitReferenceMicros !== null ? LegType.Exit : null
}

const observationsFor = (
  session: Session,
  timings: ReadonlyMap<string, Timing> | undefined,
  market: MarketEvidence | undefined,
): Observation[] => {
  const quoteAt = makeQuoteLookup(session, market?.quotes ?? [])
  const entryById = new Map(session.entries.map((entry) => [entry.id, entry]))
  const orders = new Map(
    session.orders.map((order) => {
      const entry = matchAuditEntry(order, entryById)
      const timing = timings?.get(order.id)
      return [
        order.id,
        {
          order,
          timing,
          legType: classifyOrder(order, entry),
          reference: entry === undefined ? order.exitReferenceMicros : (entry.signalMicros ?? entry.referenceMicros),
          quote: timing === undefined ? null : quoteAt(order.symbol, timing.submittedAt),
        },
      ]
    }),
  )
  const observations: Observation[] = session.fills.map((fill) => {
    const candidate = orders.get(fill.orderId)
    const matched = bindAuditOrder(fill, candidate?.order) === undefined ? undefined : candidate
    return {
      timeOfDay: windowFor(session.calendar, fill.at),
      symbol: fill.symbol,
      side: fill.side === OrderSide.Buy ? FillSide.Buy : FillSide.Sell,
      legType: matched?.legType ?? null,
      orderType: matched === undefined ? null : orderType[matched.order.type],
      fill: fillMetrics(
        fill,
        matched?.reference ?? null,
        matched?.timing,
        matched?.quote ?? null,
        quoteAt(fill.symbol, fill.at),
      ),
    }
  })
  const filledOrders = new Set(session.fills.map(({ orderId }) => orderId))
  for (const { order, legType, timing, quote } of orders.values()) {
    if (
      legType !== LegType.Entry ||
      order.type !== OrderType.Limit ||
      (order.status !== OrderStatus.Canceled && order.status !== OrderStatus.Expired) ||
      filledOrders.has(order.id)
    )
      continue
    const executable = executablePrice(quote, order.side)
    const limit = priceAtoms(order.limitMicros)
    observations.push({
      timeOfDay: timing === undefined ? null : windowFor(session.calendar, timing.submittedAt),
      symbol: order.symbol,
      side: order.side === OrderSide.Buy ? FillSide.Buy : FillSide.Sell,
      legType,
      orderType: orderType[order.type],
      collarMiss:
        session.missingFillEvents > 0 || executable === null || limit === null
          ? null
          : order.side === OrderSide.Buy
            ? executable > limit
            : executable < limit,
    })
  }
  return observations
}

const summarize = (rows: readonly Observation[]) => {
  const fills = rows.flatMap((row) => ('fill' in row ? [row.fill] : []))
  const collars = rows.flatMap((row) => ('collarMiss' in row ? [row.collarMiss] : []))
  const observed = collars.filter((row) => row !== null)
  const misses = observed.filter((miss) => miss).length
  const metric = (key: keyof ReturnType<typeof fillMetrics>) =>
    summarizeObservations(fills.flatMap((fill) => (fill[key] === null ? [] : [fill[key]])))
  return {
    fills: fills.length,
    fullyDecomposedFills: fills.filter(
      (fill) =>
        fill.referenceToSubmitBps !== null &&
        fill.submitToFillDriftBps !== null &&
        fill.spreadBps !== null &&
        fill.executionResidualBps !== null,
    ).length,
    realizedSlippageBps: metric('realizedSlippageBps'),
    signalToSubmitMs: metric('signalToSubmitMs'),
    submitToFillMs: metric('submitToFillMs'),
    referenceToSubmitBps: metric('referenceToSubmitBps'),
    submitToFillDriftBps: metric('submitToFillDriftBps'),
    spreadBps: metric('spreadBps'),
    executionResidualBps: metric('executionResidualBps'),
    collar: {
      candidateAttempts: collars.length,
      observedAttempts: observed.length,
      misses: observed.length === 0 ? null : misses,
      missRate: observed.length === 0 ? null : misses / observed.length,
    },
  }
}

const compareKey = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null || a < b ? -1 : 1)
const byDimension = <K extends keyof Dimensions>(rows: readonly Observation[], key: K) =>
  [...group(rows, (row) => row[key])]
    .sort(([a], [b]) => compareKey(a, b))
    .map(([value, members]) => ({ value, ...summarize(members) }))

const marketOverlay = (session: Session, additional: MarketEvidence['bars']) =>
  [...group(completedMarketMinutes(session, [...session.market.bars, ...additional]), ({ symbol }) => symbol)].flatMap(
    ([symbol, minutes]) =>
      [...group(minutes, ({ at }) => windowFor(session.calendar, at))].map(([timeOfDay, rows]) => ({
        date: session.date,
        symbol,
        timeOfDay,
        ...summarizeMarketMinutes(rows),
      })),
  )

export const analyzeFillQuality = (input: AuditInput, timing?: FillTimingEvidence, market?: MarketEvidence) =>
  indexTiming(input, timing?.orders ?? []).pipe(
    Result.map((timings) => {
      const sessions = input.sessions.toSorted((a, b) => compareKey(a.date, b.date))
      const observations = sessions.flatMap((session) => observationsFor(session, timings.get(session.date), market))
      const dispersion = sessions.flatMap((session) => marketOverlay(session, market?.bars ?? []))
      return {
        schemaVersion: 'bayn.fill-quality-attribution.v1' as const,
        sessions: analyzeProfitability(input).sessions.map(({ date, asOf, slippageGate: gate, evidence }) => {
          const { missingFillEvents, unresolvedFills, unverifiedDecisions } = evidence
          const incomplete = missingFillEvents > 0 || unresolvedFills > 0 || unverifiedDecisions > 0
          return {
            date,
            asOf,
            missingFillEvents,
            unresolvedFills,
            unverifiedDecisions,
            b0: {
              cohort: gate.cohort,
              budgetBps: gate.promotionBps,
              ...summarizeObservations(gate.roundTripBps),
              unmeasuredRoundTrips: gate.unmeasuredRoundTrips,
              unmatchedFilledEntries: gate.unmatchedFilledEntries,
              status:
                incomplete && gate.promotion === SlippageBudgetStatus.Pass
                  ? SlippageBudgetStatus.Insufficient
                  : gate.promotion,
            },
          }
        }),
        overall: summarize(observations),
        byTimeOfDay: byDimension(observations, 'timeOfDay'),
        bySymbol: byDimension(observations, 'symbol'),
        bySide: byDimension(observations, 'side'),
        byLegType: byDimension(observations, 'legType'),
        byOrderType: byDimension(observations, 'orderType'),
        marketDispersion: dispersion.length === 0 ? null : dispersion,
      }
    }),
  )

type Report = Result.Result.Success<ReturnType<typeof analyzeFillQuality>>
export const renderFillQualityJson = (report: Report) => JSON.stringify(report, null, 2)

const text = (value: number | string | null) => (value === null ? 'null' : String(value))
const stats = ({ samples, mean, median }: ReturnType<typeof summarizeObservations>) =>
  `${text(mean)} / ${text(median)} (n=${samples})`
const rowMarkdown = (scope: string, row: ReturnType<typeof summarize>) =>
  `| ${scope} | ${row.fills} / ${row.fullyDecomposedFills} | ${stats(row.realizedSlippageBps)} | ${stats(row.signalToSubmitMs)} | ${stats(row.submitToFillMs)} | ${stats(row.referenceToSubmitBps)} | ${stats(row.submitToFillDriftBps)} | ${stats(row.spreadBps)} | ${stats(row.executionResidualBps)} | ${text(row.collar.misses)} / ${row.collar.observedAttempts} of ${row.collar.candidateAttempts} |`

export const renderFillQualityMarkdown = (report: Report) =>
  [
    '# Bayn fill-quality attribution',
    '',
    `Schema: ${report.schemaVersion}. Read-only diagnostic; not a trading or promotion authorization.`,
    '',
    '## B0 round-trip slippage',
    '',
    '| Session | Cut (UTC) | Mean / median bp | Budget (strictly below) | Status | Unmeasured / unmatched | Missing fills / unresolved fills / unverified decisions |',
    '| --- | --- | --- | ---: | --- | --- | --- |',
    ...report.sessions.map(
      ({ date, asOf, b0, missingFillEvents, unresolvedFills, unverifiedDecisions }) =>
        `| ${date} | ${asOf} | ${stats(b0)} | ${b0.budgetBps} | ${b0.status} | ${b0.unmeasuredRoundTrips} / ${b0.unmatchedFilledEntries} | ${missingFillEvents} / ${unresolvedFills} / ${unverifiedDecisions} |`,
    ),
    '',
    '## Fill attribution',
    '',
    'Mean / median with sample counts. Positive bp are adverse; null is unobserved. Components add per fully decomposed fill, not across different sample sets.',
    '',
    '| Scope | Fills / fully decomposed | Realized bp | Signal → submit ms | Submit → fill ms | Reference → submit bp | Submit → fill drift bp | Spread bp | Execution residual bp | Collar misses / observed of candidate attempts |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    rowMarkdown('Overall', report.overall),
    ...report.byTimeOfDay.map((row) => rowMarkdown(`ET: ${text(row.value)}`, row)),
    ...report.bySymbol.map((row) => rowMarkdown(`Symbol: ${row.value}`, row)),
    ...report.bySide.map((row) => rowMarkdown(`Side: ${row.value}`, row)),
    ...report.byLegType.map((row) => rowMarkdown(`Leg: ${text(row.value)}`, row)),
    ...report.byOrderType.map((row) => rowMarkdown(`Order: ${text(row.value)}`, row)),
    '',
    '## IEX vs SIP completed-minute dispersion',
    '',
    ...(report.marketDispersion === null
      ? ['null (no completed regular-session minute evidence)']
      : [
          '| Session | Symbol | ET | Signed mean / median bp | Absolute mean / median bp | Unmatched / conflicting minutes |',
          '| --- | --- | --- | --- | --- | --- |',
          ...report.marketDispersion.map(
            ({
              date,
              symbol,
              timeOfDay,
              samples,
              meanBps,
              medianBps,
              absolute,
              unmatchedMinutes,
              conflictingMinutes,
            }) =>
              `| ${date} | ${symbol} | ${text(timeOfDay)} | ${stats({ samples, mean: meanBps, median: medianBps })} | ${stats({ samples: absolute.samples, mean: absolute.meanBps, median: absolute.medianBps })} | ${unmatchedMinutes} / ${conflictingMinutes} |`,
          ),
        ]),
  ].join('\n')
