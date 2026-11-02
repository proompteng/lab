import { DateTime, Result, Schema } from 'effect'

import { MarketCalendarResponseSchema } from '../broker/alpaca/model'
import { canonicalHashV1Result, sha256 } from '../hash'
import {
  IsoDateSchema,
  Sha256Schema,
  SymbolSchema,
  UtcInstantSchema,
  UtcSourceTimestampSchema,
  StrictNonEmptyStringSchema,
  strictParseOptions,
} from '../schemas'
import {
  EquityScreenError,
  indexEquityScreenBars,
  type EquityScreenBar,
  type EquityScreenDay,
} from './equity-edge-screen'

const Period = Schema.Struct({ start: IsoDateSchema, end: IsoDateSchema })
export enum EquityHistoricalFeed {
  Iex = 'iex',
  Sip = 'sip',
}
export const EquityEdgeInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.equity-edge-screen-input.v2'),
  sourceSha256: Sha256Schema,
  calendar: Schema.Struct({ start: IsoDateSchema, end: IsoDateSchema, expectedHash: Sha256Schema }),
  feed: Schema.optionalKey(Schema.Enum(EquityHistoricalFeed)),
  symbols: Schema.Array(SymbolSchema),
  development: Period,
  validation: Period,
  holdout: Period,
})

const Positive = Schema.Finite.check(Schema.isGreaterThan(0))
const Nonnegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const Bar = Schema.Struct({
  t: UtcSourceTimestampSchema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.0{1,9})?Z$/)),
  o: Positive,
  h: Positive,
  l: Positive,
  c: Positive,
  v: Nonnegative,
  vw: Positive,
})
const Header = Schema.Struct({
  kind: Schema.Literal('calendar'),
  requestUrl: StrictNonEmptyStringSchema,
  observedAt: UtcInstantSchema,
  data: MarketCalendarResponseSchema,
})
const Page = Schema.Struct({
  kind: Schema.Literal('bars'),
  requestUrl: StrictNonEmptyStringSchema,
  page: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  requestPageToken: Schema.NullOr(StrictNonEmptyStringSchema),
  observedAt: UtcInstantSchema,
  data: Schema.Struct({
    bars: Schema.Record(Schema.String, Schema.Array(Bar)),
    next_page_token: Schema.NullOr(StrictNonEmptyStringSchema),
  }),
})
const End = Schema.Struct({
  kind: Schema.Literal('complete'),
  pages: Schema.Int,
  bars: Schema.Int,
  feed: Schema.Enum(EquityHistoricalFeed),
  adjustment: Schema.Literal('raw'),
  observedAt: UtcInstantSchema,
})

const requestMatches = (
  value: string,
  origin: string,
  pathname: string,
  parameters: Readonly<Record<string, string>>,
) => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  const entries = Object.entries(parameters)
  return (
    url.origin === origin &&
    url.pathname === pathname &&
    url.username === '' &&
    url.password === '' &&
    url.hash === '' &&
    [...url.searchParams].length === entries.length &&
    entries.every(([key, expected]) => url.searchParams.get(key) === expected)
  )
}

const instant = (date: string, time: string) => {
  const value = DateTime.makeZoned(
    {
      year: Number(date.slice(0, 4)),
      month: Number(date.slice(5, 7)),
      day: Number(date.slice(8, 10)),
      hour: Number(time.slice(0, 2)),
      minute: Number(time.slice(3, 5)),
      second: 0,
      millisecond: 0,
    },
    { timeZone: 'America/New_York', adjustForTimeZone: true, disambiguation: 'reject' },
  )
  return value._tag === 'None'
    ? Result.fail(new EquityScreenError({ message: 'Invalid regular exchange session instant' }))
    : Result.succeed(Date.parse(DateTime.formatIso(value.value)))
}

