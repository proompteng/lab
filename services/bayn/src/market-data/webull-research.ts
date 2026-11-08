import { ClickhouseClient } from '@effect/sql-clickhouse'
import { BigDecimal, Clock, Data, Effect, Option, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import {
  NonNegativeIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  UnsignedMicrosSchema,
  strictParseOptions,
} from '../schemas'
import { makeWebullResearchQueries } from './webull-research-queries'
import { WebullRequestState, WebullSession, WebullSymbolSchema, webullPriceFields } from './webull-contract'
import { webullMaximumAvailabilityLagMs } from './streaming/webull-projection'

export class WebullResearchError extends Data.TaggedError('WebullResearchError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

enum FeedComparisonState {
  Match = 'MATCH',
  Different = 'DIFFERENT',
  WebullOnly = 'WEBULL_ONLY',
  AlpacaOnly = 'ALPACA_ONLY',
}
enum SelectionKind {
  Catalog = 'catalog',
  Symbols = 'symbols',
}
export const WebullResearchInputSchema = Schema.Struct({
  startAt: UtcInstantSchema.check(
    Schema.makeFilter((value) => Date.parse(value) % 60_000 === 0, { expected: 'a completed-minute boundary' }),
  ),
  durationMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 360 })),
  evidenceAsOf: Schema.optionalKey(UtcInstantSchema),
  selection: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(SelectionKind.Catalog) }),
    Schema.Struct({
      kind: Schema.Literal(SelectionKind.Symbols),
      symbols: Schema.Array(WebullSymbolSchema).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(1_000),
        Schema.makeFilter((values) => new Set(values).size === values.length, { expected: 'unique symbols' }),
      ),
    }),
  ]),
}).check(
  Schema.makeFilter(
    (input) => {
      if (input.evidenceAsOf === undefined) return true
      const end = Date.parse(input.startAt) + input.durationMinutes * 60_000
      const cutoff = Date.parse(input.evidenceAsOf)
      return cutoff >= end && cutoff <= end + 360_000
    },
    { expected: 'a collector evidence cutoff from window end through six minutes after it' },
  ),
)
export type WebullResearchInput = typeof WebullResearchInputSchema.Type

const MillisecondsSchema = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }),
  Schema.makeFilter((value) => value % 60_000 === 0, { expected: 'an aligned M1 start' }),
)
const provenanceFields = {
  received_ns: UnsignedMicrosSchema,
  source_topic: StrictNonEmptyStringSchema,
  source_partition: NonNegativeIntegerSchema,
  source_offset: UnsignedMicrosSchema,
}
export const WebullResearchBarSchema = Schema.Struct({
  provider: Schema.Literal('webull'),
  feed: Schema.Literal('nasdaq_basic'),
  symbol: WebullSymbolSchema,
  bar_start_ms: MillisecondsSchema,
  session: Schema.Enum(WebullSession),
  ...webullPriceFields,
  ...provenanceFields,
  archived_ns: UnsignedMicrosSchema,
  capture_id: Schema.String.check(Schema.isUUID()),
  payload_sha256: Sha256Schema,
  first_received_ns: UnsignedMicrosSchema,
  first_capture_id: Schema.String.check(Schema.isUUID()),
  first_source_topic: StrictNonEmptyStringSchema,
  first_source_partition: NonNegativeIntegerSchema,
  first_source_offset: UnsignedMicrosSchema,
  first_payload_sha256: Sha256Schema,
  capture_observations: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
}).check(
  Schema.makeFilter(
    (bar) =>
      BigInt(bar.first_received_ns) >= BigInt(bar.bar_start_ms + 60_000) * 1_000_000n &&
      BigInt(bar.first_received_ns) <= BigInt(bar.received_ns),
    { expected: 'first collector receipt after minute completion and no later than the latest receipt' },
  ),
)
export type WebullResearchBar = typeof WebullResearchBarSchema.Type
export const WebullResearchRequestSchema = Schema.Struct({
  provider: Schema.Literal('webull'),
  feed: Schema.Literal('nasdaq_basic'),
  symbol: WebullSymbolSchema,
  request_state: Schema.Enum(WebullRequestState),
  observed_count: NonNegativeIntegerSchema,
  excluded_count: NonNegativeIntegerSchema,
  ...provenanceFields,
  payload_sha256: Sha256Schema,
})
export type WebullResearchRequest = typeof WebullResearchRequestSchema.Type
export const WebullResearchGapSchema = Schema.Struct({
  affected_channel: Schema.String,
  reason: Schema.String,
  error_class: Schema.String,
  from_time: Schema.String,
  to_time: Schema.String,
  ...provenanceFields,
  payload_sha256: Sha256Schema,
})
export type WebullResearchGap = typeof WebullResearchGapSchema.Type
export const AlpacaResearchBarSchema = Schema.Struct({
  provider: Schema.Literal('alpaca'),
  feed: Schema.Literal('iex'),
  universe_id: Schema.Literal('torghut-core-equity-v2'),
  session: Schema.String,
  symbol: WebullSymbolSchema,
  bar_start_ms: MillisecondsSchema,
  ...webullPriceFields,
  ...provenanceFields,
})
export type AlpacaResearchBar = typeof AlpacaResearchBarSchema.Type
export interface WebullResearchRows {
  readonly bars: readonly WebullResearchBar[]
  readonly requests: readonly WebullResearchRequest[]
  readonly gaps: readonly WebullResearchGap[]
  readonly alpaca: readonly AlpacaResearchBar[]
}

