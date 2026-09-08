import { Data, Result, Schema } from 'effect'

import { makeExecutionCalendarObservation } from '../../cycle/construction'
import { canonicalHashV1Result } from '../../hash'
import { intradayInstantNanos } from '../../market-data/intraday/time'
import { UtcInstantSchema, UtcOrderTimestampSchema } from '../../schemas'
import type { VendorHistoricalBar, VendorHistoricalQuote, VendorHistoricalTrade } from './alpaca/model'
import {
  decodeIntradayMomentumProtocol,
  intradayMomentumSessionHasDecisionInterval,
  intradayMomentumSnapshotSymbols,
  type IntradayMomentumProtocol,
} from '../../strategy/intraday-momentum/protocol'
import type {
  IntradayMomentumCoreBar,
  IntradayMomentumCoreInput,
  IntradayMomentumCoreQuote,
  IntradayMomentumCoreTrade,
} from '../../strategy/intraday-momentum/decision-core'

const minuteNanos = 60_000_000_000n
const secondNanos = 1_000_000_000n
const sha256Pattern = /^[a-f0-9]{64}$/
const timestampSchema = Schema.Union([UtcInstantSchema, UtcOrderTimestampSchema])
const isTimestamp = Schema.is(timestampSchema)

export interface VendorCalendarSession {
  readonly date: string
  readonly openAt: string
  readonly closeAt: string
  readonly calendarHash: string
}

/** Event-only normalized bar input. Provider ingestion and record identity stay outside this boundary. */
export type VendorBar = Pick<VendorHistoricalBar, 'symbol' | 'eventAt' | 'open' | 'high' | 'low'>

/** Event-only normalized quote input. */
export type VendorQuote = Pick<
  VendorHistoricalQuote,
  'symbol' | 'eventAt' | 'bidPrice' | 'bidSize' | 'askPrice' | 'askSize'
>

/** Event-only normalized trade input. */
export type VendorTrade = Pick<VendorHistoricalTrade, 'symbol' | 'eventAt' | 'price'>

export type VendorCaptureKind = 'bars' | 'quotes' | 'trades'

/** Source-capture hashes are opaque bindings; row validation below keeps their contents out of the core input. */
export type VendorCaptureHashes = Partial<Record<VendorCaptureKind, string>>
export type CompleteVendorCaptureHashes = Readonly<Record<VendorCaptureKind, string>>

export type VendorDecisionWindowFailureReason =
  | 'protocol'
  | 'calendar'
  | 'window'
  | 'coverage'
  | 'freshness'
  | 'ambiguity'
  | 'market-value'
  | 'provenance'

export class VendorDecisionWindowFailure extends Data.TaggedError('VendorDecisionWindowFailure')<{
  readonly reason: VendorDecisionWindowFailureReason
  readonly message: string
  readonly field?: string
  readonly symbol?: string
  readonly observed?: unknown
  readonly cause?: unknown
}> {}

export interface VendorDecisionWindowInput {
  readonly protocol: IntradayMomentumProtocol
  readonly session: VendorCalendarSession
  readonly observedAt: string
  readonly rangeStartAt: string
  readonly rangeEndAt: string
  readonly bars: readonly VendorBar[]
  readonly quotes: readonly VendorQuote[]
  readonly trades: readonly VendorTrade[]
  /** Hashes of the bounded provider captures supplied by the vendor client. */
  readonly captureHashes: VendorCaptureHashes
}

export interface VendorDecisionWindowResult {
  readonly coreInput: IntradayMomentumCoreInput
  /** Event-only hash; it contains no ingestion, finality, Kafka, archive, or snapshot identity. */
  readonly provenanceHash: string
  readonly captureHashes: CompleteVendorCaptureHashes
  readonly session: VendorCalendarSession
  readonly rangeStartAt: string
  readonly rangeEndAt: string
  readonly observedAt: string
}

export interface VendorQuoteWindowInput {
  readonly protocol: IntradayMomentumProtocol
  readonly session: VendorCalendarSession
  readonly symbols: readonly string[]
  readonly observedAt: string
  readonly rangeEndAt: string
  readonly quotes: readonly VendorQuote[]
  readonly captureHashes: VendorCaptureHashes
}

const compareCanonicalText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)
const compareNanos = (left: bigint, right: bigint): number => (left < right ? -1 : left > right ? 1 : 0)

