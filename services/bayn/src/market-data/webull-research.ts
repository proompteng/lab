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

export class WebullResearchError extends Data.TaggedError('WebullResearchError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export enum WebullSession {
  Pre = 'PRE',
  Regular = 'RTH',
  After = 'ATH',
}
export enum WebullRequestState {
  Observed = 'OBSERVED',
  Empty = 'EMPTY',
  Excluded = 'EXCLUDED',
  Omitted = 'OMITTED',
  Rejected = 'REJECTED',
}
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
const SymbolSchema = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((value) => value.trim().length > 0 && !/\p{Cc}/u.test(value), {
    expected: 'a provider symbol without control characters',
  }),
)
export const WebullResearchInputSchema = Schema.Struct({
  startAt: UtcInstantSchema.check(
    Schema.makeFilter((value) => Date.parse(value) % 60_000 === 0, { expected: 'a completed-minute boundary' }),
  ),
  durationMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 360 })),
  selection: Schema.Union([
    Schema.Struct({ kind: Schema.Literal(SelectionKind.Catalog) }),
    Schema.Struct({
      kind: Schema.Literal(SelectionKind.Symbols),
      symbols: Schema.Array(SymbolSchema).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(1_000),
        Schema.makeFilter((values) => new Set(values).size === values.length, { expected: 'unique symbols' }),
      ),
    }),
  ]),
})
export type WebullResearchInput = typeof WebullResearchInputSchema.Type

const DecimalSchema = Schema.String.check(
  Schema.isPattern(/^\+?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/),
  Schema.isMaxLength(128),
  Schema.makeFilter(
    (value) => {
      const parsed = BigDecimal.fromString(value)
      return Option.isSome(parsed) && Math.abs(parsed.value.scale) <= 128
    },
    { expected: 'an exact decimal with scale at most 128' },
  ),
)
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
const PriceSchema = DecimalSchema.check(
  Schema.makeFilter(
    (value) => {
      const parsed = BigDecimal.fromString(value)
      return Option.isSome(parsed) && BigDecimal.isPositive(parsed.value)
    },
    { expected: 'a positive price' },
  ),
)
const priceFields = {
  open: PriceSchema,
  high: PriceSchema,
  low: PriceSchema,
  close: PriceSchema,
  volume: DecimalSchema,
}
export const WebullResearchBarSchema = Schema.Struct({
  provider: Schema.Literal('webull'),
  feed: Schema.Literal('nasdaq_basic'),
  symbol: SymbolSchema,
  bar_start_ms: MillisecondsSchema,
  session: Schema.Enum(WebullSession),
  ...priceFields,
  ...provenanceFields,
  archived_ns: UnsignedMicrosSchema,
  capture_id: Schema.String.check(Schema.isUUID()),
  payload_sha256: Sha256Schema,
  capture_observations: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
})
export type WebullResearchBar = typeof WebullResearchBarSchema.Type
export const WebullResearchRequestSchema = Schema.Struct({
  provider: Schema.Literal('webull'),
  feed: Schema.Literal('nasdaq_basic'),
  symbol: SymbolSchema,
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
  symbol: SymbolSchema,
  bar_start_ms: MillisecondsSchema,
  ...priceFields,
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

const priceKeys = ['open', 'high', 'low', 'close', 'volume'] as const
const equalDecimal = (left: string, right: string) => {
  const a = BigDecimal.fromString(left)
  const b = BigDecimal.fromString(right)
  return Option.isSome(a) && Option.isSome(b) && BigDecimal.equals(a.value, b.value)
}
const key = (bar: Pick<WebullResearchBar, 'symbol' | 'bar_start_ms'>) => `${bar.symbol}/${bar.bar_start_ms}`

/** Current retained evidence with a collector-receipt cutoff, never a trading snapshot or historical availability proof. */
export const makeWebullResearchReport = (input: WebullResearchInput, rows: WebullResearchRows) => {
  const endMs = webullResearchEndMs(input)
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
  const coverage = symbols.map((symbol) => {
    const bar = latest.get(symbol)
    const request = requests.get(symbol)
    return {
      symbol,
      requestState: request?.request_state ?? 'NO_CAPTURED_REQUEST',
      latestRequest: request ?? null,
      latestBarStartAt: bar === undefined ? null : new Date(bar.bar_start_ms).toISOString(),
      barAgeSeconds: bar === undefined ? null : (endMs - bar.bar_start_ms) / 1_000,
      fresh: bar !== undefined && endMs - bar.bar_start_ms <= 360_000,
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
    schemaVersion: 'bayn.webull-research.v1',
    qualification: 'UNQUALIFIED',
    intervalSeconds: 60,
    input,
    endAt: new Date(endMs).toISOString(),
    availabilityBasis: 'Collector receipt cutoff in the current retained archive; not historical Bayn availability',
    feedComparisonBasis:
      'Webull Nasdaq Basic decimal strings versus Alpaca IEX archived Float64 values; venue coverage differs',
    catalogBasis:
      'Symbols present in captured requests; this is not an assertion that every listed symbol is supported',
    freshBarStartBudgetSeconds: 360,
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
    },
  }
  return Result.map(canonicalHashV1Result(report), (reportHash) => ({ ...report, reportHash }))
}

export const readWebullResearch = (input: WebullResearchInput) =>
  Effect.gen(function* () {
    if (webullResearchEndMs(input) > (yield* Clock.currentTimeMillis))
      return yield* new WebullResearchError({ message: 'Research window ends in the future' })
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