export const webullResearchRowLimit = 100_000
export const webullResearchEndMs = (input: WebullResearchInput) =>
  Date.parse(input.startAt) + input.durationMinutes * 60_000
export const webullResearchEvidenceMs = (input: WebullResearchInput) =>
  input.evidenceAsOf === undefined ? webullResearchEndMs(input) : Date.parse(input.evidenceAsOf)

const priceKeys = ['open', 'high', 'low', 'close', 'volume'] as const
const equalDecimal = (left: string, right: string) => {
  const a = BigDecimal.fromString(left)
  const b = BigDecimal.fromString(right)
  return Option.isSome(a) && Option.isSome(b) && BigDecimal.equals(a.value, b.value)
}
const key = (bar: Pick<WebullResearchBar, 'symbol' | 'bar_start_ms'>) => `${bar.symbol}/${bar.bar_start_ms}`
const collectorLagNs = (bar: WebullResearchBar) =>
  BigInt(bar.first_received_ns) - BigInt(bar.bar_start_ms + 60_000) * 1_000_000n
const collectorLagMs = (bar: WebullResearchBar) => Number(collectorLagNs(bar)) / 1_000_000
const timelyCollectorReceipt = (bar: WebullResearchBar) =>
  collectorLagNs(bar) <= BigInt(webullMaximumAvailabilityLagMs) * 1_000_000n

