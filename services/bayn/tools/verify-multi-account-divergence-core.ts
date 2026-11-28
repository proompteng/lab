import { Data, Redacted, Result, Schema, SchemaIssue } from 'effect'

import { OrderSide, OrderStatus, OrderType } from '../src/execution/contracts'
import { compareIntradayInstants, intradayAgeNanos, millisecondsAsNanos } from '../src/market-data/intraday/time'
import { quantityScale } from '../src/quantity'
import {
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  SymbolSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
  UtcSourceTimestampSchema,
  strictParseOptions,
} from '../src/schemas'
import { accountTradingDate } from '../src/time'

export enum Account {
  LiveMain = 'LIVE_MAIN',
  PaperMain = 'PAPER_MAIN',
  PaperSmall = 'PAPER_SMALL_10K',
}

export enum Severity {
  Pass = 'PASS',
  Warn = 'WARN',
  Fail = 'FAIL',
}

export enum Format {
  Json = 'json',
  Markdown = 'markdown',
}

export enum ErrorCode {
  Arguments = 'INVALID_ARGUMENTS',
  Read = 'FIXTURE_READ_FAILED',
  Json = 'INVALID_JSON',
  Evidence = 'INVALID_EVIDENCE',
  NotPass = 'VERIFICATION_NOT_PASS',
  Unexpected = 'UNEXPECTED_ERROR',
}

export class DivergenceError extends Data.TaggedError('DivergenceError')<{
  readonly code: ErrorCode
  readonly message: string
  readonly cause: Redacted.Redacted<unknown>
}> {}

export const divergenceError = (code: ErrorCode, message: string, cause: unknown) =>
  new DivergenceError({ code, message, cause: Redacted.make(cause) })

const shadows = [Account.PaperMain, Account.PaperSmall] as const
type Shadow = (typeof shadows)[number]
const unique = <T>(values: readonly T[]) => new Set(values).size === values.length
const positive = PositiveMicrosSchema.check(Schema.isMaxLength(39))
const unsigned = UnsignedMicrosSchema.check(Schema.isMaxLength(39))
const atOrBefore = (left: string, right: string) => compareIntradayInstants(left, right) <= 0

const thresholdPrecision = 1_000
const BpsLimit = Schema.Finite.check(
  Schema.isBetween({ minimum: 0, maximum: 10_000 }),
  Schema.makeFilter((n) => Math.round(n * thresholdPrecision) / thresholdPrecision === n, {
    expected: 'no more than three decimal places',
  }),
)
const ThresholdOverrides = Schema.Struct({
  maxSignalDelayMs: Schema.optionalKey(NonNegativeIntegerSchema),
  maxWeightDeltaBps: Schema.optionalKey(BpsLimit),
  maxSlippageDeltaBps: Schema.optionalKey(BpsLimit),
  maxFeeDeltaBps: Schema.optionalKey(BpsLimit),
  maxPdtCountDelta: Schema.optionalKey(NonNegativeIntegerSchema),
})
type Thresholds = Required<typeof ThresholdOverrides.Type>
const defaults: Thresholds = {
  maxSignalDelayMs: 1_000,
  maxWeightDeltaBps: 50,
  maxSlippageDeltaBps: 2.5,
  maxFeeDeltaBps: 1,
  maxPdtCountDelta: 0,
}

