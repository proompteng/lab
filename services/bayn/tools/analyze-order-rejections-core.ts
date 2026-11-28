import { Data, Redacted, Result, Schema } from 'effect'

import { OrderSide, TerminalOutcome } from '../src/execution/contracts'
import { compareIntradayInstants, intradayAgeNanos, millisecondsAsNanos } from '../src/market-data/intraday/time'
import { quantityScale } from '../src/quantity'
import {
  PositiveIntegerSchema,
  PositiveMicrosSchema,
  strictParseOptions,
  SymbolSchema,
  UnsignedMicrosSchema,
  UtcSourceTimestampSchema,
} from '../src/schemas'

enum RejectionCause {
  CollarMiss = 'COLLAR_MISS',
  PdtBlock = 'PDT_BLOCK',
  BuyingPower = 'BUYING_POWER',
  WashTradeGuard = 'WASH_TRADE_GUARD',
  StaleQuote = 'STALE_QUOTE',
  MarketHalt = 'MARKET_HALT',
  BrokerError = 'BROKER_ERROR',
}

enum AccountTier {
  Cash = 'CASH',
  Margin = 'MARGIN',
  PortfolioMargin = 'PORTFOLIO_MARGIN',
}

enum TimeBucket {
  BeforeOpen = '0000_0930',
  Open = '0930_1000',
  Midday = '1000_1530',
  Late = '1530_1600',
  AfterHours = '1600_2400',
}

export enum TriageSeverity {
  Ok = 'OK',
  Warning = 'WARNING',
  Critical = 'CRITICAL',
}

enum SeverityReason {
  PdtBlock = RejectionCause.PdtBlock,
  CriticalRate = 'CRITICAL_RATE',
  WarningRate = 'WARNING_RATE',
  MissingMarkout = 'MISSING_MARKOUT',
  BelowThresholds = 'BELOW_THRESHOLDS',
}

const Positive = PositiveMicrosSchema.check(Schema.isMaxLength(39))
const Attempt = Schema.Struct({
  attemptId: PositiveIntegerSchema,
  attemptedAt: UtcSourceTimestampSchema,
  terminalAt: UtcSourceTimestampSchema,
  symbol: SymbolSchema,
  accountTier: Schema.Enum(AccountTier),
  side: Schema.Enum(OrderSide),
  outcome: Schema.Enum(TerminalOutcome),
  quantityAtoms: Positive,
  filledQuantityAtoms: UnsignedMicrosSchema.check(Schema.isMaxLength(39)),
  valuationPriceMicros: Positive,
  reason: Schema.optionalKey(
    Schema.Enum(RejectionCause).pipe(
      Schema.refine((reason) => reason !== RejectionCause.CollarMiss, { expected: 'an explicit non-collar cause' }),
    ),
  ),
  collarQuote: Schema.optionalKey(
    Schema.Struct({
      at: UtcSourceTimestampSchema,
      limitPriceMicros: Positive,
      bidPriceMicros: Positive,
      askPriceMicros: Positive,
    }),
  ),
  markout: Schema.optionalKey(
    Schema.Struct({
      referencePriceMicros: Positive,
      barStartAt: UtcSourceTimestampSchema,
      barCloseMicros: Positive,
    }),
  ),
})
type Attempt = typeof Attempt.Type

const decodeFixture = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      schemaVersion: Schema.Literal('bayn.order-rejection-evidence.v1'),
      asOf: UtcSourceTimestampSchema,
      attempts: Schema.NonEmptyArray(Attempt),
    }),
  ),
  strictParseOptions,
)

class OrderRejectionEvidenceError extends Data.TaggedError('OrderRejectionEvidenceError')<{
  readonly message: string
  readonly cause: Redacted.Redacted<unknown>
  readonly row?: number
}> {}