/** Current retained evidence with a collector-receipt cutoff, never a trading snapshot or historical availability proof. */
export const makeWebullResearchReport = (input: WebullResearchInput, rows: WebullResearchRows) => {
  const endMs = webullResearchEndMs(input)
  const evidenceMs = webullResearchEvidenceMs(input)
  const eligibleMinuteSlots = Math.max(
    0,
    Math.min(
      input.durationMinutes,
      Math.floor((evidenceMs - webullMaximumAvailabilityLagMs - Date.parse(input.startAt)) / 60_000),
    ),
  )
  const issues: string[] = []
  const seen = new Set<string>()
  for (const bar of rows.bars) {
    const identity = key(bar)
    if (seen.has(identity)) issues.push(`Conflicting Webull session or duplicate canonical minute: ${identity}`)
    seen.add(identity)
  }
  const referenceSeen = new Set<string>()
  for (const bar of rows.alpaca) {
    const identity = key(bar)
    if (referenceSeen.has(identity))
      issues.push(`Conflicting Alpaca session or duplicate canonical minute: ${identity}`)
    referenceSeen.add(identity)
  }
  for (const [name, data] of Object.entries(rows))
    if (data.length > webullResearchRowLimit) issues.push(`${name} exceeded the ${webullResearchRowLimit} row limit`)
  const symbols =
    input.selection.kind === SelectionKind.Symbols
      ? input.selection.symbols
      : [...new Set([...rows.requests.map((row) => row.symbol), ...rows.bars.map((row) => row.symbol)])].sort()
  const latest = new Map<string, WebullResearchBar>()
  for (const bar of rows.bars) {
    const previous = latest.get(bar.symbol)
    if (previous === undefined || bar.bar_start_ms > previous.bar_start_ms) latest.set(bar.symbol, bar)
  }
  const requests = new Map(rows.requests.map((row) => [row.symbol, row]))
  const selectedSymbols = new Set(symbols)
  const minuteGroups = new Map<string, WebullResearchBar[]>()
  const startMs = Date.parse(input.startAt)
  for (const bar of rows.bars) {
    if (!selectedSymbols.has(bar.symbol) || bar.bar_start_ms < startMs || bar.bar_start_ms + 60_000 > endMs) {
      issues.push(`Webull minute outside the requested coverage window: ${key(bar)}`)
      continue
    }
    const group = minuteGroups.get(key(bar)) ?? []
    group.push(bar)
    minuteGroups.set(key(bar), group)
  }
  const timingBySymbol = new Map(
    symbols.map((symbol) => [symbol, { observedMinutes: 0, timelyMinutes: 0, lateMinutes: 0, conflictingMinutes: 0 }]),
  )
  for (const group of minuteGroups.values()) {
    const bar = group[0]
    if (bar === undefined) continue
    if (bar.bar_start_ms + 60_000 + webullMaximumAvailabilityLagMs > evidenceMs) continue
    const timing = timingBySymbol.get(bar.symbol)
    if (timing === undefined) continue
    if (group.length > 1) timing.conflictingMinutes++
    else {
      timing.observedMinutes++
      if (timelyCollectorReceipt(bar)) timing.timelyMinutes++
      else timing.lateMinutes++
    }
  }
  const coverage = symbols.map((symbol) => {
    const bar = latest.get(symbol)
    const request = requests.get(symbol)
    const timing = timingBySymbol.get(symbol) ?? {
      observedMinutes: 0,
      timelyMinutes: 0,
      lateMinutes: 0,
      conflictingMinutes: 0,
    }
    return {
      symbol,
      requestState: request?.request_state ?? 'NO_CAPTURED_REQUEST',
      latestRequest: request ?? null,
      latestBarStartAt: bar === undefined ? null : new Date(bar.bar_start_ms).toISOString(),
      barAgeSeconds: bar === undefined ? null : (endMs - bar.bar_start_ms) / 1_000,
      fresh: bar !== undefined && endMs - bar.bar_start_ms <= 360_000,
      collectorTiming: {
        requestedMinuteSlots: input.durationMinutes,
        eligibleMinuteSlots,
        pendingMinutes: input.durationMinutes - eligibleMinuteSlots,
        ...timing,
        missingMinutes: eligibleMinuteSlots - timing.observedMinutes - timing.conflictingMinutes,
        latestFirstReceiptLagMs:
          bar === undefined || minuteGroups.get(key(bar))?.length !== 1 ? null : collectorLagMs(bar),
      },
    }
  })
  if (symbols.length === 0) issues.push('No captured catalog requests or completed bars in the window')
  if (coverage.some((row) => row.requestState === 'NO_CAPTURED_REQUEST'))
    issues.push('Requested symbols lack capture evidence')
  if (
    coverage.some(
      (row) => row.requestState === WebullRequestState.Omitted || row.requestState === WebullRequestState.Rejected,
    )
  )
    issues.push('Latest requests include provider omissions or rejected payloads')
  const alpaca = new Map(rows.alpaca.map((bar) => [key(bar), bar]))
  const webull = new Map(rows.bars.map((bar) => [key(bar), bar]))
  const comparison = [...new Set([...webull.keys(), ...alpaca.keys()])].sort().map((identity) => {
    const a = webull.get(identity)
    const b = alpaca.get(identity)
    const differingFields =
      a === undefined || b === undefined ? [] : priceKeys.filter((field) => !equalDecimal(a[field], b[field]))
    return {
      minute: identity,
      status:
        a === undefined
          ? FeedComparisonState.AlpacaOnly
          : b === undefined
            ? FeedComparisonState.WebullOnly
            : differingFields.length === 0
              ? FeedComparisonState.Match
              : FeedComparisonState.Different,
      differingFields,
      webull: a ?? null,
      alpaca: b ?? null,
    }
  })
  const report = {
    schemaVersion: 'bayn.webull-research.v2',
    qualification: 'UNQUALIFIED',
    intervalSeconds: 60,
    input,
    endAt: new Date(endMs).toISOString(),
    evidenceAsOf: new Date(evidenceMs).toISOString(),
    availabilityBasis: 'Collector receipt cutoff in the current retained archive; not historical Bayn availability',
    feedComparisonBasis:
      'Webull Nasdaq Basic decimal strings versus Alpaca IEX archived Float64 values; venue coverage differs',
    catalogBasis:
      'Symbols present in captured requests; this is not an assertion that every listed symbol is supported',
    freshBarStartBudgetSeconds: 360,
    collectorTimingBasis:
      'Earliest valid archived collector receipt for each requested symbol/minute, across revisions; not Bayn consumer availability or trading eligibility',
    collectorTimingBudgetMs: webullMaximumAvailabilityLagMs,
    collectorTimingDenominator:
      'Eligible requested symbol/minute slots whose ten-second budget has closed by evidenceAsOf; remaining slots are pending, not missing. No market-calendar or trade-activity assumption',
    issues,
    coverage,
    bars: rows.bars,
    gaps: rows.gaps,
    comparison,
    summary: {
      symbols: symbols.length,
      completedBars: rows.bars.length,
      freshSymbols: coverage.filter((row) => row.fresh).length,
      repeatedBarObservations: rows.bars
        .reduce((total, bar) => total + BigInt(bar.capture_observations) - 1n, 0n)
        .toString(),
      gapEvents: rows.gaps.length,
      matchedMinutes: comparison.filter((row) => row.webull !== null && row.alpaca !== null).length,
      differingMinutes: comparison.filter((row) => row.status === FeedComparisonState.Different).length,
      collectorTiming: coverage.reduce(
        (total, row) => ({
          requestedMinuteSlots: total.requestedMinuteSlots + row.collectorTiming.requestedMinuteSlots,
          eligibleMinuteSlots: total.eligibleMinuteSlots + row.collectorTiming.eligibleMinuteSlots,
          pendingMinutes: total.pendingMinutes + row.collectorTiming.pendingMinutes,
          observedMinutes: total.observedMinutes + row.collectorTiming.observedMinutes,
          timelyMinutes: total.timelyMinutes + row.collectorTiming.timelyMinutes,
          lateMinutes: total.lateMinutes + row.collectorTiming.lateMinutes,
          missingMinutes: total.missingMinutes + row.collectorTiming.missingMinutes,
          conflictingMinutes: total.conflictingMinutes + row.collectorTiming.conflictingMinutes,
        }),
        {
          requestedMinuteSlots: 0,
          eligibleMinuteSlots: 0,
          pendingMinutes: 0,
          observedMinutes: 0,
          timelyMinutes: 0,
          lateMinutes: 0,
          missingMinutes: 0,
          conflictingMinutes: 0,
        },
      ),
    },
  }
  return Result.map(canonicalHashV1Result(report), (reportHash) => ({ ...report, reportHash }))
}