const identityFields = {
  slot: NonNegativeIntegerSchema,
  symbol: SymbolSchema,
  side: Schema.Enum(OrderSide),
}
const Signal = Schema.Struct({ ...identityFields, at: UtcSourceTimestampSchema })
const Fill = Schema.Struct({
  executionHash: Sha256Schema,
  at: UtcSourceTimestampSchema,
  quantityAtoms: positive,
  priceAtoms: positive,
  feeMicros: unsigned,
})
const Order = Schema.Struct({
  ...identityFields,
  type: Schema.Enum(OrderType),
  status: Schema.Enum(OrderStatus),
  quantityAtoms: positive,
  referenceMicros: positive,
  limitMicros: Schema.NullOr(positive),
  stopMicros: Schema.NullOr(positive),
  fills: Schema.Array(Fill),
}).check(
  Schema.makeFilter(
    (order) => {
      const requested = BigInt(order.quantityAtoms)
      const filled = order.fills.reduce((sum, fill) => sum + BigInt(fill.quantityAtoms), 0n)
      const statusMatches =
        order.status === OrderStatus.Filled
          ? filled === requested
          : order.status === OrderStatus.PartiallyFilled
            ? filled > 0n && filled < requested
            : order.status === OrderStatus.Canceled || order.status === OrderStatus.Expired
              ? filled < requested
              : filled === 0n
      if (!statusMatches) return false
      if (order.type === OrderType.Market) return order.limitMicros === null && order.stopMicros === null
      if (order.limitMicros === null) return false
      if (order.type === OrderType.Limit) return order.stopMicros === null
      if (order.stopMicros === null) return false
      const limit = BigInt(order.limitMicros)
      const stop = BigInt(order.stopMicros)
      return order.side === OrderSide.Buy ? limit >= stop : limit <= stop
    },
    { expected: 'consistent order status, filled quantity, and price terms' },
  ),
)
const Session = Schema.Struct({
  date: IsoDateSchema,
  openAt: UtcInstantSchema,
  closeAt: UtcInstantSchema,
  asOf: UtcInstantSchema,
  complete: Schema.Boolean,
  openingEquityMicros: positive,
  pdtDayTrades: NonNegativeIntegerSchema,
  unattributedFeeMicros: unsigned,
  signals: Schema.Array(Signal),
  orders: Schema.Array(Order),
}).check(
  Schema.makeFilter(
    (session) => {
      const { date, openAt, closeAt, asOf, signals, orders } = session
      const inSession = (at: string) => accountTradingDate(at) === date && atOrBefore(at, asOf)
      return (
        openAt.startsWith(date) &&
        closeAt.startsWith(date) &&
        openAt < closeAt &&
        closeAt <= asOf &&
        unique(signals.map(({ slot }) => slot)) &&
        unique(orders.map(({ slot }) => slot)) &&
        signals.every(({ at }) => inSession(at)) &&
        orders.every(({ fills }) => fills.every(({ at }) => inSession(at)))
      )
    },
    { expected: 'one post-close session cut with unique logical slots and in-session events' },
  ),
)
type Session = typeof Session.Type
type Order = typeof Order.Type

const AccountEvidence = Schema.Struct({
  identityHash: Sha256Schema,
  sessions: Schema.Array(Session),
}).check(
  Schema.makeFilter(
    ({ sessions }) =>
      unique(sessions.map(({ date }) => date)) &&
      unique(
        sessions.flatMap(({ orders }) =>
          orders.flatMap(({ fills }) => fills.map(({ executionHash }) => executionHash)),
        ),
      ),
    { expected: 'unique session dates and execution hashes within an account' },
  ),
)

const Evidence = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.multi-account-divergence-evidence.v1'),
  sessionDates: Schema.NonEmptyArray(IsoDateSchema).check(Schema.makeFilter(unique)),
  allowedSymbols: Schema.NonEmptyArray(SymbolSchema).check(Schema.makeFilter(unique)),
  thresholds: Schema.optionalKey(ThresholdOverrides),
  accounts: Schema.Struct({
    [Account.LiveMain]: AccountEvidence,
    [Account.PaperMain]: AccountEvidence,
    [Account.PaperSmall]: AccountEvidence,
  }),
}).check(
  Schema.makeFilter(
    ({ accounts, sessionDates }) => {
      const snapshots = Object.values(accounts)
      const expected = new Set(sessionDates)
      return (
        unique(snapshots.map(({ identityHash }) => identityHash)) &&
        snapshots.every(({ sessions }) => sessions.every(({ date }) => expected.has(date)))
      )
    },
    { expected: 'three distinct account bindings and no undeclared sessions' },
  ),
)

const decodeEvidence = Schema.decodeUnknownResult(Evidence, strictParseOptions)
const unexpectedKey = 'UnexpectedKey'
const schemaIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => (issue._tag === unexpectedKey ? unexpectedKey : SchemaIssue.defaultLeafHook(issue)),
})
const invalidEvidence = (cause: Schema.SchemaError) => {
  const issue = schemaIssues(cause.issue).issues[0]
  // With input reporting off, schema messages describe the contract. An unknown property name is still input.
  const segments = issue?.message === unexpectedKey ? issue.path?.slice(0, -1) : issue?.path
  const path = (segments ?? [])
    .map((key) => (typeof key === 'number' ? `[${key}]` : typeof key === 'string' ? `.${key}` : '[?]'))
    .join('')
  const reason = issue?.message === unexpectedKey ? 'unexpected property' : (issue?.message ?? 'invalid fixture')
  return divergenceError(ErrorCode.Evidence, `$${path}: ${reason}`, cause)
}

