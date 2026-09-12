import { Result, Schema } from 'effect'

import { canonicalHashV1Result, sha256 } from '../../hash'
import { marketCalendarSchemaVersion, marketCalendarSource } from '../../broker/alpaca/model'
import { IsoDateSchema } from '../../schemas'
import type {
  IntradayArchiveWatermark,
  IntradayBar,
  IntradayCandidateExclusion,
  IntradayLineage,
  IntradayMarketSnapshot,
  IntradayQuote,
  IntradayRecordIdentity,
  IntradaySnapshotFailureReason,
  IntradaySnapshotManifest,
  IntradaySnapshotQuery,
  IntradaySnapshotRequest,
  IntradayTrade,
} from './model'
import {
  IntradayIngestionDelayDirection,
  IntradaySnapshotFailure,
  IntradaySnapshotPurpose,
  intradaySnapshotSymbols,
} from './model'
import type { IntradayArchiveWatermarkRow, IntradayBarRow, IntradayQuoteRow, IntradayTradeRow } from './rows'
import {
  decodeIntradayArchiveWatermarkRows,
  decodeIntradayBarRows,
  decodeIntradayQuoteRows,
  decodeIntradayTradeRows,
} from './rows'
import { compareIntradayInstants, intradayAgeNanos, intradayInstantNanos, millisecondsAsNanos } from './time'

const minuteMs = 60_000
const maximumWindowMs = 30 * minuteMs
export const maximumIntradayObservationLagMs = 20 * minuteMs
export const maximumIntradayQuoteAgeMs = 5 * minuteMs
export const minimumIntradayQuoteAgeMs = 1_000
const maximumUniverseSize = 64
const numericStringPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
const sourceTopicPattern = /^[A-Za-z0-9._-]+$/
const isIsoDate = Schema.is(IsoDateSchema)
const isIntradaySnapshotPurpose = Schema.is(Schema.Enum(IntradaySnapshotPurpose))
const maximumNonNegativeInt32 = 2_147_483_647
const maximumNonNegativeInt64 = 9_223_372_036_854_775_807n

const ReplayArchiveWatermarkSchema = Schema.Struct({
  sourceTopic: Schema.String,
  sourcePartition: Schema.Finite,
  inclusiveLastOffset: Schema.String,
})

const ReplayLineageSchema = Schema.Struct({
  sourceTopic: Schema.String,
  sourcePartition: Schema.Finite,
  firstOffset: Schema.String,
  lastOffset: Schema.String,
  recordCount: Schema.Finite,
})

const ReplayCalendarSchema = Schema.Struct({
  schemaVersion: Schema.String,
  source: Schema.String,
  requestedRange: Schema.Struct({ start: Schema.String, end: Schema.String }),
  timeZone: Schema.String,
  sessions: Schema.Array(
    Schema.Struct({
      date: Schema.String,
      openAt: Schema.String,
      closeAt: Schema.String,
    }),
  ),
  normalizedResponseHash: Schema.String,
})

const ReplaySnapshotEnvelopeSchema = Schema.Struct({
  bars: Schema.Array(Schema.Unknown),
  quotes: Schema.Array(Schema.Unknown),
  trades: Schema.Array(Schema.Unknown),
  latestQuotes: Schema.Record(Schema.String, Schema.Unknown),
  manifest: Schema.Struct({
    schemaVersion: Schema.String,
    sessionDate: Schema.String,
    calendar: ReplayCalendarSchema,
    rangeStartAt: Schema.String,
    rangeEndAt: Schema.String,
    observedAt: Schema.String,
    universeId: Schema.String,
    universeSymbolHash: Schema.String,
    symbols: Schema.Array(Schema.String),
    candidateSymbols: Schema.optionalKey(Schema.Array(Schema.String)),
    candidateExclusions: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          symbol: Schema.String,
          reason: Schema.Literals(['not-ready', 'freshness']),
          message: Schema.String,
        }),
      ),
    ),
    feed: Schema.String,
    delayClass: Schema.String,
    sourceTopics: Schema.Struct({ bars: Schema.String, quotes: Schema.String, trades: Schema.String }),
    archiveWatermarks: Schema.Array(ReplayArchiveWatermarkSchema),
    maximumQuoteAgeMs: Schema.Finite,
    minimumWatermarkLagMs: Schema.Finite,
    barCount: Schema.Finite,
    quoteCount: Schema.Finite,
    tradeCount: Schema.Finite,
    barsContentHash: Schema.String,
    quotesContentHash: Schema.String,
    tradesContentHash: Schema.String,
    lineage: Schema.Array(ReplayLineageSchema),
    contentHash: Schema.String,
    snapshotId: Schema.String,
  }),
})

const decodeReplaySnapshotEnvelope = Schema.decodeUnknownResult(ReplaySnapshotEnvelopeSchema)

// ClickHouse orders String values by their binary representation. Source topics
// are restricted to Kafka's ASCII name domain, so code-unit comparison is the
// exact in-process equivalent and cannot vary with the host locale.
const compareCanonicalText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)
const isCanonicalNonNegativeInt64 = (value: string): boolean =>
  /^\d+$/.test(value) && String(BigInt(value)) === value && BigInt(value) <= maximumNonNegativeInt64

const failure = (
  reason: IntradaySnapshotFailureReason,
  message: string,
  facts?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): IntradaySnapshotFailure =>
  new IntradaySnapshotFailure({
    reason,
    message,
    ...(facts === undefined ? {} : { facts }),
    ...(cause === undefined ? {} : { cause }),
  })