const timeZone = 'America/New_York'
const easternClock = new Intl.DateTimeFormat('en-GB', {
  timeZone,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const minuteMs = 60_000

const bucketAt = (at: string): TimeBucket => {
  const clock = easternClock.format(Date.parse(at))
  if (clock < '09:30') return TimeBucket.BeforeOpen
  if (clock < '10:00') return TimeBucket.Open
  if (clock < '15:30') return TimeBucket.Midday
  if (clock < '16:00') return TimeBucket.Late
  return TimeBucket.AfterHours
}

interface Miss {
  readonly cause: RejectionCause
  readonly notional: bigint
  readonly markout: { readonly referenceNotional: bigint; readonly move: bigint } | null
}

const wasCollarMiss = (attempt: Attempt, filled: bigint, quote: NonNullable<Attempt['collarQuote']>): boolean => {
  if (filled !== 0n || (attempt.outcome !== TerminalOutcome.Canceled && attempt.outcome !== TerminalOutcome.Expired))
    return false
  const age = intradayAgeNanos(attempt.attemptedAt, quote.at)
  if (age < 0n || age > millisecondsAsNanos(1_000)) return false
  const bid = BigInt(quote.bidPriceMicros)
  const ask = BigInt(quote.askPriceMicros)
  const limit = BigInt(quote.limitPriceMicros)
  return bid <= ask && (attempt.side === OrderSide.Buy ? ask > limit : bid < limit)
}

const classify = (
  attempt: Attempt,
  asOf: string,
  row: number,
): Result.Result<Miss | null, OrderRejectionEvidenceError> => {
  const invalid = (message: string) =>
    Result.fail(new OrderRejectionEvidenceError({ message, row, cause: Redacted.make(attempt) }))
  if (
    compareIntradayInstants(attempt.terminalAt, asOf) > 0 ||
    compareIntradayInstants(attempt.terminalAt, attempt.attemptedAt) < 0
  )
    return invalid('Terminal time must be between the attempt and the evidence cut.')

  const filled = BigInt(attempt.filledQuantityAtoms)
  const remaining = BigInt(attempt.quantityAtoms) - filled
  if (attempt.outcome === TerminalOutcome.Filled) {
    if (
      remaining !== 0n ||
      attempt.reason !== undefined ||
      attempt.collarQuote !== undefined ||
      attempt.markout !== undefined
    )
      return invalid('Filled attempts require a full fill and no rejection evidence.')
    return Result.succeed(null)
  }
  if (
    remaining <= 0n ||
    (filled > 0n && (attempt.outcome === TerminalOutcome.Blocked || attempt.outcome === TerminalOutcome.Rejected))
  )
    return invalid('The filled quantity contradicts the terminal outcome.')

  let cause: RejectionCause | undefined = attempt.reason
  if (attempt.collarQuote !== undefined) {
    if (cause !== undefined || !wasCollarMiss(attempt, filled, attempt.collarQuote))
      return invalid(
        'A collar miss requires a zero-fill cancel or expiry and a fresh outside-limit quote as its only cause evidence.',
      )
    cause = RejectionCause.CollarMiss
  }
  if (cause === undefined) return invalid('A non-filled attempt has no supported, observed cause.')

  const notional = remaining * BigInt(attempt.valuationPriceMicros)
  if (attempt.markout === undefined) return Result.succeed({ cause, notional, markout: null })

  const { barStartAt, barCloseMicros, referencePriceMicros } = attempt.markout
  const nextMinute = (Math.floor(Date.parse(attempt.attemptedAt) / minuteMs) + 1) * minuteMs
  if (
    compareIntradayInstants(barStartAt, new Date(nextMinute).toISOString()) !== 0 ||
    nextMinute + minuteMs > Date.parse(asOf)
  )
    return invalid('Markout requires the next full one-minute bar, completed by the evidence cut.')
  const reference = BigInt(referencePriceMicros)
  const direction = attempt.side === OrderSide.Buy ? 1n : -1n
  return Result.succeed({
    cause,
    notional,
    markout: {
      referenceNotional: remaining * reference,
      move: remaining * (BigInt(barCloseMicros) - reference) * direction,
    },
  })
}

const round = (value: number) => Number(value.toFixed(4))
const compareKeys = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const summarizeMetrics = (attempts: number, misses: readonly Miss[]) => {
  let notional = 0n
  let markedMisses = 0
  let referenceNotional = 0n
  let missedMove = 0n
  let adverseMove = 0n
  for (const miss of misses) {
    notional += miss.notional
    if (miss.markout === null) continue
    markedMisses++
    referenceNotional += miss.markout.referenceNotional
    if (miss.markout.move > 0n) missedMove += miss.markout.move
    else adverseMove -= miss.markout.move
  }
  const bps = (move: bigint) =>
    referenceNotional === 0n ? null : round((10_000 * Number(move)) / Number(referenceNotional))
  return {
    attempts,
    missedAttempts: misses.length,
    rejectionRatePct: round((100 * misses.length) / attempts),
    missedNotionalMicros: (notional / quantityScale).toString(),
    markedMisses,
    missedBps: bps(missedMove),
    adverseBps: bps(adverseMove),
  }
}

const summarizeScope = (attempts: number, misses: readonly Miss[]) => ({
  ...summarizeMetrics(attempts, misses),
  byCause: Array.from(Map.groupBy(misses, ({ cause }) => cause))
    .sort(([a], [b]) => compareKeys(a, b))
    .map(([cause, rows]) => ({ cause, ...summarizeMetrics(attempts, rows) })),
})

const rateThresholdsPct = { warning: 5, critical: 10 } as const

const triage = ({ attempts, missedAttempts, markedMisses, byCause }: ReturnType<typeof summarizeScope>) => {
  if (byCause.some(({ cause }) => cause === RejectionCause.PdtBlock))
    return { severity: TriageSeverity.Critical, severityReason: SeverityReason.PdtBlock }
  const numerator = 100 * missedAttempts
  if (numerator >= rateThresholdsPct.critical * attempts)
    return { severity: TriageSeverity.Critical, severityReason: SeverityReason.CriticalRate }
  if (numerator >= rateThresholdsPct.warning * attempts)
    return { severity: TriageSeverity.Warning, severityReason: SeverityReason.WarningRate }
  if (markedMisses < missedAttempts)
    return { severity: TriageSeverity.Warning, severityReason: SeverityReason.MissingMarkout }
  return { severity: TriageSeverity.Ok, severityReason: SeverityReason.BelowThresholds }
}

interface Cohort {
  readonly symbol: string
  readonly timeBucket: TimeBucket
  readonly accountTier: AccountTier
  attempts: number
  readonly misses: Miss[]
}

export const analyzeOrderRejections = (json: string) =>
  Result.gen(function* () {
    const { asOf, attempts } = yield* decodeFixture(json).pipe(
      Result.mapError(
        (cause) =>
          new OrderRejectionEvidenceError({
            message: 'Invalid normalized rejection evidence JSON.',
            cause: Redacted.make(cause),
          }),
      ),
    )
    const seen = new Set<number>()
    const cohorts = new Map<string, Cohort>()
    const misses: Miss[] = []
    for (const [index, attempt] of attempts.entries()) {
      const row = index + 1
      if (seen.has(attempt.attemptId))
        return yield* Result.fail(
          new OrderRejectionEvidenceError({
            message: 'Duplicate attempt identity.',
            row,
            cause: Redacted.make(attempt.attemptId),
          }),
        )
      seen.add(attempt.attemptId)
      const miss = yield* classify(attempt, asOf, row)
      const { symbol, accountTier } = attempt
      const timeBucket = bucketAt(attempt.attemptedAt)
      const key = `${symbol}:${timeBucket}:${accountTier}`
      let cohort = cohorts.get(key)
      if (cohort === undefined) {
        cohort = { symbol, accountTier, timeBucket, attempts: 0, misses: [] }
        cohorts.set(key, cohort)
      }
      cohort.attempts++
      if (miss === null) continue
      cohort.misses.push(miss)
      misses.push(miss)
    }

    const overall = summarizeScope(attempts.length, misses)
    return {
      schemaVersion: 'bayn.order-rejection-report.v1' as const,
      asOf,
      timeZone,
      ...triage(overall),
      rateThresholdsPct,
      overall,
      cohorts: Array.from(cohorts)
        .sort(([a], [b]) => compareKeys(a, b))
        .map(([, { symbol, timeBucket, accountTier, attempts, misses }]) => ({
          symbol,
          timeBucket,
          accountTier,
          ...summarizeScope(attempts, misses),
        })),
    }
  })

type Report = Result.Result.Success<ReturnType<typeof analyzeOrderRejections>>

export const renderOrderRejectionJson = (report: Report): string => JSON.stringify(report, null, 2)

const metricCells = (row: ReturnType<typeof summarizeMetrics>): string => {
  const micros = row.missedNotionalMicros.padStart(7, '0')
  const money = `$${micros.slice(0, -6)}.${micros.slice(-6)}`
  return `${row.attempts} | ${row.missedAttempts} | ${row.rejectionRatePct}% | ${money} | ${row.markedMisses} | ${row.missedBps ?? '—'} | ${row.adverseBps ?? '—'}`
}

export const renderOrderRejectionMarkdown = (report: Report): string => {
  const rows = (scope: Report['overall'], label: string) => [
    `| ${label} | — | ${metricCells(scope)} |`,
    ...scope.byCause.map((row) => `| ${label} | ${row.cause} | ${metricCells(row)} |`),
  ]
  return [
    '# Bayn order rejection triage',
    '',
    `Evidence cut: ${report.asOf} · Time zone: ${report.timeZone}`,
    `Severity: **${report.severity}** (${report.severityReason})`,
    `Overall rate thresholds: warning ≥${report.rateThresholdsPct.warning}%, critical ≥${report.rateThresholdsPct.critical}%.`,
    '',
    '| Symbol | ET bucket | Tier | Cause | Attempts | Misses | Rejection rate | Missed notional (USD) | Marked misses | Missed bps | Adverse bps |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows(report.overall, 'All | — | —'),
    ...report.cohorts.flatMap((scope) => rows(scope, `${scope.symbol} | ${scope.timeBucket} | ${scope.accountTier}`)),
    '',
    'Markout is weighted by the unfilled reference notional of marked misses only. It is not realized P&L.',
  ].join('\n')
}