export enum FindingCode {
  MissingSession = 'MISSING_SESSION',
  IncompleteSession = 'INCOMPLETE_SESSION',
  MisalignedSession = 'MISALIGNED_SESSION',
  UnauthorizedSymbol = 'UNAUTHORIZED_SYMBOL',
  MissingSignal = 'MISSING_SIGNAL',
  SignalMismatch = 'SIGNAL_MISMATCH',
  SignalTiming = 'SIGNAL_TIMING_DRIFT',
  NoSignals = 'NO_COMPARABLE_SIGNALS',
  MissingOrder = 'MISSING_ORDER',
  OrderTerms = 'ORDER_TERMS_MISMATCH',
  OrderReference = 'ORDER_REFERENCE_MISMATCH',
  OrderStatus = 'ORDER_STATUS_MISMATCH',
  MissingFill = 'MISSING_FILL',
  FillFraction = 'FILL_FRACTION_MISMATCH',
  NoFills = 'NO_COMPARABLE_FILLS',
  OrderWeight = 'ORDER_WEIGHT_DIVERGENCE',
  FillWeight = 'FILL_WEIGHT_DIVERGENCE',
  Slippage = 'SLIPPAGE_DIVERGENCE',
  Fee = 'FEE_DIVERGENCE',
  FeeWithoutFills = 'FEES_WITHOUT_FILLS',
  Pdt = 'PDT_COUNT_DIVERGENCE',
}

interface Finding {
  readonly code: FindingCode
  readonly severity: Severity.Fail | Severity.Warn
  readonly account?: Account
  readonly signalSlot?: number
  readonly orderSlot?: number
  readonly deltaMs?: number
}
const fail = (code: FindingCode, context: Omit<Finding, 'code' | 'severity'> = {}): Finding => ({
  code,
  severity: Severity.Fail,
  ...context,
})
const warn = (code: FindingCode): Finding => ({ code, severity: Severity.Warn })
const worst = (values: readonly Severity[]): Severity =>
  values.includes(Severity.Fail) ? Severity.Fail : values.includes(Severity.Warn) ? Severity.Warn : Severity.Pass
const abs = (n: bigint) => (n < 0n ? -n : n)

interface Metric {
  readonly live: number
  readonly paper: number
  readonly delta: number
}
interface Ratio {
  readonly numerator: bigint
  readonly denominator: bigint
}
const ratio = (numerator: bigint, denominator: bigint): Ratio => ({ numerator, denominator })
const bpsPerUnit = 10_000n
const asBps = ({ numerator, denominator }: Ratio) =>
  Number((Number(numerator * bpsPerUnit) / Number(denominator)).toFixed(6))

const compareBps = (live: Ratio, paper: Ratio, limit: number, onBreach: () => void): Metric => {
  const delta = ratio(
    paper.numerator * live.denominator - live.numerator * paper.denominator,
    paper.denominator * live.denominator,
  )
  // Compare before presentation rounding; exact equality is within the configured limit.
  if (
    abs(delta.numerator) * bpsPerUnit * BigInt(thresholdPrecision) >
    delta.denominator * BigInt(Math.round(limit * thresholdPrecision))
  )
    onBreach()
  return { live: asBps(live), paper: asBps(paper), delta: asBps(delta) }
}

const orderedSlots = <T extends { readonly slot: number }>(live: readonly T[], paper: readonly T[]) => {
  const left = new Map(live.map((row) => [row.slot, row]))
  const right = new Map(paper.map((row) => [row.slot, row]))
  return [...new Set([...left.keys(), ...right.keys()])]
    .sort((a, b) => a - b)
    .map((slot) => ({
      slot,
      live: left.get(slot),
      paper: right.get(slot),
    }))
}