const epoch = (value: string): number => Date.parse(value)
const isCanonicalInstant = (value: string): boolean => {
  const parsed = epoch(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

const calendarMaterial = (calendar: IntradaySnapshotQuery['calendar']) => ({
  schemaVersion: calendar.schemaVersion,
  source: calendar.source,
  requestedRange: calendar.requestedRange,
  timeZone: calendar.timeZone,
  sessions: calendar.sessions,
})

const validateCalendar = (request: IntradaySnapshotQuery): Result.Result<void, IntradaySnapshotFailure> => {
  const { calendar } = request
  if (
    calendar.schemaVersion !== marketCalendarSchemaVersion ||
    calendar.source !== marketCalendarSource ||
    calendar.timeZone !== 'UTC' ||
    !isIsoDate(calendar.requestedRange.start) ||
    !isIsoDate(calendar.requestedRange.end) ||
    calendar.requestedRange.start > request.sessionDate ||
    calendar.requestedRange.end < request.sessionDate
  ) {
    return Result.fail(failure('request', 'intraday snapshot must bind a canonical calendar observation range'))
  }
  const expectedHash = canonicalHashV1Result(calendarMaterial(calendar))
  if (Result.isFailure(expectedHash)) {
    return Result.fail(
      failure('request', 'intraday calendar observation is not canonically hashable', undefined, expectedHash.failure),
    )
  }
  if (expectedHash.success !== calendar.normalizedResponseHash) {
    return Result.fail(failure('request', 'intraday calendar observation hash does not match its normalized content'))
  }
  let previousDate: string | undefined
  for (const session of calendar.sessions) {
    if (
      !isIsoDate(session.date) ||
      session.date < calendar.requestedRange.start ||
      session.date > calendar.requestedRange.end ||
      !isCanonicalInstant(session.openAt) ||
      !isCanonicalInstant(session.closeAt) ||
      session.openAt.slice(0, 10) !== session.date ||
      session.closeAt.slice(0, 10) !== session.date ||
      session.openAt >= session.closeAt ||
      (previousDate !== undefined && previousDate >= session.date)
    ) {
      return Result.fail(failure('request', 'intraday calendar sessions must be unique, ordered, and canonical'))
    }
    previousDate = session.date
  }
  const session = calendar.sessions.find(({ date }) => date === request.sessionDate)
  const dayOfWeek = new Date(`${request.sessionDate}T00:00:00.000Z`).getUTCDay()
  if (session === undefined || dayOfWeek === 0 || dayOfWeek === 6) {
    return Result.fail(failure('request', 'intraday snapshot date is not a finalized exchange session'))
  }
  if (request.rangeStartAt < session.openAt || request.rangeEndAt > session.closeAt) {
    return Result.fail(failure('request', 'intraday range must remain within the bound regular exchange session'))
  }
  return Result.succeed(undefined)
}

const freezeCalendar = (calendar: IntradaySnapshotQuery['calendar']): IntradaySnapshotQuery['calendar'] =>
  Object.freeze({
    ...calendar,
    requestedRange: Object.freeze({ ...calendar.requestedRange }),
    sessions: Object.freeze(calendar.sessions.map((session) => Object.freeze({ ...session }))),
  })

const validateQuery = <T extends IntradaySnapshotQuery>(request: T): Result.Result<T, IntradaySnapshotFailure> => {
  const start = epoch(request.rangeStartAt)
  const end = epoch(request.rangeEndAt)
  const observed = epoch(request.observedAt)
  if (![request.rangeStartAt, request.rangeEndAt, request.observedAt].every(isCanonicalInstant)) {
    return Result.fail(failure('request', 'intraday snapshot instants must be canonical UTC milliseconds'))
  }
  if (
    !isIsoDate(request.sessionDate) ||
    request.rangeStartAt.slice(0, 10) !== request.sessionDate ||
    request.rangeEndAt.slice(0, 10) !== request.sessionDate ||
    request.observedAt.slice(0, 10) !== request.sessionDate
  ) {
    return Result.fail(failure('request', 'intraday range and observation must remain within the declared session'))
  }
  const duration = end - start
  if (
    duration <= 0 ||
    duration > maximumWindowMs ||
    duration % minuteMs !== 0 ||
    start % minuteMs !== 0 ||
    end % minuteMs !== 0
  ) {
    return Result.fail(
      failure('request', 'intraday range must contain one to 30 complete UTC-aligned one-minute bars', { duration }),
    )
  }
  if (
    !Number.isSafeInteger(request.minimumWatermarkLagMs) ||
    request.minimumWatermarkLagMs < 0 ||
    request.minimumWatermarkLagMs > 5 * minuteMs ||
    observed < end + request.minimumWatermarkLagMs
  ) {
    return Result.fail(failure('request', 'snapshot observation must follow its bounded archive watermark'))
  }
  if (observed - end > maximumIntradayObservationLagMs) {
    return Result.fail(failure('request', 'snapshot observation must remain within twenty minutes of the range end'))
  }
  if (
    !Number.isSafeInteger(request.maximumQuoteAgeMs) ||
    request.maximumQuoteAgeMs < minimumIntradayQuoteAgeMs ||
    request.maximumQuoteAgeMs > maximumIntradayQuoteAgeMs
  ) {
    return Result.fail(failure('request', 'maximum quote age must be between one second and five minutes'))
  }
  const canonicalUniverse = [...new Set(request.universe)].sort()
  if (
    canonicalUniverse.length === 0 ||
    canonicalUniverse.length > maximumUniverseSize ||
    canonicalUniverse.length !== request.universe.length ||
    canonicalUniverse.some((symbol, index) => symbol !== request.universe[index]) ||
    request.universe.some((symbol) => !/^[A-Z][A-Z0-9.-]{0,15}$/.test(symbol))
  ) {
    return Result.fail(failure('request', 'intraday universe must be non-empty, unique, sorted, and canonical'))
  }
  if (request.universeSymbolHash !== sha256(request.universe.join(','))) {
    return Result.fail(failure('request', 'intraday universe hash does not match its canonical symbols'))
  }
  const requestedSymbols = intradaySnapshotSymbols(request)
  const canonicalSymbols = [...new Set(requestedSymbols)].sort()
  if (request.purpose !== undefined && !isIntradaySnapshotPurpose(request.purpose)) {
    return Result.fail(failure('request', 'intraday snapshot purpose is not supported'))
  }
  if (
    canonicalSymbols.length === 0 ||
    canonicalSymbols.length > canonicalUniverse.length ||
    canonicalSymbols.length !== requestedSymbols.length ||
    canonicalSymbols.some((symbol, index) => symbol !== requestedSymbols[index]) ||
    requestedSymbols.some((symbol) => !canonicalUniverse.includes(symbol))
  ) {
    return Result.fail(
      failure('request', 'intraday snapshot symbols must be a non-empty canonical subset of the bound universe'),
    )
  }
  if (request.purpose !== undefined && request.symbols === undefined) {
    return Result.fail(failure('request', 'quote-only snapshots require an explicit canonical symbol subset'))
  }
  if (request.candidateSymbols !== undefined) {
    const canonicalCandidates = [...new Set(request.candidateSymbols)].sort()
    if (
      request.purpose !== undefined ||
      request.symbols === undefined ||
      canonicalCandidates.length === 0 ||
      canonicalCandidates.length !== request.candidateSymbols.length ||
      canonicalCandidates.some((symbol, index) => symbol !== request.candidateSymbols?.[index]) ||
      canonicalCandidates.some((symbol) => !requestedSymbols.includes(symbol)) ||
      requestedSymbols.length - canonicalCandidates.length !== 1
    ) {
      return Result.fail(
        failure('request', 'independent candidates require a canonical decision subset and one mandatory benchmark'),
      )
    }
  }
  if (request.universeId.length === 0 || request.universeId.trim() !== request.universeId) {
    return Result.fail(failure('request', 'intraday universe ID must be non-empty and canonical'))
  }
  const sourceTopics = Object.values(request.sourceTopics)
  if (
    sourceTopics.some((topic) => !sourceTopicPattern.test(topic)) ||
    new Set(sourceTopics).size !== sourceTopics.length
  ) {
    return Result.fail(failure('request', 'intraday source topics must be non-empty, canonical, and distinct'))
  }
  const expectedDelayClass =
    request.feed === 'iex'
      ? 'real_time_exchange_only'
      : request.feed === 'sip'
        ? 'real_time_consolidated'
        : 'delayed_15m_consolidated'
  if (request.delayClass !== expectedDelayClass) {
    return Result.fail(failure('request', 'intraday feed and delay class do not match'))
  }
  const calendar = validateCalendar(request)
  if (Result.isFailure(calendar)) return Result.fail(calendar.failure)
  return Result.succeed(request)
}

export const verifyIntradaySnapshotQuery = (
  query: IntradaySnapshotQuery,
): Result.Result<IntradaySnapshotQuery, IntradaySnapshotFailure> =>
  Result.map(validateQuery(query), (verified) =>
    Object.freeze({
      ...verified,
      calendar: freezeCalendar(verified.calendar),
      universe: Object.freeze([...verified.universe]),
      ...(verified.symbols === undefined ? {} : { symbols: Object.freeze([...verified.symbols]) }),
      ...(verified.candidateSymbols === undefined
        ? {}
        : { candidateSymbols: Object.freeze([...verified.candidateSymbols]) }),
      sourceTopics: Object.freeze({ ...verified.sourceTopics }),
    }),
  )

const numberValue = (
  value: string | number,
  field: string,
  positive: boolean,
): Result.Result<number, IntradaySnapshotFailure> => {
  const parsed = typeof value === 'number' ? value : numericStringPattern.test(value) ? Number(value) : Number.NaN
  const valid = Number.isFinite(parsed) && (positive ? parsed > 0 : parsed >= 0)
  return valid
    ? Result.succeed(parsed)
    : Result.fail(failure('rows', `intraday ${field} must be ${positive ? 'positive' : 'non-negative'} and finite`))
}

const booleanValue = (value: 0 | 1 | '0' | '1'): boolean => value === 1 || value === '1'

const normalizeWatermark = (
  row: IntradayArchiveWatermarkRow,
): Result.Result<IntradayArchiveWatermark, IntradaySnapshotFailure> => {
  const sourcePartition = typeof row.source_partition === 'number' ? row.source_partition : Number(row.source_partition)
  const offset = row.inclusive_last_offset
  if (!Number.isSafeInteger(sourcePartition) || sourcePartition < 0 || sourcePartition > maximumNonNegativeInt32) {
    return Result.fail(failure('watermark', 'intraday archive watermark partition is outside Kafka Int32'))
  }
  if (!isCanonicalNonNegativeInt64(offset)) {
    return Result.fail(failure('watermark', 'intraday archive watermark offset must be a canonical Kafka Int64'))
  }
  return Result.succeed(
    Object.freeze({
      sourceTopic: row.source_topic,
      sourcePartition,
      inclusiveLastOffset: offset,
    }),
  )
}

const compareWatermarks = (left: IntradayArchiveWatermark, right: IntradayArchiveWatermark): number =>
  compareCanonicalText(left.sourceTopic, right.sourceTopic) || left.sourcePartition - right.sourcePartition

const validateWatermarks = (
  query: IntradaySnapshotQuery,
  watermarks: readonly IntradayArchiveWatermark[],
): Result.Result<readonly IntradayArchiveWatermark[], IntradaySnapshotFailure> => {
  const expectedTopics = Object.values(query.sourceTopics).toSorted(compareCanonicalText)
  const ordered = watermarks.toSorted(compareWatermarks)
  const seen = new Set<string>()
  for (const watermark of ordered) {
    if (!expectedTopics.includes(watermark.sourceTopic)) {
      return Result.fail(failure('watermark', 'intraday archive watermark names an unexpected source topic'))
    }
    if (
      !Number.isSafeInteger(watermark.sourcePartition) ||
      watermark.sourcePartition < 0 ||
      watermark.sourcePartition > maximumNonNegativeInt32 ||
      !isCanonicalNonNegativeInt64(watermark.inclusiveLastOffset)
    ) {
      return Result.fail(failure('watermark', 'intraday archive watermark is outside its canonical domain'))
    }
    const key = `${watermark.sourceTopic}\u0000${watermark.sourcePartition}`
    if (seen.has(key)) return Result.fail(failure('watermark', 'intraday archive watermark is duplicated', { key }))
    seen.add(key)
  }
  if (expectedTopics.some((topic) => !ordered.some((watermark) => watermark.sourceTopic === topic))) {
    return Result.fail(failure('watermark', 'intraday archive version does not cover every source topic'))
  }
  if (ordered.some((watermark, index) => watermark !== watermarks[index])) {
    return Result.fail(failure('watermark', 'intraday archive watermarks must use canonical topic-partition order'))
  }
  return Result.succeed(Object.freeze(ordered))
}

export const verifyIntradayArchiveWatermarks = (
  query: IntradaySnapshotQuery,
  rows: readonly unknown[],
): Result.Result<readonly IntradayArchiveWatermark[], IntradaySnapshotFailure> =>
  Result.gen(function* () {
    yield* validateQuery(query)
    const decoded = yield* decodeIntradayArchiveWatermarkRows(rows)
    const watermarks = yield* Result.all(decoded.map(normalizeWatermark))
    return yield* validateWatermarks(query, watermarks)
  })

export const verifyIntradaySnapshotRequest = (
  request: IntradaySnapshotRequest,
): Result.Result<IntradaySnapshotRequest, IntradaySnapshotFailure> =>
  Result.gen(function* () {
    yield* validateQuery(request)
    yield* validateWatermarks(request, request.archiveWatermarks)
    return Object.freeze({
      ...request,
      calendar: freezeCalendar(request.calendar),
      universe: Object.freeze([...request.universe]),
      ...(request.symbols === undefined ? {} : { symbols: Object.freeze([...request.symbols]) }),
      ...(request.candidateSymbols === undefined
        ? {}
        : { candidateSymbols: Object.freeze([...request.candidateSymbols]) }),
      sourceTopics: Object.freeze({ ...request.sourceTopics }),
      archiveWatermarks: Object.freeze(request.archiveWatermarks.map((watermark) => Object.freeze({ ...watermark }))),
    })
  })

const recordIdentity = (
  row: IntradayBarRow | IntradayQuoteRow | IntradayTradeRow,
): Result.Result<IntradayRecordIdentity, IntradaySnapshotFailure> => {
  const sourcePartition = typeof row.source_partition === 'number' ? row.source_partition : Number(row.source_partition)
  if (!Number.isSafeInteger(sourcePartition) || sourcePartition < 0 || sourcePartition > maximumNonNegativeInt32) {
    return Result.fail(failure('lineage', 'intraday source partition must be a non-negative Kafka Int32'))
  }
  if (!isCanonicalNonNegativeInt64(row.source_offset)) {
    return Result.fail(failure('lineage', 'intraday source offset must be a canonical Kafka Int64'))
  }
  return Result.succeed({
    provider: row.provider,
    universeId: row.universe_id,
    universeSymbolHash: row.universe_symbol_hash,
    feed: row.feed,
    marketSession: row.market_session,
    delayClass: row.delay_class,
    symbol: row.symbol,
    eventAt: row.event_at,
    ingestedAt: row.ingested_at,
    sourceTopic: row.source_topic,
    sourcePartition,
    sourceOffset: row.source_offset,
    schemaVersion: 1,
  })
}

export const normalizeBar = (row: IntradayBarRow): Result.Result<IntradayBar, IntradaySnapshotFailure> =>
  Result.gen(function* () {
    const identity = yield* recordIdentity(row)
    const open = yield* numberValue(row.open, 'bar open', true)
    const high = yield* numberValue(row.high, 'bar high', true)
    const low = yield* numberValue(row.low, 'bar low', true)
    const close = yield* numberValue(row.close, 'bar close', true)
    const volume = yield* numberValue(row.volume, 'bar volume', false)
    const vwap = row.vwap === null ? null : yield* numberValue(row.vwap, 'bar VWAP', true)
    if (row.trade_count !== null && !isCanonicalNonNegativeInt64(row.trade_count)) {
      return yield* Result.fail(failure('rows', 'intraday bar trade count must be a canonical non-negative Int64'))
    }
    if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) {
      return yield* Result.fail(failure('rows', 'intraday bar OHLC values are inconsistent'))
    }
    if (vwap !== null && (vwap < low || vwap > high)) {
      return yield* Result.fail(failure('rows', 'intraday bar VWAP must remain within its low/high range'))
    }
    return Object.freeze({
      ...identity,
      channel: row.channel,
      final: booleanValue(row.is_final),
      open,
      high,
      low,
      close,
      volume,
      vwap,
      tradeCount: row.trade_count,
    })
  })

export const normalizeQuote = (row: IntradayQuoteRow): Result.Result<IntradayQuote, IntradaySnapshotFailure> =>
  Result.gen(function* () {
    const identity = yield* recordIdentity(row)
    const bidPrice = yield* numberValue(row.bid_price, 'quote bid price', true)
    const bidSize = yield* numberValue(row.bid_size, 'quote bid size', false)
    const askPrice = yield* numberValue(row.ask_price, 'quote ask price', true)
    const askSize = yield* numberValue(row.ask_size, 'quote ask size', false)
    if (bidPrice > askPrice) return yield* Result.fail(failure('rows', 'intraday quote is crossed'))
    return Object.freeze({ ...identity, bidPrice, bidSize, askPrice, askSize })
  })

export const normalizeTrade = (row: IntradayTradeRow): Result.Result<IntradayTrade, IntradaySnapshotFailure> =>
  Result.gen(function* () {
    const identity = yield* recordIdentity(row)
    const price = yield* numberValue(row.price, 'trade price', true)
    const size = yield* numberValue(row.size, 'trade size', true)
    return Object.freeze({ ...identity, price, size })
  })

const compareOffsets = (left: string, right: string): number => {
  const leftOffset = BigInt(left)
  const rightOffset = BigInt(right)
  if (leftOffset < rightOffset) return -1
  if (leftOffset > rightOffset) return 1
  return 0
}

export const compareRecords = (
  left: IntradayBar | IntradayQuote | IntradayTrade,
  right: IntradayBar | IntradayQuote | IntradayTrade,
): number =>
  compareIntradayInstants(left.eventAt, right.eventAt) ||
  compareCanonicalText(left.symbol, right.symbol) ||
  compareCanonicalText(left.sourceTopic, right.sourceTopic) ||
  left.sourcePartition - right.sourcePartition ||
  compareOffsets(left.sourceOffset, right.sourceOffset)

export const validateIdentity = (
  request: IntradaySnapshotQuery,
  records: readonly (IntradayBar | IntradayQuote | IntradayTrade)[],
  eventWindowEndAt: string,
  inclusiveEnd: boolean,
  sourceWatermarks?: readonly IntradayArchiveWatermark[],
  clockSkewMs = 0,
): Result.Result<void, IntradaySnapshotFailure> => {
  const symbols = new Set(intradaySnapshotSymbols(request))
  const watermarkByPartition = new Map(
    (sourceWatermarks ?? []).map((watermark) => [
      `${watermark.sourceTopic}\u0000${watermark.sourcePartition}`,
      BigInt(watermark.inclusiveLastOffset),
    ]),
  )
  const start = intradayInstantNanos(request.rangeStartAt)
  const eventEnd = intradayInstantNanos(eventWindowEndAt)
  const observed = intradayInstantNanos(request.observedAt)
  for (const record of records) {
    if (
      record.universeId !== request.universeId ||
      record.universeSymbolHash !== request.universeSymbolHash ||
      record.feed !== request.feed ||
      record.delayClass !== request.delayClass ||
      !symbols.has(record.symbol)
    ) {
      return Result.fail(
        failure('identity', 'intraday row identity does not match the requested feed and universe', {
          symbol: record.symbol,
          sourceTopic: record.sourceTopic,
          sourcePartition: record.sourcePartition,
          sourceOffset: record.sourceOffset,
        }),
      )
    }
    const eventAt = intradayInstantNanos(record.eventAt)
    const ingestedAt = intradayInstantNanos(record.ingestedAt)
    const eventAfterWindow = inclusiveEnd ? eventAt > eventEnd : eventAt >= eventEnd
    const watermark = watermarkByPartition.get(`${record.sourceTopic}\u0000${record.sourcePartition}`)
    if (
      eventAt < start ||
      eventAfterWindow ||
      ingestedAt + millisecondsAsNanos(clockSkewMs) < eventAt ||
      ingestedAt > observed + millisecondsAsNanos(clockSkewMs) ||
      (sourceWatermarks !== undefined && (watermark === undefined || BigInt(record.sourceOffset) > watermark))
    ) {
      return Result.fail(
        failure('ordering', 'intraday row falls outside the event-time and ingestion-time bounds', {
          symbol: record.symbol,
          sourceTopic: record.sourceTopic,
          sourcePartition: record.sourcePartition,
          sourceOffset: record.sourceOffset,
          eventAt: record.eventAt,
          ingestedAt: record.ingestedAt,
          watermark: watermark === undefined ? null : String(watermark),
        }),
      )
    }
  }
  return Result.succeed(undefined)
}

export const validateBarStructure = (
  request: IntradaySnapshotQuery,
  bars: readonly IntradayBar[],
  clockSkewMs = 0,
): Result.Result<void, IntradaySnapshotFailure> => {
  const rangeStart = intradayInstantNanos(request.rangeStartAt)
  const minuteNanos = millisecondsAsNanos(minuteMs)
  const rangeMinutes = (epoch(request.rangeEndAt) - epoch(request.rangeStartAt)) / minuteMs
  const maximumCount = intradaySnapshotSymbols(request).length * rangeMinutes
  const minimumAvailabilityDelay = millisecondsAsNanos(
    (request.delayClass === 'delayed_15m_consolidated' ? 15 * minuteMs : 0) + minuteMs - clockSkewMs,
  )
  const observed = new Set<string>()
  for (const bar of bars) {
    if (!bar.final) {
      return Result.fail(
        failure('freshness', 'intraday snapshot contains a non-final bar revision', {
          symbol: bar.symbol,
          eventAt: bar.eventAt,
          sourceOffset: bar.sourceOffset,
        }),
      )
    }
    if (intradayAgeNanos(bar.ingestedAt, bar.eventAt) < minimumAvailabilityDelay) {
      return Result.fail(
        new IntradaySnapshotFailure({
          reason: 'freshness',
          message: 'intraday bar does not match its declared feed delay and finalization window',
          ingestionDelayDirection: IntradayIngestionDelayDirection.BelowMinimum,
          facts: {
            symbol: bar.symbol,
            sourceTopic: bar.sourceTopic,
            delayClass: request.delayClass,
            eventAt: bar.eventAt,
            ingestedAt: bar.ingestedAt,
          },
        }),
      )
    }
    const eventAt = intradayInstantNanos(bar.eventAt)
    if ((eventAt - rangeStart) % minuteNanos !== 0n) {
      return Result.fail(
        failure('coverage', 'intraday bar is not aligned to the requested one-minute grid', {
          symbol: bar.symbol,
          eventAt: bar.eventAt,
        }),
      )
    }
    const key = `${bar.symbol}\u0000${eventAt}`
    if (observed.has(key)) {
      return Result.fail(
        failure('coverage', 'intraday snapshot duplicates a one-minute bar', {
          symbol: bar.symbol,
          eventAt: bar.eventAt,
        }),
      )
    }
    observed.add(key)
  }
  if (bars.length > maximumCount) {
    return Result.fail(
      failure('coverage', 'intraday snapshot exceeds the requested one-minute bar grid', {
        maximumCount,
        observedCount: bars.length,
      }),
    )
  }
  return Result.succeed(undefined)
}

export const validateBarCoverage = (
  request: IntradaySnapshotQuery,
  bars: readonly IntradayBar[],
  clockSkewMs = 0,
): Result.Result<void, IntradaySnapshotFailure> => {
  const feedDelayMs = request.delayClass === 'delayed_15m_consolidated' ? 15 * minuteMs : 0
  const maximumAvailabilityDelay = millisecondsAsNanos(feedDelayMs + minuteMs + request.maximumQuoteAgeMs + clockSkewMs)
  for (const bar of bars) {
    if (intradayAgeNanos(bar.ingestedAt, bar.eventAt) > maximumAvailabilityDelay) {
      return Result.fail(
        new IntradaySnapshotFailure({
          reason: 'freshness',
          message: 'intraday bar does not match its declared feed delay and finalization window',
          ingestionDelayDirection: IntradayIngestionDelayDirection.AboveMaximum,
          facts: {
            symbol: bar.symbol,
            sourceTopic: bar.sourceTopic,
            delayClass: request.delayClass,
            eventAt: bar.eventAt,
            ingestedAt: bar.ingestedAt,
          },
        }),
      )
    }
  }
  if (request.purpose === undefined) {
    const completionEventAt = intradayInstantNanos(request.rangeEndAt) - millisecondsAsNanos(minuteMs)
    for (const symbol of intradaySnapshotSymbols(request)) {
      if (!bars.some((bar) => bar.symbol === symbol && intradayInstantNanos(bar.eventAt) === completionEventAt)) {
        return Result.fail(
          failure('not-ready', 'intraday snapshot lacks a per-symbol range-completion bar', {
            symbol,
            eventAt: new Date(epoch(request.rangeEndAt) - minuteMs).toISOString(),
          }),
        )
      }
    }
  }
  return Result.succeed(undefined)
}

export const validateSourceTopics = (
  request: IntradaySnapshotQuery,
  bars: readonly IntradayBar[],
  quotes: readonly IntradayQuote[],
  trades: readonly IntradayTrade[],
): Result.Result<void, IntradaySnapshotFailure> => {
  const mismatched = [
    ...bars.filter((record) => record.sourceTopic !== request.sourceTopics.bars),
    ...quotes.filter((record) => record.sourceTopic !== request.sourceTopics.quotes),
    ...trades.filter((record) => record.sourceTopic !== request.sourceTopics.trades),
  ][0]
  return mismatched === undefined
    ? Result.succeed(undefined)
    : Result.fail(
        failure('identity', 'intraday row came from an unexpected source topic', {
          sourceTopic: mismatched.sourceTopic,
          sourcePartition: mismatched.sourcePartition,
          sourceOffset: mismatched.sourceOffset,
        }),
      )
}

const validateArchiveProgress = (
  requested: readonly IntradayArchiveWatermark[],
  actual: readonly IntradayArchiveWatermark[],
): Result.Result<void, IntradaySnapshotFailure> => {
  const watermarkKey = (watermark: IntradayArchiveWatermark): string =>
    `${watermark.sourceTopic}\u0000${watermark.sourcePartition}`
  const actualByPartition = new Map(actual.map((watermark) => [watermarkKey(watermark), watermark]))
  const missingPartitions = requested.filter((watermark) => !actualByPartition.has(watermarkKey(watermark)))
  if (missingPartitions.length > 0) {
    return Result.fail(
      failure('watermark', 'intraday archive partition topology changed after version capture', {
        missingPartitions: missingPartitions.map(({ sourceTopic, sourcePartition }) => ({
          sourceTopic,
          sourcePartition,
        })),
      }),
    )
  }
  const requestedPartitions = new Set(requested.map(watermarkKey))
  const addedPartitions = actual.filter((watermark) => !requestedPartitions.has(watermarkKey(watermark)))
  if (addedPartitions.length > 0) {
    return Result.fail(
      failure('not-ready', 'intraday archive gained partitions after version capture', {
        addedPartitions: addedPartitions.map(({ sourceTopic, sourcePartition }) => ({ sourceTopic, sourcePartition })),
      }),
    )
  }
  for (const expected of requested) {
    const observed = actualByPartition.get(watermarkKey(expected))
    if (observed === undefined) {
      return Result.fail(failure('watermark', 'intraday archive partition topology changed after version capture'))
    }
    if (BigInt(observed.inclusiveLastOffset) < BigInt(expected.inclusiveLastOffset)) {
      return Result.fail(
        failure('watermark', 'intraday archive has not materialized the captured source offset', {
          sourceTopic: expected.sourceTopic,
          sourcePartition: expected.sourcePartition,
          expectedOffset: expected.inclusiveLastOffset,
          observedOffset: observed.inclusiveLastOffset,
        }),
      )
    }
  }
  return Result.succeed(undefined)
}

export const latestQuotes = (
  request: IntradaySnapshotQuery,
  quotes: readonly IntradayQuote[],
  trades: readonly IntradayTrade[],
  clockSkewMs = 0,
): Result.Result<Readonly<Record<string, IntradayQuote>>, IntradaySnapshotFailure> => {
  const latest: Record<string, IntradayQuote> = {}
  const latestTrades: Record<string, IntradayTrade> = {}
  for (const quote of quotes) latest[quote.symbol] = quote
  for (const trade of trades) latestTrades[trade.symbol] = trade
  const expectedDelayMs = request.delayClass === 'delayed_15m_consolidated' ? 15 * minuteMs : 0
  const minimumDelay = millisecondsAsNanos(expectedDelayMs) - BigInt(clockSkewMs) * 1_000_000n
  const maximumDelay = millisecondsAsNanos(expectedDelayMs + request.maximumQuoteAgeMs + clockSkewMs)
  // Bind complete post-range evidence here. Executable freshness is symbol-local and is enforced by the strategy
  // before selection; sparse IEX activity for one symbol must not invalidate fresh evidence for another symbol.
  for (const symbol of intradaySnapshotSymbols(request)) {
    const quote = latest[symbol]
    const trade = latestTrades[symbol]
    if (quote === undefined || intradayInstantNanos(quote.eventAt) < intradayInstantNanos(request.rangeEndAt)) {
      return Result.fail(
        failure('not-ready', 'intraday snapshot lacks a post-range quote for every symbol', {
          symbol,
        }),
      )
    }
    if (
      request.purpose === undefined &&
      (trade === undefined || intradayInstantNanos(trade.eventAt) < intradayInstantNanos(request.rangeEndAt))
    ) {
      return Result.fail(
        failure('not-ready', 'intraday snapshot lacks a post-range trade for every symbol', { symbol }),
      )
    }
    for (const evidence of request.purpose === undefined ? [quote, trade] : [quote]) {
      if (evidence === undefined) continue
      const availabilityDelay = intradayAgeNanos(evidence.ingestedAt, evidence.eventAt)
      if (availabilityDelay < minimumDelay || availabilityDelay > maximumDelay) {
        return Result.fail(
          new IntradaySnapshotFailure({
            reason: 'freshness',
            message: 'intraday evidence does not match its declared feed delay',
            ingestionDelayDirection:
              availabilityDelay < minimumDelay
                ? IntradayIngestionDelayDirection.BelowMinimum
                : IntradayIngestionDelayDirection.AboveMaximum,
            facts: {
              symbol,
              sourceTopic: evidence.sourceTopic,
              delayClass: request.delayClass,
              eventAt: evidence.eventAt,
              ingestedAt: evidence.ingestedAt,
            },
          }),
        )
      }
    }
  }
  return Result.succeed(Object.freeze(latest))
}

export const lineageOf = (
  records: readonly (IntradayBar | IntradayQuote | IntradayTrade)[],
): Result.Result<readonly IntradayLineage[], IntradaySnapshotFailure> => {
  const groups = new Map<string, { topic: string; partition: number; offsets: bigint[] }>()
  const seen = new Set<string>()
  for (const record of records) {
    const identity = `${record.sourceTopic}\u0000${record.sourcePartition}\u0000${record.sourceOffset}`
    if (seen.has(identity)) {
      return Result.fail(failure('lineage', 'intraday snapshot repeats a Kafka record identity', { identity }))
    }
    seen.add(identity)
    const key = `${record.sourceTopic}\u0000${record.sourcePartition}`
    const group = groups.get(key) ?? { topic: record.sourceTopic, partition: record.sourcePartition, offsets: [] }
    group.offsets.push(BigInt(record.sourceOffset))
    groups.set(key, group)
  }
  const lineage: IntradayLineage[] = []
  for (const group of [...groups.values()].sort(
    (left, right) => compareCanonicalText(left.topic, right.topic) || left.partition - right.partition,
  )) {
    const offsets = group.offsets.toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    const firstOffset = offsets[0]
    const lastOffset = offsets.at(-1)
    if (firstOffset === undefined || lastOffset === undefined) {
      return Result.fail(failure('lineage', 'intraday lineage group cannot be empty'))
    }
    lineage.push(
      Object.freeze({
        sourceTopic: group.topic,
        sourcePartition: group.partition,
        firstOffset: String(firstOffset),
        lastOffset: String(lastOffset),
        recordCount: offsets.length,
      }),
    )
  }
  return Result.succeed(Object.freeze(lineage))
}

const hash = (value: unknown, label: string): Result.Result<string, IntradaySnapshotFailure> =>
  Result.mapError(canonicalHashV1Result(value), (cause) =>
    failure('hash', `intraday ${label} is not canonically hashable`, undefined, cause),
  )

export interface IntradaySnapshotRows {
  readonly archiveWatermarks: readonly unknown[]
  readonly bars: readonly unknown[]
  readonly quotes: readonly unknown[]
  readonly trades: readonly unknown[]
}

export type PersistedIntradaySnapshotRows = Omit<IntradaySnapshotRows, 'archiveWatermarks'>

export const candidateAvailability = (
  request: IntradaySnapshotQuery,
  bars: readonly IntradayBar[],
  quotes: readonly IntradayQuote[],
  trades: readonly IntradayTrade[],
  clockSkewMs = 0,
): Result.Result<
  {
    readonly latest: Readonly<Record<string, IntradayQuote>>
    readonly exclusions: readonly IntradayCandidateExclusion[]
  },
  IntradaySnapshotFailure
> =>
  Result.gen(function* () {
    const candidates = new Set(request.candidateSymbols)
    const exclusions: IntradayCandidateExclusion[] = []
    const latest: Record<string, IntradayQuote> = {}
    for (const quote of quotes) latest[quote.symbol] = quote
    for (const symbol of intradaySnapshotSymbols(request)) {
      const symbolRequest = { ...request, symbols: [symbol] }
      const available = Result.flatMap(
        validateBarCoverage(
          symbolRequest,
          bars.filter((bar) => bar.symbol === symbol),
          clockSkewMs,
        ),
        () =>
          latestQuotes(
            symbolRequest,
            quotes.filter((quote) => quote.symbol === symbol),
            trades.filter((trade) => trade.symbol === symbol),
            clockSkewMs,
          ),
      )
      if (Result.isSuccess(available)) continue
      const cause = available.failure
      if (
        candidates.has(symbol) &&
        (cause.reason === 'not-ready' ||
          (cause.reason === 'freshness' &&
            cause.ingestionDelayDirection === IntradayIngestionDelayDirection.AboveMaximum))
      ) {
        exclusions.push(Object.freeze({ symbol, reason: cause.reason, message: cause.message }))
      } else {
        return yield* Result.fail(cause)
      }
    }
    return { latest: Object.freeze(latest), exclusions: Object.freeze(exclusions) }
  })

export const verifyIntradaySnapshot = (
  request: IntradaySnapshotRequest,
  rows: IntradaySnapshotRows,
): Result.Result<IntradayMarketSnapshot, IntradaySnapshotFailure> =>
  Result.gen(function* () {
    const verifiedRequest = yield* verifyIntradaySnapshotRequest(request)
    const actualWatermarks = yield* verifyIntradayArchiveWatermarks(verifiedRequest, rows.archiveWatermarks)
    yield* validateArchiveProgress(verifiedRequest.archiveWatermarks, actualWatermarks)
    const decoded = yield* Result.all({
      bars: decodeIntradayBarRows(rows.bars),
      quotes: decodeIntradayQuoteRows(rows.quotes),
      trades: decodeIntradayTradeRows(rows.trades),
    })
    const session = verifiedRequest.calendar.sessions.find(({ date }) => date === verifiedRequest.sessionDate)
    if (session === undefined) {
      return yield* Result.fail(failure('request', 'intraday snapshot has no bound exchange session'))
    }
    const bars = Object.freeze((yield* Result.all(decoded.bars.map(normalizeBar))).toSorted(compareRecords))
    const quotes = Object.freeze((yield* Result.all(decoded.quotes.map(normalizeQuote))).toSorted(compareRecords))
    const trades = Object.freeze((yield* Result.all(decoded.trades.map(normalizeTrade))).toSorted(compareRecords))
    const allRecords = [...bars, ...quotes, ...trades].toSorted(compareRecords)
    yield* validateSourceTopics(verifiedRequest, bars, quotes, trades)
    yield* validateIdentity(verifiedRequest, bars, verifiedRequest.rangeEndAt, false, verifiedRequest.archiveWatermarks)
    yield* validateIdentity(
      verifiedRequest,
      [...quotes, ...trades],
      session.closeAt,
      true,
      verifiedRequest.archiveWatermarks,
    )
    yield* validateBarStructure(verifiedRequest, bars)
    const lineage = yield* lineageOf(allRecords)
    const minimumFeedDelay = millisecondsAsNanos(
      verifiedRequest.delayClass === 'delayed_15m_consolidated' ? 15 * minuteMs : 0,
    )
    for (const evidence of [...quotes, ...trades]) {
      if (intradayAgeNanos(evidence.ingestedAt, evidence.eventAt) < minimumFeedDelay) {
        return yield* Result.fail(
          new IntradaySnapshotFailure({
            reason: 'freshness',
            message: 'intraday evidence does not match its declared feed delay',
            ingestionDelayDirection: IntradayIngestionDelayDirection.BelowMinimum,
            facts: {
              symbol: evidence.symbol,
              sourceTopic: evidence.sourceTopic,
              delayClass: verifiedRequest.delayClass,
              eventAt: evidence.eventAt,
              ingestedAt: evidence.ingestedAt,
            },
          }),
        )
      }
    }
    const availability =
      verifiedRequest.candidateSymbols === undefined
        ? yield* Result.flatMap(validateBarCoverage(verifiedRequest, bars), () =>
            Result.map(latestQuotes(verifiedRequest, quotes, trades), (latest) => ({ latest, exclusions: [] })),
          )
        : yield* candidateAvailability(verifiedRequest, bars, quotes, trades)
    const barsContentHash = yield* hash(bars, 'bars')
    const quotesContentHash = yield* hash(quotes, 'quotes')
    const tradesContentHash = yield* hash(trades, 'trades')
    const archiveWatermarks = Object.freeze(
      verifiedRequest.archiveWatermarks.map((watermark) => Object.freeze({ ...watermark })),
    )
    const material = {
      schemaVersion: 'bayn.intraday-market-snapshot.v1',
      sessionDate: verifiedRequest.sessionDate,
      calendar: verifiedRequest.calendar,
      rangeStartAt: verifiedRequest.rangeStartAt,
      rangeEndAt: verifiedRequest.rangeEndAt,
      observedAt: verifiedRequest.observedAt,
      universeId: verifiedRequest.universeId,
      universeSymbolHash: verifiedRequest.universeSymbolHash,
      ...(verifiedRequest.symbols === undefined ? {} : { universe: Object.freeze([...verifiedRequest.universe]) }),
      symbols: Object.freeze([...intradaySnapshotSymbols(verifiedRequest)]),
      ...(verifiedRequest.purpose === undefined ? {} : { purpose: verifiedRequest.purpose }),
      ...(verifiedRequest.candidateSymbols === undefined
        ? {}
        : {
            candidateSymbols: verifiedRequest.candidateSymbols,
            candidateExclusions: availability.exclusions,
          }),
      feed: verifiedRequest.feed,
      delayClass: verifiedRequest.delayClass,
      sourceTopics: Object.freeze({ ...verifiedRequest.sourceTopics }),
      archiveWatermarks,
      maximumQuoteAgeMs: verifiedRequest.maximumQuoteAgeMs,
      minimumWatermarkLagMs: verifiedRequest.minimumWatermarkLagMs,
      barCount: bars.length,
      quoteCount: quotes.length,
      tradeCount: trades.length,
      barsContentHash,
      quotesContentHash,
      tradesContentHash,
      lineage,
    } as const
    const contentHash = yield* hash(material, 'snapshot content')
    const snapshotId = yield* hash({ ...material, contentHash }, 'snapshot identity')
    const manifest: IntradaySnapshotManifest = Object.freeze({ ...material, contentHash, snapshotId })
    return Object.freeze({ bars, quotes, trades, latestQuotes: availability.latest, manifest })
  })

const archiveIdentityRow = (record: IntradayRecordIdentity) => ({
  provider: record.provider,
  universe_id: record.universeId,
  universe_symbol_hash: record.universeSymbolHash,
  feed: record.feed,
  market_session: record.marketSession,
  delay_class: record.delayClass,
  symbol: record.symbol,
  event_at: record.eventAt,
  ingested_at: record.ingestedAt,
  source_topic: record.sourceTopic,
  source_partition: record.sourcePartition,
  source_offset: record.sourceOffset,
  schema_version: record.schemaVersion,
})

const validateReplayEventTimestamp = (
  record: IntradayQuote | IntradayTrade,
): Result.Result<void, IntradaySnapshotFailure> =>
  Result.try({
    try: () => void intradayInstantNanos(record.eventAt),
    catch: (cause) =>
      failure('rows', 'intraday quote or trade timestamp does not match the archive contract', undefined, cause),
  })

const validateReplayPayload = <T extends IntradayQuote | IntradayTrade>(
  record: T,
  payload: (record: T) => readonly number[],
): Result.Result<void, IntradaySnapshotFailure> =>
  Result.try({
    try: () => void JSON.stringify(payload(record)),
    catch: (cause) =>
      failure('rows', 'intraday quote or trade payload does not match the archive contract', undefined, cause),
  })

const validateReplayCandidates = <T extends IntradayQuote | IntradayTrade>(
  records: readonly T[],
  recordKind: 'quote' | 'trade',
  payload: (record: T) => readonly number[],
): Result.Result<void, IntradaySnapshotFailure> =>
  Result.gen(function* () {
    const observedSymbols = new Set<string>()
    for (const record of records) {
      yield* validateReplayEventTimestamp(record)
      yield* validateReplayPayload(record, payload)
      if (observedSymbols.has(record.symbol)) {
        return yield* Result.fail(
          failure('rows', `intraday replay snapshot contains more than one ${recordKind} candidate for a symbol`, {
            symbol: record.symbol,
          }),
        )
      }
      observedSymbols.add(record.symbol)
    }
    return undefined
  })

const replaySnapshotEnvelope = (snapshot: unknown): Result.Result<IntradayMarketSnapshot, IntradaySnapshotFailure> =>
  decodeReplaySnapshotEnvelope(snapshot).pipe(
    Result.map(() => snapshot as IntradayMarketSnapshot),
    Result.mapError((cause) =>
      failure('rows', 'intraday replay snapshot and manifest do not match the archive contract', undefined, cause),
    ),
  )

const replayedBarRow = (bar: IntradayBar): Result.Result<IntradayBarRow, IntradaySnapshotFailure> =>
  Result.gen(function* () {
    const candidate = yield* Result.try({
      try: () => ({
        ...archiveIdentityRow(bar),
        channel: bar.channel,
        is_final: bar.final ? 1 : 0,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        vwap: bar.vwap,
        trade_count: bar.tradeCount,
      }),
      catch: (cause) => failure('rows', 'intraday replayed bar does not match the archive contract', undefined, cause),
    })
    const decoded = yield* decodeIntradayBarRows([candidate]).pipe(
      Result.mapError((cause) =>
        failure('rows', 'intraday replayed bar does not match the archive contract', undefined, cause),
      ),
    )
    const row = decoded[0]
    return row === undefined
      ? yield* Result.fail(failure('rows', 'intraday replayed bar does not match the archive contract'))
      : row
  })

export const persistIntradayRecordRows = (
  snapshot: Pick<IntradayMarketSnapshot, 'bars' | 'quotes' | 'trades'>,
): Result.Result<PersistedIntradaySnapshotRows, IntradaySnapshotFailure> =>
  Result.gen(function* () {
    const collections = snapshot
    const bars = yield* Result.all(collections.bars.map(replayedBarRow))
    yield* validateReplayCandidates(collections.quotes, 'quote', (quote) => [
      quote.bidPrice,
      quote.bidSize,
      quote.askPrice,
      quote.askSize,
    ])
    yield* validateReplayCandidates(collections.trades, 'trade', (trade) => [trade.price, trade.size])
    return {
      bars,
      quotes: collections.quotes.map((quote) => ({
        ...archiveIdentityRow(quote),
        bid_price: quote.bidPrice,
        bid_size: quote.bidSize,
        ask_price: quote.askPrice,
        ask_size: quote.askSize,
      })),
      trades: collections.trades.map((trade) => ({
        ...archiveIdentityRow(trade),
        price: trade.price,
        size: trade.size,
      })),
    }
  })

export const persistIntradaySnapshotRows = (
  snapshot: IntradayMarketSnapshot,
): Result.Result<PersistedIntradaySnapshotRows, IntradaySnapshotFailure> =>
  replaySnapshotEnvelope(snapshot).pipe(Result.flatMap(persistIntradayRecordRows))

/**
 * Re-enters an already materialized snapshot through the authoritative row
 * verifier. This is intentionally stronger than rehashing caller-provided
 * payloads: every archive, identity, ordering, coverage, freshness, and
 * lineage invariant is evaluated again before replay or execution.
 */
export const reverifyIntradayMarketSnapshot = (
  snapshot: IntradayMarketSnapshot,
): Result.Result<IntradayMarketSnapshot, IntradaySnapshotFailure> =>
  Result.gen(function* () {
    const replay = yield* replaySnapshotEnvelope(snapshot)
    const { manifest } = replay
    const rows = yield* persistIntradaySnapshotRows(replay)
    const request: IntradaySnapshotRequest = {
      sessionDate: manifest.sessionDate,
      calendar: manifest.calendar,
      rangeStartAt: manifest.rangeStartAt,
      rangeEndAt: manifest.rangeEndAt,
      observedAt: manifest.observedAt,
      universeId: manifest.universeId,
      universeSymbolHash: manifest.universeSymbolHash,
      universe: manifest.universe ?? manifest.symbols,
      ...(manifest.universe === undefined ? {} : { symbols: manifest.symbols }),
      ...(manifest.purpose === undefined ? {} : { purpose: manifest.purpose }),
      ...(manifest.candidateSymbols === undefined ? {} : { candidateSymbols: manifest.candidateSymbols }),
      feed: manifest.feed,
      delayClass: manifest.delayClass,
      sourceTopics: manifest.sourceTopics,
      maximumQuoteAgeMs: manifest.maximumQuoteAgeMs,
      minimumWatermarkLagMs: manifest.minimumWatermarkLagMs,
      archiveWatermarks: manifest.archiveWatermarks,
    }
    const verified = yield* verifyIntradaySnapshot(request, {
      archiveWatermarks: manifest.archiveWatermarks.map((watermark) => ({
        source_topic: watermark.sourceTopic,
        source_partition: watermark.sourcePartition,
        inclusive_last_offset: watermark.inclusiveLastOffset,
      })),
      ...rows,
    })
    const boundHashes = yield* Result.all({
      expectedManifest: hash(verified.manifest, 'reverified manifest'),
      actualManifest: hash(manifest, 'bound manifest'),
      expectedLatestQuotes: hash(verified.latestQuotes, 'reverified latest quotes'),
      actualLatestQuotes: hash(replay.latestQuotes, 'bound latest quotes'),
    })
    if (
      boundHashes.expectedManifest !== boundHashes.actualManifest ||
      boundHashes.expectedLatestQuotes !== boundHashes.actualLatestQuotes
    ) {
      return yield* Result.fail(failure('hash', 'intraday snapshot does not match authoritative row verification'))
    }
    return verified
  })