const fail = (
  reason: VendorDecisionWindowFailureReason,
  message: string,
  details: Pick<VendorDecisionWindowFailure, 'field' | 'symbol' | 'observed' | 'cause'> = {},
): Result.Result<never, VendorDecisionWindowFailure> =>
  Result.fail(new VendorDecisionWindowFailure({ reason, message, ...details }))

const verifyProtocol = (
  protocol: IntradayMomentumProtocol,
): Result.Result<IntradayMomentumProtocol, VendorDecisionWindowFailure> =>
  Result.mapError(
    decodeIntradayMomentumProtocol(protocol),
    (cause) =>
      new VendorDecisionWindowFailure({
        reason: 'protocol',
        message: 'vendor replay protocol does not satisfy the active intraday-momentum contract',
        cause,
      }),
  )

const timestampNanos = (value: unknown, field: string): Result.Result<bigint, VendorDecisionWindowFailure> => {
  if (typeof value !== 'string' || !isTimestamp(value)) {
    return fail('window', 'vendor replay timestamp is not a canonical UTC instant', { field, observed: value })
  }
  try {
    return Result.succeed(intradayInstantNanos(value))
  } catch (cause) {
    return fail('window', 'vendor replay timestamp cannot be represented at nanosecond precision', {
      field,
      observed: value,
      cause,
    })
  }
}

interface VerifiedSession {
  readonly session: VendorCalendarSession
  readonly openNanos: bigint
  readonly closeNanos: bigint
}

const verifySession = (session: VendorCalendarSession): Result.Result<VerifiedSession, VendorDecisionWindowFailure> => {
  if (session === null || typeof session !== 'object') {
    return fail('calendar', 'vendor replay session must be a normalized calendar object', {
      field: 'session',
      observed: session,
    })
  }
  const calendar = makeExecutionCalendarObservation({
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
    source: 'alpaca-v2-calendar',
    date: session.date,
    openAt: session.openAt,
    closeAt: session.closeAt,
  })
  if (Result.isFailure(calendar)) {
    return fail('calendar', 'vendor replay session is not a valid normalized exchange session', {
      cause: calendar.failure,
    })
  }
  if (session.calendarHash !== calendar.success.executionCalendarHash) {
    return fail('calendar', 'vendor replay session calendar hash does not match its normalized session', {
      field: 'session.calendarHash',
      observed: session.calendarHash,
    })
  }
  const parsed = Result.all({
    openNanos: timestampNanos(session.openAt, 'session.openAt'),
    closeNanos: timestampNanos(session.closeAt, 'session.closeAt'),
  })
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure)
  return Result.succeed({
    session: Object.freeze({ ...session }),
    openNanos: parsed.success.openNanos,
    closeNanos: parsed.success.closeNanos,
  })
}

const sameSessionDate = (value: string, date: string): boolean => value.startsWith(`${date}T`)

const verifySymbols = (
  protocol: IntradayMomentumProtocol,
  symbols: readonly string[],
): Result.Result<readonly string[], VendorDecisionWindowFailure> => {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return fail('coverage', 'vendor replay quote window must name at least one symbol', {
      field: 'symbols',
      observed: symbols,
    })
  }
  if (symbols.some((symbol) => typeof symbol !== 'string')) {
    return fail('coverage', 'vendor replay quote window symbols must be strings', {
      field: 'symbols',
      observed: symbols,
    })
  }
  const canonical = [...symbols].sort(compareCanonicalText)
  if (canonical.some((symbol, index) => symbol !== symbols[index])) {
    return fail('coverage', 'vendor replay quote window symbols must be in canonical order', {
      field: 'symbols',
      observed: symbols,
    })
  }
  if (new Set(symbols).size !== symbols.length || symbols.some((symbol) => !protocol.universe.includes(symbol))) {
    return fail('coverage', 'vendor replay quote window symbols must be unique members of the protocol universe', {
      field: 'symbols',
      observed: symbols,
    })
  }
  return Result.succeed(Object.freeze([...symbols]))
}

interface DecisionWindowTimes extends VerifiedSession {
  readonly rangeStartNanos: bigint
  readonly rangeEndNanos: bigint
  readonly observedNanos: bigint
}

interface QuoteWindowTimes extends VerifiedSession {
  readonly rangeEndNanos: bigint
  readonly observedNanos: bigint
}