const compareSignals = (
  live: Session,
  paper: Session,
  shadow: Shadow,
  allowed: ReadonlySet<string>,
  threshold: number,
  findings: Finding[],
) => {
  let matched = 0
  let maxAbsDeltaMs: number | null = null
  for (const { slot, live: a, paper: b } of orderedSlots(live.signals, paper.signals)) {
    const context = { signalSlot: slot }
    if (a !== undefined && !allowed.has(a.symbol))
      findings.push(fail(FindingCode.UnauthorizedSymbol, { ...context, account: Account.LiveMain }))
    if (b !== undefined && !allowed.has(b.symbol))
      findings.push(fail(FindingCode.UnauthorizedSymbol, { ...context, account: shadow }))
    if (a === undefined || b === undefined) {
      findings.push(
        fail(FindingCode.MissingSignal, { ...context, account: a === undefined ? Account.LiveMain : shadow }),
      )
    } else if (a.symbol !== b.symbol || a.side !== b.side) {
      findings.push(fail(FindingCode.SignalMismatch, context))
    } else if (allowed.has(a.symbol)) {
      matched++
      const delta = intradayAgeNanos(b.at, a.at)
      const deltaMs = Number(delta) / 1_000_000
      maxAbsDeltaMs = Math.max(maxAbsDeltaMs ?? 0, Math.abs(deltaMs))
      if (abs(delta) > millisecondsAsNanos(threshold))
        findings.push(fail(FindingCode.SignalTiming, { ...context, deltaMs }))
    }
  }
  if (matched === 0) findings.push(warn(FindingCode.NoSignals))
  return { live: live.signals.length, paper: paper.signals.length, matched, maxAbsDeltaMs }
}

// Price and quantity atoms retain 9 decimals. Equity, benchmarks and fees retain 6.
const notionalScale = 1_000n * quantityScale
const measure = (order: Order) => {
  let filled = 0n
  let traded = 0n
  let fees = 0n
  for (const fill of order.fills) {
    const quantity = BigInt(fill.quantityAtoms)
    filled += quantity
    traded += quantity * BigInt(fill.priceAtoms)
    fees += BigInt(fill.feeMicros)
  }
  const reference = BigInt(order.referenceMicros) * 1_000n
  const requested = BigInt(order.quantityAtoms)
  const expected = reference * filled
  const adverse = (order.side === OrderSide.Buy ? 1n : -1n) * (traded - expected)
  return {
    order,
    slot: order.slot,
    filled,
    traded,
    fees,
    requested,
    requestedNotional: reference * requested,
    expected,
    adverse,
  }
}

const summarizeOrders = (session: Session) => {
  let traded = 0n
  let fees = BigInt(session.unattributedFeeMicros)
  let fillCount = 0
  const orders = session.orders.map((order) => {
    const metrics = measure(order)
    traded += metrics.traded
    fees += metrics.fees
    fillCount += order.fills.length
    return metrics
  })
  return { orders, traded, fees, fillCount, equity: BigInt(session.openingEquityMicros) * notionalScale }
}

interface OrderReport {
  readonly slot: number
  readonly orderWeightBps: Metric | null
  readonly fillWeightBps: Metric
  readonly filledFractionBps: Metric
  readonly slippageBps: Metric | null
  readonly feeBps: Metric | null
}

const feeRate = (fees: bigint, traded: bigint) => ratio(fees * notionalScale, traded)