/** A byte pin establishes identity, not authenticity, original arrival time, or executable liquidity. */
export const decodeEquityEdgeSource = (text: string, input: typeof EquityEdgeInputSchema.Type) =>
  Result.gen(function* () {
    if (sha256(text) !== input.sourceSha256)
      return yield* Result.fail(new EquityScreenError({ message: 'Historical source SHA-256 mismatch' }))
    const periods = [input.development, input.validation, input.holdout]
    if (
      input.calendar.start > input.calendar.end ||
      input.calendar.start > input.development.start ||
      input.calendar.end < input.holdout.end ||
      periods.some((p) => p.start > p.end) ||
      input.development.end >= input.validation.start ||
      input.validation.end >= input.holdout.start
    )
      return yield* Result.fail(new EquityScreenError({ message: 'Temporal partitions must be ordered and disjoint' }))
    if (
      !input.symbols.includes('SPY') ||
      new Set(input.symbols).size !== input.symbols.length ||
      input.symbols.some((s) => s.includes('/'))
    )
      return yield* Result.fail(new EquityScreenError({ message: 'Require unique equity symbols and SPY benchmark' }))
    const lines = text.trimEnd().split('\n')
    const first = lines[0]
    const last = lines.at(-1)
    if (first === undefined || last === undefined || lines.length < 3 || lines.length > 130)
      return yield* Result.fail(new EquityScreenError({ message: 'Source paging envelope is incomplete or excessive' }))
    const header = yield* Schema.decodeUnknownResult(Schema.fromJsonString(Header))(first)
    const end = yield* Schema.decodeUnknownResult(Schema.fromJsonString(End))(last)
    if (
      !requestMatches(header.requestUrl, 'https://paper-api.alpaca.markets', '/v2/calendar', {
        start: input.calendar.start,
        end: input.calendar.end,
      }) ||
      (yield* canonicalHashV1Result(header.data)) !== input.calendar.expectedHash ||
      header.data.some((day) => day.date < input.calendar.start || day.date > input.calendar.end)
    )
      return yield* Result.fail(
        new EquityScreenError({
          message: 'Calendar differs from its independently pinned range and session inventory',
        }),
      )
    if (end.feed !== (input.feed ?? EquityHistoricalFeed.Iex))
      return yield* Result.fail(
        new EquityScreenError({ message: 'Historical feed differs from the pinned research input' }),
      )
    if (end.pages !== lines.length - 2)
      return yield* Result.fail(new EquityScreenError({ message: 'Source page count differs' }))
    const days: EquityScreenDay[] = []
    for (const day of header.data) {
      const openAt = yield* instant(day.date, day.open)
      const closeAt = yield* instant(day.date, day.close)
      const previous = days.at(-1)
      if (openAt >= closeAt || (previous !== undefined && (day.date <= previous.date || openAt <= previous.closeAt)))
        return yield* Result.fail(new EquityScreenError({ message: 'Calendar is not unique and ordered' }))
      days.push({ date: day.date, openAt, closeAt })
    }
    if (periods.some((p) => !days.some((d) => d.date === p.start) || !days.some((d) => d.date === p.end)))
      return yield* Result.fail(
        new EquityScreenError({ message: 'Partition endpoints must be retained trading sessions' }),
      )
    if (days.filter((d) => d.date < input.development.start).length < 14)
      return yield* Result.fail(
        new EquityScreenError({ message: 'Fourteen prior calendar sessions are required for opening-volume context' }),
      )
    const bars: EquityScreenBar[] = []
    const lastSymbolAt = new Map<string, number>()
    const tokens = new Set<string>()
    let expectedRequestToken: string | null = null
    let lastAcquiredAt = Date.parse(header.observedAt)
    for (let i = 1; i < lines.length - 1; i++) {
      const line = lines[i]
      if (line === undefined) return yield* Result.fail(new EquityScreenError({ message: 'Missing page' }))
      const page = yield* Schema.decodeUnknownResult(Schema.fromJsonString(Page))(line)
      const parameters: Record<string, string> = {
        symbols: input.symbols.join(','),
        timeframe: '1Min',
        start: `${input.calendar.start}T00:00:00Z`,
        end: `${input.calendar.end}T23:59:59Z`,
        feed: input.feed ?? EquityHistoricalFeed.Iex,
        adjustment: 'raw',
        sort: 'asc',
        limit: '10000',
        asof: input.calendar.end,
      }
      if (page.requestPageToken !== null) parameters['page_token'] = page.requestPageToken
      if (!requestMatches(page.requestUrl, 'https://data.alpaca.markets', '/v2/stocks/bars', parameters))
        return yield* Result.fail(
          new EquityScreenError({ message: 'Historical page request differs from its pinned query and continuation' }),
        )
      const acquiredAt = Date.parse(page.observedAt)
      if (acquiredAt < lastAcquiredAt || acquiredAt > Date.parse(end.observedAt))
        return yield* Result.fail(new EquityScreenError({ message: 'Source acquisition clock regressed' }))
      lastAcquiredAt = acquiredAt
      const token = page.data.next_page_token
      if (
        page.requestPageToken !== expectedRequestToken ||
        page.page !== i - 1 ||
        (i === lines.length - 2) !== (token === null) ||
        (token !== null && tokens.has(token))
      )
        return yield* Result.fail(
          new EquityScreenError({ message: 'Source pagination is not complete and progressive' }),
        )
      if (token !== null) tokens.add(token)
      expectedRequestToken = token
      for (const [symbol, rows] of Object.entries(page.data.bars)) {
        if (!input.symbols.includes(symbol))
          return yield* Result.fail(new EquityScreenError({ message: 'Source contains a foreign symbol' }))
        for (const bar of rows) {
          const at = Date.parse(bar.t)
          if (at < Date.parse(parameters['start'] ?? '') || at > Date.parse(parameters['end'] ?? ''))
            return yield* Result.fail(
              new EquityScreenError({ message: 'Historical bar is outside the requested range' }),
            )
          const previous = lastSymbolAt.get(symbol)
          if (!Number.isFinite(at) || (previous !== undefined && at <= previous))
            return yield* Result.fail(
              new EquityScreenError({ message: 'Historical symbol rows must be strictly ascending across pages' }),
            )
          lastSymbolAt.set(symbol, at)
          if (at + 60_000 > acquiredAt)
            return yield* Result.fail(
              new EquityScreenError({ message: 'Historical bar was not complete at acquisition' }),
            )
          bars.push({
            symbol,
            at,
            open: bar.o,
            high: bar.h,
            low: bar.l,
            close: bar.c,
            volume: bar.v,
            vwap: bar.vw,
          })
        }
      }
    }
    if (bars.length !== end.bars)
      return yield* Result.fail(new EquityScreenError({ message: 'Source row count differs' }))
    const index = yield* indexEquityScreenBars(bars)
    const coverage = days.map((day) => ({
      date: day.date,
      symbols: input.symbols.map((symbol) => {
        let observed = 0
        const expected = (day.closeAt - day.openAt) / 60_000
        for (let at = day.openAt; at < day.closeAt; at += 60_000) if (index.get(symbol)?.has(at) === true) observed++
        return { symbol, expected, observed, missing: expected - observed }
      }),
    }))
    return {
      index,
      days,
      coverage,
      source: {
        sha256: input.sourceSha256,
        bytes: new TextEncoder().encode(text).length,
        bars: bars.length,
        pages: end.pages,
        paginationEvidence: 'OBSERVED_REQUEST_AND_RESPONSE_TOKEN_CHAIN',
        feed: end.feed,
        adjustment: end.adjustment,
        calendarHash: yield* canonicalHashV1Result(days),
        calendarEvidenceHash: input.calendar.expectedHash,
        calendarRequest: { start: input.calendar.start, end: input.calendar.end },
        sourceCoverage: 'RECONSTRUCTED_HISTORICAL_BARS',
        originalArrivalTiming: 'UNKNOWN',
        executionCapacity: 'UNKNOWN',
      },
    }
  }).pipe(
    Result.mapError((cause) =>
      cause instanceof EquityScreenError
        ? cause
        : new EquityScreenError({ message: 'Malformed historical market-data source' }),
    ),
  )

export const decodeEquityEdgeInput = Schema.decodeUnknownResult(EquityEdgeInputSchema, strictParseOptions)