const verifyQuoteTimes = (
  protocol: IntradayMomentumProtocol,
  session: VerifiedSession,
  rangeEndAt: string,
  observedAt: string,
): Result.Result<QuoteWindowTimes, VendorDecisionWindowFailure> => {
  const parsed = Result.all({
    rangeEndNanos: timestampNanos(rangeEndAt, 'rangeEndAt'),
    observedNanos: timestampNanos(observedAt, 'observedAt'),
  })
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure)
  const { rangeEndNanos, observedNanos } = parsed.success
  if (
    !sameSessionDate(rangeEndAt, session.session.date) ||
    !sameSessionDate(observedAt, session.session.date) ||
    rangeEndNanos < session.openNanos ||
    rangeEndNanos >= session.closeNanos ||
    observedNanos <= rangeEndNanos ||
    observedNanos > session.closeNanos ||
    rangeEndNanos % minuteNanos !== 0n
  ) {
    return fail('window', 'vendor replay quote window is outside the regular exchange session', {
      field: 'rangeEndAt',
      observed: { rangeEndAt, observedAt },
    })
  }
  if (!intradayMomentumSessionHasDecisionInterval(protocol, session.session)) {
    return fail('window', 'vendor replay session has no eligible intraday decision interval')
  }
  return Result.succeed({ ...session, rangeEndNanos, observedNanos })
}

const verifyDecisionTimes = (
  protocol: IntradayMomentumProtocol,
  session: VerifiedSession,
  rangeStartAt: string,
  rangeEndAt: string,
  observedAt: string,
): Result.Result<DecisionWindowTimes, VendorDecisionWindowFailure> => {
  const parsed = Result.all({
    rangeStartNanos: timestampNanos(rangeStartAt, 'rangeStartAt'),
    rangeEndNanos: timestampNanos(rangeEndAt, 'rangeEndAt'),
    observedNanos: timestampNanos(observedAt, 'observedAt'),
  })
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure)
  const { rangeStartNanos, rangeEndNanos, observedNanos } = parsed.success
  const decisionDelayNanos = BigInt(protocol.decisionDelaySeconds) * secondNanos
  const lookbackNanos = BigInt(protocol.lookbackMinutes) * minuteNanos
  const warmupNanos = BigInt(protocol.warmupMinutesAfterOpen) * minuteNanos
  const entryCutoffNanos = session.closeNanos - BigInt(protocol.entryCutoffMinutesBeforeClose) * minuteNanos
  const earliestRangeEndNanos = session.openNanos + warmupNanos
  const earliestDecisionNanos = rangeEndNanos + decisionDelayNanos
  const latestDecisionNanos = earliestDecisionNanos + BigInt(protocol.maximumDecisionLagMs) * 1_000_000n
  const expectedRangeEndNanos = floorToMinute(observedNanos - decisionDelayNanos)
  const expectedRangeStartNanos = expectedRangeEndNanos - lookbackNanos
  if (
    !sameSessionDate(rangeStartAt, session.session.date) ||
    !sameSessionDate(rangeEndAt, session.session.date) ||
    !sameSessionDate(observedAt, session.session.date) ||
    session.openNanos >= session.closeNanos ||
    !intradayMomentumSessionHasDecisionInterval(protocol, session.session) ||
    rangeStartNanos !== expectedRangeStartNanos ||
    rangeEndNanos !== expectedRangeEndNanos ||
    rangeStartNanos < session.openNanos ||
    rangeEndNanos < earliestRangeEndNanos ||
    rangeEndNanos > entryCutoffNanos ||
    observedNanos < earliestDecisionNanos ||
    observedNanos > latestDecisionNanos ||
    observedNanos >= entryCutoffNanos ||
    observedNanos > session.closeNanos
  ) {
    return fail('window', 'vendor replay decision window does not bind an eligible rolling interval', {
      field: 'rangeEndAt',
      observed: { rangeStartAt, rangeEndAt, observedAt },
    })
  }
  return Result.succeed({ ...session, rangeStartNanos, rangeEndNanos, observedNanos })
}

const floorToMinute = (value: bigint): bigint => {
  const remainder = value % minuteNanos
  return remainder >= 0n ? value - remainder : value - remainder - minuteNanos
}

const positiveFinite = (
  value: unknown,
  field: string,
  symbol: string,
): Result.Result<number, VendorDecisionWindowFailure> =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Result.succeed(value)
    : fail('market-value', 'vendor replay price must be finite and positive', { field, symbol, observed: value })

const nonNegativeFinite = (
  value: unknown,
  field: string,
  symbol: string,
): Result.Result<number, VendorDecisionWindowFailure> =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Result.succeed(value)
    : fail('market-value', 'vendor replay size must be finite and non-negative', { field, symbol, observed: value })