export const readWebullResearch = (input: WebullResearchInput) =>
  Effect.gen(function* () {
    if (webullResearchEvidenceMs(input) > (yield* Clock.currentTimeMillis))
      return yield* new WebullResearchError({ message: 'Research evidence cutoff is in the future' })
    const sql = yield* ClickhouseClient.ClickhouseClient
    const queries = makeWebullResearchQueries(sql, input)
    const decode = <A, I>(schema: Schema.Codec<A, I>) =>
      Schema.decodeUnknownEffect(Schema.Array(schema), strictParseOptions)
    const bars = yield* queries.bars.pipe(Effect.flatMap(decode(WebullResearchBarSchema)))
    const requests = yield* queries.requests.pipe(Effect.flatMap(decode(WebullResearchRequestSchema)))
    const gaps = yield* queries.gaps.pipe(Effect.flatMap(decode(WebullResearchGapSchema)))
    const alpaca = yield* queries.alpaca.pipe(Effect.flatMap(decode(AlpacaResearchBarSchema)))
    const rows = { bars, requests, gaps, alpaca }
    if (Object.values(rows).some((values) => values.length > webullResearchRowLimit))
      return yield* new WebullResearchError({
        message: `Research query exceeds ${webullResearchRowLimit} rows; narrow the window`,
      })
    return yield* Effect.fromResult(makeWebullResearchReport(input, rows))
  }).pipe(
    Effect.timeout('60 seconds'),
    Effect.mapError((cause) =>
      cause instanceof WebullResearchError
        ? cause
        : new WebullResearchError({ message: 'Webull research read failed', cause }),
    ),
  )