const compareOrders = (
  live: Session,
  paper: Session,
  shadow: Shadow,
  allowed: ReadonlySet<string>,
  limits: Thresholds,
  findings: Finding[],
) => {
  const byOrder: OrderReport[] = []
  const left = summarizeOrders(live)
  const right = summarizeOrders(paper)
  for (const { slot, live: x, paper: y } of orderedSlots(left.orders, right.orders)) {
    const context = { orderSlot: slot }
    if (x !== undefined && !allowed.has(x.order.symbol))
      findings.push(fail(FindingCode.UnauthorizedSymbol, { ...context, account: Account.LiveMain }))
    if (y !== undefined && !allowed.has(y.order.symbol))
      findings.push(fail(FindingCode.UnauthorizedSymbol, { ...context, account: shadow }))
    if (x === undefined || y === undefined) {
      findings.push(
        fail(FindingCode.MissingOrder, { ...context, account: x === undefined ? Account.LiveMain : shadow }),
      )
      continue
    }
    const { order: a } = x
    const { order: b } = y
    if (
      a.symbol !== b.symbol ||
      a.side !== b.side ||
      a.type !== b.type ||
      a.limitMicros !== b.limitMicros ||
      a.stopMicros !== b.stopMicros
    ) {
      findings.push(fail(FindingCode.OrderTerms, context))
      continue
    }
    if (!allowed.has(a.symbol)) continue
    if (a.status !== b.status) findings.push(fail(FindingCode.OrderStatus, context))
    const sameReference = a.referenceMicros === b.referenceMicros
    if (!sameReference) findings.push(fail(FindingCode.OrderReference, context))
    const check = (code: FindingCode, lhs: Ratio, rhs: Ratio, limit: number) =>
      compareBps(lhs, rhs, limit, () => findings.push(fail(code, context)))
    const filledFractionBps = check(
      (x.filled === 0n) !== (y.filled === 0n) ? FindingCode.MissingFill : FindingCode.FillFraction,
      ratio(x.filled, x.requested),
      ratio(y.filled, y.requested),
      0,
    )
    const slippageBps =
      sameReference && x.filled > 0n && y.filled > 0n
        ? check(
            FindingCode.Slippage,
            ratio(x.adverse, x.expected),
            ratio(y.adverse, y.expected),
            limits.maxSlippageDeltaBps,
          )
        : null
    byOrder.push({
      slot,
      orderWeightBps: sameReference
        ? check(
            FindingCode.OrderWeight,
            ratio(x.requestedNotional, left.equity),
            ratio(y.requestedNotional, right.equity),
            limits.maxWeightDeltaBps,
          )
        : null,
      fillWeightBps: check(
        FindingCode.FillWeight,
        ratio(x.traded, left.equity),
        ratio(y.traded, right.equity),
        limits.maxWeightDeltaBps,
      ),
      filledFractionBps,
      slippageBps,
      feeBps:
        x.traded > 0n && y.traded > 0n
          ? check(FindingCode.Fee, feeRate(x.fees, x.traded), feeRate(y.fees, y.traded), limits.maxFeeDeltaBps)
          : null,
    })
  }
  const comparableFilledOrders = byOrder.filter(({ slippageBps }) => slippageBps !== null).length
  if (comparableFilledOrders === 0) findings.push(warn(FindingCode.NoFills))
  if (left.traded === 0n && left.fees > 0n)
    findings.push(fail(FindingCode.FeeWithoutFills, { account: Account.LiveMain }))
  if (right.traded === 0n && right.fees > 0n) findings.push(fail(FindingCode.FeeWithoutFills, { account: shadow }))
  const feeBps =
    left.traded === 0n || right.traded === 0n
      ? null
      : compareBps(feeRate(left.fees, left.traded), feeRate(right.fees, right.traded), limits.maxFeeDeltaBps, () =>
          findings.push(fail(FindingCode.Fee)),
        )
  return {
    orders: { live: live.orders.length, paper: paper.orders.length, comparable: byOrder.length },
    fills: { live: left.fillCount, paper: right.fillCount, comparableFilledOrders },
    feeBps,
    byOrder,
  }
}

const compareSession = (
  live: Session | undefined,
  paper: Session | undefined,
  shadow: Shadow,
  allowed: ReadonlySet<string>,
  limits: Thresholds,
  findings: Finding[],
) => {
  if (live === undefined) findings.push(fail(FindingCode.MissingSession, { account: Account.LiveMain }))
  else if (!live.complete) findings.push(fail(FindingCode.IncompleteSession, { account: Account.LiveMain }))
  if (paper === undefined) findings.push(fail(FindingCode.MissingSession, { account: shadow }))
  else if (!paper.complete) findings.push(fail(FindingCode.IncompleteSession, { account: shadow }))
  if (live === undefined || paper === undefined || !live.complete || !paper.complete) return null
  if (live.openAt !== paper.openAt || live.closeAt !== paper.closeAt || live.asOf !== paper.asOf) {
    findings.push(fail(FindingCode.MisalignedSession))
    return null
  }
  const signals = compareSignals(live, paper, shadow, allowed, limits.maxSignalDelayMs, findings)
  const execution = compareOrders(live, paper, shadow, allowed, limits, findings)
  const pdt = { live: live.pdtDayTrades, paper: paper.pdtDayTrades, delta: paper.pdtDayTrades - live.pdtDayTrades }
  if (Math.abs(pdt.delta) > limits.maxPdtCountDelta) findings.push(fail(FindingCode.Pdt))
  return { cut: { openAt: live.openAt, closeAt: live.closeAt, asOf: live.asOf }, signals, ...execution, pdt }
}