const sortBars = (bars: readonly VendorBar[]): readonly VendorBar[] =>
  Object.freeze(
    [...bars].sort(
      (left, right) =>
        compareNanos(intradayInstantNanos(left.eventAt), intradayInstantNanos(right.eventAt)) ||
        compareCanonicalText(left.symbol, right.symbol) ||
        left.open - right.open ||
        left.high - right.high ||
        left.low - right.low,
    ),
  )

const sortQuotes = (quotes: readonly VendorQuote[]): readonly VendorQuote[] =>
  Object.freeze(
    [...quotes].sort(
      (left, right) =>
        compareNanos(intradayInstantNanos(left.eventAt), intradayInstantNanos(right.eventAt)) ||
        compareCanonicalText(left.eventAt, right.eventAt) ||
        compareCanonicalText(left.symbol, right.symbol) ||
        left.bidPrice - right.bidPrice ||
        left.bidSize - right.bidSize ||
        left.askPrice - right.askPrice ||
        left.askSize - right.askSize,
    ),
  )

const sortTrades = (trades: readonly VendorTrade[]): readonly VendorTrade[] =>
  Object.freeze(
    [...trades].sort(
      (left, right) =>
        compareNanos(intradayInstantNanos(left.eventAt), intradayInstantNanos(right.eventAt)) ||
        compareCanonicalText(left.eventAt, right.eventAt) ||
        compareCanonicalText(left.symbol, right.symbol) ||
        left.price - right.price,
    ),
  )

const validateBars = (
  protocol: IntradayMomentumProtocol,
  window: DecisionWindowTimes,
  bars: readonly VendorBar[],
): Result.Result<readonly VendorBar[], VendorDecisionWindowFailure> => {
  if (!Array.isArray(bars)) return fail('coverage', 'vendor replay bars must be an array', { field: 'bars' })
  const symbols = intradayMomentumSnapshotSymbols(protocol)
  const symbolSet = new Set(symbols)
  const seen = new Set<string>()
  const normalized: VendorBar[] = []
  for (const [index, bar] of bars.entries()) {
    if (bar === undefined || bar === null || typeof bar !== 'object') {
      return fail('coverage', 'vendor replay bar is not a normalized record', {
        field: `bars[${index}]`,
        observed: bar,
      })
    }
    if (typeof bar.symbol !== 'string' || !symbolSet.has(bar.symbol)) {
      return fail('coverage', 'vendor replay bar names a symbol outside the decision universe', {
        field: `bars[${index}].symbol`,
        symbol: bar.symbol,
        observed: bar.symbol,
      })
    }
    const eventAt = timestampNanos(bar.eventAt, `bars[${index}].eventAt`)
    if (Result.isFailure(eventAt)) return Result.fail(eventAt.failure)
    const key = `${bar.symbol}\u0000${eventAt.success.toString()}`
    if (
      eventAt.success < window.rangeStartNanos ||
      eventAt.success >= window.rangeEndNanos ||
      (eventAt.success - window.rangeStartNanos) % minuteNanos !== 0n
    ) {
      return fail('coverage', 'vendor replay bar is outside the exact one-minute decision grid', {
        field: `bars[${index}].eventAt`,
        symbol: bar.symbol,
        observed: bar.eventAt,
      })
    }
    if (seen.has(key)) {
      return fail('ambiguity', 'vendor replay bars contain duplicate same-minute evidence', {
        field: `bars[${index}].eventAt`,
        symbol: bar.symbol,
        observed: bar.eventAt,
      })
    }
    seen.add(key)
    const values = Result.all({
      open: positiveFinite(bar.open, `bars[${index}].open`, bar.symbol),
      high: positiveFinite(bar.high, `bars[${index}].high`, bar.symbol),
      low: positiveFinite(bar.low, `bars[${index}].low`, bar.symbol),
    })
    if (Result.isFailure(values)) return Result.fail(values.failure)
    if (values.success.high < Math.max(values.success.open, values.success.low)) {
      return fail('market-value', 'vendor replay bar high is below its open or low', {
        field: `bars[${index}].high`,
        symbol: bar.symbol,
        observed: bar.high,
      })
    }
    if (values.success.low > Math.min(values.success.open, values.success.high)) {
      return fail('market-value', 'vendor replay bar low is above its open or high', {
        field: `bars[${index}].low`,
        symbol: bar.symbol,
        observed: bar.low,
      })
    }
    normalized.push(
      Object.freeze({
        symbol: bar.symbol,
        eventAt: bar.eventAt,
        open: values.success.open,
        high: values.success.high,
        low: values.success.low,
      }),
    )
  }
  const expectedCount = symbols.length * protocol.lookbackMinutes
  if (normalized.length > expectedCount) {
    return fail('coverage', 'vendor replay bars exceed the bounded rolling decision grid', {
      field: 'bars',
      observed: normalized.length,
    })
  }
  const bySymbol = new Map(symbols.map((symbol) => [symbol, new Set<string>()]))
  for (const bar of normalized) bySymbol.get(bar.symbol)?.add(intradayInstantNanos(bar.eventAt).toString())
  for (const symbol of symbols) {
    const symbolBars = bySymbol.get(symbol)
    if (symbolBars === undefined) {
      return fail('coverage', 'vendor replay symbol lacks the complete rolling lookback baseline', {
        symbol,
        field: 'bars',
      })
    }
    for (let minute = 0; minute < protocol.lookbackMinutes; minute += 1) {
      const expectedEventNanos = window.rangeStartNanos + BigInt(minute) * minuteNanos
      if (!symbolBars.has(expectedEventNanos.toString())) {
        return fail('coverage', 'vendor replay symbol lacks the complete rolling lookback baseline', {
          symbol,
          field: 'bars',
          observed: expectedEventNanos.toString(),
        })
      }
    }
  }
  if (normalized.length !== expectedCount) {
    return fail('coverage', 'vendor replay bars do not cover the complete rolling decision grid', {
      field: 'bars',
      observed: normalized.length,
    })
  }
  return Result.succeed(sortBars(normalized))
}

interface ValidatedQuoteSet {
  readonly records: readonly VendorQuote[]
  readonly latest: Readonly<Record<string, VendorQuote>>
}

const validateQuotes = (
  protocol: IntradayMomentumProtocol,
  session: VerifiedSession,
  symbols: readonly string[],
  rangeEndNanos: bigint,
  observedNanos: bigint,
  quotes: readonly VendorQuote[],
): Result.Result<ValidatedQuoteSet, VendorDecisionWindowFailure> => {
  if (!Array.isArray(quotes)) return fail('coverage', 'vendor replay quotes must be an array', { field: 'quotes' })
  const symbolSet = new Set(symbols)
  const latest = new Map<string, { readonly eventNanos: bigint; readonly quotes: VendorQuote[] }>()
  const normalized: VendorQuote[] = []
  for (const [index, quote] of quotes.entries()) {
    if (quote === undefined || quote === null || typeof quote !== 'object') {
      return fail('coverage', 'vendor replay quote is not a normalized record', {
        field: `quotes[${index}]`,
        observed: quote,
      })
    }
    if (typeof quote.symbol !== 'string' || !symbolSet.has(quote.symbol)) {
      return fail('coverage', 'vendor replay quote names a symbol outside the requested window', {
        field: `quotes[${index}].symbol`,
        symbol: quote.symbol,
        observed: quote.symbol,
      })
    }
    const eventAt = timestampNanos(quote.eventAt, `quotes[${index}].eventAt`)
    if (Result.isFailure(eventAt)) return Result.fail(eventAt.failure)
    if (
      eventAt.success < session.openNanos ||
      eventAt.success > observedNanos ||
      !sameSessionDate(quote.eventAt, session.session.date)
    ) {
      return fail('window', 'vendor replay quote is outside the observed regular-session boundary', {
        field: `quotes[${index}].eventAt`,
        symbol: quote.symbol,
        observed: quote.eventAt,
      })
    }
    const values = Result.all({
      bidPrice: positiveFinite(quote.bidPrice, `quotes[${index}].bidPrice`, quote.symbol),
      bidSize: nonNegativeFinite(quote.bidSize, `quotes[${index}].bidSize`, quote.symbol),
      askPrice: positiveFinite(quote.askPrice, `quotes[${index}].askPrice`, quote.symbol),
      askSize: nonNegativeFinite(quote.askSize, `quotes[${index}].askSize`, quote.symbol),
    })
    if (Result.isFailure(values)) return Result.fail(values.failure)
    if (values.success.bidPrice > values.success.askPrice) {
      return fail('market-value', 'vendor replay quote is crossed', {
        field: `quotes[${index}]`,
        symbol: quote.symbol,
        observed: quote,
      })
    }
    const normalizedQuote = Object.freeze({
      symbol: quote.symbol,
      eventAt: quote.eventAt,
      bidPrice: values.success.bidPrice,
      bidSize: values.success.bidSize,
      askPrice: values.success.askPrice,
      askSize: values.success.askSize,
    })
    normalized.push(normalizedQuote)
    const previous = latest.get(quote.symbol)
    if (previous === undefined || eventAt.success > previous.eventNanos) {
      latest.set(quote.symbol, { eventNanos: eventAt.success, quotes: [normalizedQuote] })
    } else if (eventAt.success === previous.eventNanos) {
      previous.quotes.push(normalizedQuote)
    }
  }
  const canonicalLatest: Record<string, VendorQuote> = {}
  for (const symbol of symbols) {
    const selected = latest.get(symbol)
    if (selected === undefined || selected.eventNanos < rangeEndNanos) {
      return fail('coverage', 'vendor replay quote window lacks post-range evidence for every symbol', {
        symbol,
        field: 'quotes',
      })
    }
    const selectedQuotes = selected.quotes.toSorted((left, right) => compareCanonicalText(left.eventAt, right.eventAt))
    const selectedQuote = selectedQuotes[0]
    if (selectedQuote === undefined) {
      return fail('coverage', 'vendor replay quote window has no selected latest quote', {
        symbol,
        field: 'quotes',
      })
    }
    if (
      selectedQuotes.some(
        (quote) =>
          quote.bidPrice !== selectedQuote.bidPrice ||
          quote.bidSize !== selectedQuote.bidSize ||
          quote.askPrice !== selectedQuote.askPrice ||
          quote.askSize !== selectedQuote.askSize,
      )
    ) {
      return fail('ambiguity', 'vendor replay has conflicting latest quote records at the same event time', {
        field: 'quotes',
        symbol,
        observed: selectedQuote.eventAt,
      })
    }
    const age = observedNanos - selected.eventNanos
    if (age < 0n || age > BigInt(protocol.maximumQuoteAgeMs) * 1_000_000n) {
      return fail('freshness', 'vendor replay quote exceeds the protocol freshness bound', {
        symbol,
        field: 'quotes',
        observed: selectedQuote.eventAt,
      })
    }
    canonicalLatest[symbol] = selectedQuote
  }
  return Result.succeed({ records: sortQuotes(normalized), latest: Object.freeze(canonicalLatest) })
}