export const verifyDivergence = (input: unknown) =>
  Result.gen(function* () {
    const evidence = yield* decodeEvidence(input).pipe(Result.mapError(invalidEvidence))
    const thresholds: Thresholds = { ...defaults, ...evidence.thresholds }
    const allowed = new Set(evidence.allowedSymbols)
    const dates = (account: Account) =>
      new Map(evidence.accounts[account].sessions.map((session) => [session.date, session]))
    const live = dates(Account.LiveMain)
    const paper = shadows.map((shadow) => ({ shadow, snapshots: dates(shadow) }))
    const sessions = evidence.sessionDates.toSorted().map((date) => ({
      date,
      comparisons: paper.map(({ shadow, snapshots }) => {
        const findings: Finding[] = []
        return {
          shadow,
          metrics: compareSession(live.get(date), snapshots.get(date), shadow, allowed, thresholds, findings),
          severity: worst(findings.map(({ severity }) => severity)),
          findings,
        }
      }),
    }))
    return {
      schemaVersion: 'bayn.multi-account-divergence-report.v1',
      severity: worst(sessions.flatMap(({ comparisons }) => comparisons.map(({ severity }) => severity))),
      thresholds,
      sessions,
    } as const
  })

type Report = Result.Result.Success<ReturnType<typeof verifyDivergence>>
const cell = (metric: Metric | null) => (metric === null ? '—' : `${metric.live} / ${metric.paper} / ${metric.delta}`)

export const renderDivergence = (report: Report, format: Format): string => {
  if (format === Format.Json) return JSON.stringify(report, null, 2)
  const lines = ['# Bayn multi-account divergence', '', `**${report.severity}**`, '', 'Limits (absolute):']
  for (const [key, limit] of Object.entries(report.thresholds)) lines.push(`- \`${key}\`: ${limit}`)
  for (const { date, comparisons } of report.sessions) {
    for (const { shadow, metrics, severity, findings } of comparisons) {
      lines.push('', `## ${date} — ${shadow} vs ${Account.LiveMain}: ${severity}`)
      for (const { severity: level, code, account, signalSlot, orderSlot, deltaMs } of findings) {
        const context = [
          account,
          signalSlot === undefined ? undefined : `signal ${signalSlot}`,
          orderSlot === undefined ? undefined : `order ${orderSlot}`,
          deltaMs === undefined ? undefined : `${deltaMs} ms`,
        ].filter((part) => part !== undefined)
        lines.push(`- ${level}: \`${code}\`${context.length === 0 ? '' : ` (${context.join(', ')})`}`)
      }
      if (metrics === null) continue
      const { cut, signals, orders, fills, feeBps, pdt, byOrder } = metrics
      lines.push(
        '',
        `Regular session: ${cut.openAt} to ${cut.closeAt}; evidence through ${cut.asOf}.`,
        '',
        `- Signals (live / paper / matched): ${signals.live} / ${signals.paper} / ${signals.matched}; max absolute drift: ${signals.maxAbsDeltaMs ?? '—'} ms`,
        `- Orders (live / paper / comparable): ${orders.live} / ${orders.paper} / ${orders.comparable}`,
        `- Fill rows (live / paper): ${fills.live} / ${fills.paper}; comparable filled orders: ${fills.comparableFilledOrders}`,
        `- Fee rate (bps, live / paper / delta): ${cell(feeBps)}`,
        `- PDT day trades (live / paper / delta): ${cell(pdt)}`,
      )
      if (byOrder.length === 0) continue
      lines.push(
        '',
        'Order metrics in bps (live / paper / delta):',
        '',
        '| Order slot | Order weight | Fill weight | Filled fraction | Adverse slippage | Fee rate |',
        '| --- | --- | --- | --- | --- | --- |',
      )
      for (const order of byOrder)
        lines.push(
          `| ${order.slot} | ${cell(order.orderWeightBps)} | ${cell(order.fillWeightBps)} | ${cell(order.filledFractionBps)} | ${cell(order.slippageBps)} | ${cell(order.feeBps)} |`,
        )
    }
  }
  return lines.join('\n')
}