interface ValidatedTradeSet {
  readonly records: readonly VendorTrade[]
  readonly latest: Readonly<Record<string, VendorTrade>>
}

const validateTrades = (
  protocol: IntradayMomentumProtocol,
  session: VerifiedSession,
  symbols: readonly string[],
  rangeEndNanos: bigint,
  observedNanos: bigint,
  trades: readonly VendorTrade[],
): Result.Result<ValidatedTradeSet, VendorDecisionWindowFailure> => {
  if (!Array.isArray(trades)) return fail('coverage', 'vendor replay trades must be an array', { field: 'trades' })
  const symbolSet = new Set(symbols)
  const latest = new Map<string, { readonly eventNanos: bigint; readonly trades: VendorTrade[] }>()
  const normalized: VendorTrade[] = []
  for (const [index, trade] of trades.entries()) {
    if (trade === undefined || trade === null || typeof trade !== 'object') {
      return fail('coverage', 'vendor replay trade is not a normalized record', {
        field: `trades[${index}]`,
        observed: trade,
      })
    }
    if (typeof trade.symbol !== 'string' || !symbolSet.has(trade.symbol)) {
      return fail('coverage', 'vendor replay trade names a symbol outside the requested window', {
        field: `trades[${index}].symbol`,
        symbol: trade.symbol,
        observed: trade.symbol,
      })
    }
    const eventAt = timestampNanos(trade.eventAt, `trades[${index}].eventAt`)
    if (Result.isFailure(eventAt)) return Result.fail(eventAt.failure)
    if (
      eventAt.success < session.openNanos ||
      eventAt.success > observedNanos ||
      !sameSessionDate(trade.eventAt, session.session.date)
    ) {
      return fail('window', 'vendor replay trade is outside the observed regular-session boundary', {
        field: `trades[${index}].eventAt`,
        symbol: trade.symbol,
        observed: trade.eventAt,
      })
    }
    const price = positiveFinite(trade.price, `trades[${index}].price`, trade.symbol)
    if (Result.isFailure(price)) return Result.fail(price.failure)
    const normalizedTrade = Object.freeze({ symbol: trade.symbol, eventAt: trade.eventAt, price: price.success })
    normalized.push(normalizedTrade)
    const previous = latest.get(trade.symbol)
    if (previous === undefined || eventAt.success > previous.eventNanos) {
      latest.set(trade.symbol, { eventNanos: eventAt.success, trades: [normalizedTrade] })
    } else if (eventAt.success === previous.eventNanos) {
      previous.trades.push(normalizedTrade)
    }
  }
  const result: Record<string, VendorTrade> = {}
  for (const symbol of symbols) {
    const selected = latest.get(symbol)
    if (selected === undefined || selected.eventNanos < rangeEndNanos) {
      return fail('coverage', 'vendor replay trade window lacks post-range evidence for every symbol', {
        symbol,
        field: 'trades',
      })
    }
    const selectedTrades = selected.trades.toSorted((left, right) => compareCanonicalText(left.eventAt, right.eventAt))
    const selectedTrade = selectedTrades[0]
    if (selectedTrade === undefined) {
      return fail('coverage', 'vendor replay trade window has no selected latest trade', {
        symbol,
        field: 'trades',
      })
    }
    if (selectedTrades.some((trade) => trade.price !== selectedTrade.price)) {
      return fail('ambiguity', 'vendor replay has conflicting latest trade records at the same event time', {
        field: 'trades',
        symbol,
        observed: selectedTrade.eventAt,
      })
    }
    const age = observedNanos - selected.eventNanos
    if (age < 0n || age > BigInt(protocol.maximumQuoteAgeMs) * 1_000_000n) {
      return fail('freshness', 'vendor replay trade exceeds the protocol freshness bound', {
        symbol,
        field: 'trades',
        observed: selectedTrade.eventAt,
      })
    }
    result[symbol] = selectedTrade
  }
  return Result.succeed({ records: sortTrades(normalized), latest: Object.freeze(result) })
}

const captureKinds: readonly VendorCaptureKind[] = ['bars', 'quotes', 'trades']

const validateCaptureHashes = (
  hashes: VendorCaptureHashes,
  required: readonly VendorCaptureKind[],
): Result.Result<Readonly<VendorCaptureHashes>, VendorDecisionWindowFailure> => {
  if (hashes === null || typeof hashes !== 'object' || Array.isArray(hashes)) {
    return fail('provenance', 'vendor replay capture hashes must be a plain object', {
      field: 'captureHashes',
      observed: hashes,
    })
  }
  const entries = Object.entries(hashes)
  const invalidKey = entries.find(([kind]) => !captureKinds.some((expected) => expected === kind))
  if (invalidKey !== undefined) {
    return fail('provenance', 'vendor replay capture hashes contain an unsupported capture kind', {
      field: `captureHashes.${invalidKey[0]}`,
      observed: invalidKey[1],
    })
  }
  for (const kind of captureKinds) {
    const hash = hashes[kind]
    if (hash !== undefined && (typeof hash !== 'string' || !sha256Pattern.test(hash))) {
      return fail('provenance', 'vendor replay capture hash must be a lowercase SHA-256', {
        field: `captureHashes.${kind}`,
        observed: hash,
      })
    }
  }
  for (const kind of required) {
    const hash = hashes[kind]
    if (hash === undefined) {
      return fail('provenance', 'vendor replay window is missing a required source capture hash', {
        field: `captureHashes.${kind}`,
      })
    }
  }
  const canonicalEntries = captureKinds.flatMap((kind) => {
    const hash = hashes[kind]
    return hash === undefined ? [] : [[kind, hash] as const]
  })
  return Result.succeed(Object.freeze(Object.fromEntries(canonicalEntries)))
}

const validateAllCaptureHashes = (
  hashes: VendorCaptureHashes,
): Result.Result<CompleteVendorCaptureHashes, VendorDecisionWindowFailure> =>
  Result.flatMap(validateCaptureHashes(hashes, captureKinds), (validated) => {
    const { bars, quotes, trades } = validated
    if (bars === undefined || quotes === undefined || trades === undefined) {
      return fail('provenance', 'vendor replay window is missing a required source capture hash', {
        field: 'captureHashes',
      })
    }
    return Result.succeed(Object.freeze({ bars, quotes, trades }))
  })

const provenanceHash = (
  protocol: IntradayMomentumProtocol,
  session: VendorCalendarSession,
  rangeStartAt: string,
  rangeEndAt: string,
  observedAt: string,
  bars: readonly VendorBar[],
  quotes: readonly VendorQuote[],
  trades: readonly VendorTrade[],
  captureHashes: Readonly<VendorCaptureHashes>,
): Result.Result<string, VendorDecisionWindowFailure> =>
  Result.mapError(
    canonicalHashV1Result({
      schemaVersion: 'bayn.vendor-intraday-decision-window.v1',
      protocol,
      session,
      rangeStartAt,
      rangeEndAt,
      observedAt,
      bars,
      quotes,
      trades,
      captureHashes,
    }),
    (cause) =>
      new VendorDecisionWindowFailure({
        reason: 'provenance',
        message: 'vendor replay event-only evidence cannot be canonically hashed',
        cause,
      }),
  )

export const validateVendorQuoteWindow = (
  input: VendorQuoteWindowInput,
): Result.Result<Readonly<Record<string, VendorQuote>>, VendorDecisionWindowFailure> =>
  Result.gen(function* () {
    const protocol = yield* verifyProtocol(input.protocol)
    const session = yield* verifySession(input.session)
    const symbols = yield* verifySymbols(protocol, input.symbols)
    const window = yield* verifyQuoteTimes(protocol, session, input.rangeEndAt, input.observedAt)
    const validated = yield* validateQuotes(
      protocol,
      session,
      symbols,
      window.rangeEndNanos,
      window.observedNanos,
      input.quotes,
    )
    yield* validateCaptureHashes(input.captureHashes, ['quotes'])
    return validated.latest
  })

export const validateVendorDecisionWindow = (
  input: VendorDecisionWindowInput,
): Result.Result<VendorDecisionWindowResult, VendorDecisionWindowFailure> =>
  Result.gen(function* () {
    const protocol = yield* verifyProtocol(input.protocol)
    const session = yield* verifySession(input.session)
    const window = yield* verifyDecisionTimes(protocol, session, input.rangeStartAt, input.rangeEndAt, input.observedAt)
    const symbols = intradayMomentumSnapshotSymbols(protocol)
    const bars = yield* validateBars(protocol, window, input.bars)
    const quotes = yield* validateQuotes(
      protocol,
      session,
      symbols,
      window.rangeEndNanos,
      window.observedNanos,
      input.quotes,
    )
    const trades = yield* validateTrades(
      protocol,
      session,
      symbols,
      window.rangeEndNanos,
      window.observedNanos,
      input.trades,
    )
    const captureHashes = yield* validateAllCaptureHashes(input.captureHashes)
    const coreBars: readonly IntradayMomentumCoreBar[] = bars.map(({ symbol, eventAt, open, high, low }) =>
      Object.freeze({ symbol, eventAt, open, high, low }),
    )
    const coreQuotes: Readonly<Record<string, IntradayMomentumCoreQuote>> = Object.freeze(
      Object.fromEntries(
        Object.entries(quotes.latest).map(([symbol, quote]) => {
          return [
            symbol,
            Object.freeze({
              symbol,
              eventAt: quote.eventAt,
              bidPrice: quote.bidPrice,
              bidSize: quote.bidSize,
              askPrice: quote.askPrice,
              askSize: quote.askSize,
            }),
          ]
        }),
      ),
    )
    const coreTrades: Readonly<Record<string, IntradayMomentumCoreTrade>> = Object.freeze(
      Object.fromEntries(
        Object.entries(trades.latest).map(([symbol, trade]) => {
          return [symbol, Object.freeze({ symbol, eventAt: trade.eventAt, price: trade.price })]
        }),
      ),
    )
    const coreInput: IntradayMomentumCoreInput = Object.freeze({
      bars: Object.freeze(coreBars),
      latestQuotes: coreQuotes,
      latestTrades: coreTrades,
      observedAt: input.observedAt,
      protocol,
    })
    const eventProvenanceHash = yield* provenanceHash(
      protocol,
      session.session,
      input.rangeStartAt,
      input.rangeEndAt,
      input.observedAt,
      bars,
      quotes.records,
      trades.records,
      captureHashes,
    )
    return Object.freeze({
      coreInput,
      provenanceHash: eventProvenanceHash,
      captureHashes,
      session: session.session,
      rangeStartAt: input.rangeStartAt,
      rangeEndAt: input.rangeEndAt,
      observedAt: input.observedAt,
    })
  })
