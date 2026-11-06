import { createHash } from 'node:crypto'
import { BigDecimal, Result, Schema } from 'effect'

import { NonNegativeIntegerSchema, Sha256Schema, StrictNonEmptyStringSchema, UnsignedMicrosSchema } from '../../schemas'
import { MarketFeatureFailure } from '../features/feature-core'
import { marketFeatureClockSkewAllowanceMs } from '../features/contract'
import { intradayInstantNanos } from '../intraday/time'
import { WebullRequestState, WebullSession, WebullSymbolSchema, webullPriceFields } from '../webull-contract'
import { canonicalRawTimestamp, type KafkaMarketRecord } from './raw-events'

export enum WebullCaptureKind {
  Bars = 'BARS',
  Gap = 'GAP',
  Ignored = 'IGNORED',
}

const TimeMs = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 253402300799999 }))
const SourceSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('http'),
    endpoint: Schema.Literals([
      '/trading/instruments/stocks/profiles/list',
      '/market-data/stocks/bars/list',
      '/market-data/stocks/depths/list',
    ]),
    requestedSymbols: Schema.Array(WebullSymbolSchema).check(Schema.isMaxLength(20), Schema.isUnique()),
    requestBody: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal('mqtt'),
    sessionId: Schema.String.check(Schema.isUUID()),
    topic: Schema.Literals(['quote', 'tick', 'notice']),
  }),
  Schema.Struct({
    type: Schema.Literal('collector'),
    operation: Schema.Literals(['catalog', 'subscriptions', 'coverage', 'gap']),
  }),
])
const EnvelopeSchema = Schema.Struct({
  version: Schema.Literal(1),
  provider: Schema.Literal('webull'),
  feed: Schema.Literal('nasdaq_basic'),
  captureId: Schema.String.check(Schema.isUUID()),
  receivedAt: Schema.String,
  source: SourceSchema,
  payloadBase64: Schema.String.check(Schema.isMaxLength(5592408)),
  payloadSha256: Sha256Schema,
})
interface WebullCaptureReceipt {
  readonly captureId: string
  readonly receivedAt: string
  readonly payloadSha256: string
  readonly recordHash: string
  readonly sourceTopic: string
  readonly sourcePartition: number
  readonly sourceOffset: string
}
export type WebullMinuteBar = Pick<
  (typeof BodySchema.Type)['result'][number]['result'][number],
  'open' | 'high' | 'low' | 'close' | 'volume'
> & {
  readonly symbol: string
  readonly startMs: number
  readonly session: WebullSession
}
interface WebullBarRequest {
  readonly symbol: string
  readonly state: WebullRequestState
  readonly observations: number
  readonly excluded: number
}
const GapSchema = Schema.Struct({
  channel: Schema.String,
  symbols: Schema.optionalKey(Schema.Array(WebullSymbolSchema)),
  reason: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
})
export type DecodedWebullCapture =
  | {
      readonly kind: WebullCaptureKind.Bars
      readonly receipt: WebullCaptureReceipt
      readonly bars: readonly WebullMinuteBar[]
      readonly requests: readonly WebullBarRequest[]
    }
  | {
      readonly kind: WebullCaptureKind.Gap
      readonly receipt: WebullCaptureReceipt
      readonly gap: typeof GapSchema.Type
    }
  | { readonly kind: WebullCaptureKind.Ignored }

const RequestSchema = Schema.Struct({
  symbols: Schema.Array(WebullSymbolSchema).check(Schema.isMinLength(1), Schema.isMaxLength(20), Schema.isUnique()),
  category: Schema.Literal('US_STOCK'),
  timespan: Schema.Literal('M1'),
  count: Schema.Literal('5'),
  real_time_required: Schema.Literal(true),
  trading_sessions: Schema.String,
  start_time: TimeMs,
  end_time: TimeMs,
})
const BodySchema = Schema.Struct({
  result: Schema.Array(
    Schema.Struct({
      symbol: WebullSymbolSchema,
      delay_minutes: Schema.Literals(['0', 0]),
      result: Schema.Array(
        Schema.Struct({ time: Schema.String, trading_session: Schema.String, ...webullPriceFields }),
      ),
    }),
  ),
})
const TransportSchema = Schema.Struct({
  topic: StrictNonEmptyStringSchema,
  partition: NonNegativeIntegerSchema,
  offset: UnsignedMicrosSchema,
  timestampMs: TimeMs,
})
const failure = (message: string, cause?: unknown) =>
  new MarketFeatureFailure({ reason: 'schema', message, ...(cause === undefined ? {} : { cause }) })
const decodeJson = <A, I>(schema: Schema.Codec<A, I>, value: string, message: string) =>
  Schema.decodeUnknownResult(Schema.fromJsonString(schema))(value).pipe(
    Result.mapError((cause) => failure(message, cause)),
  )

const minuteStart = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.0{1,9})?(?:Z|\+00:?00)$/.test(value)) return undefined
  const time = Date.parse(value.replace(/\+00:?00$/, 'Z'))
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? time : undefined
}

export const decodeWebullCapture = (
  record: KafkaMarketRecord,
): Result.Result<DecodedWebullCapture, MarketFeatureFailure> =>
  Result.gen(function* () {
    const transport = yield* Schema.decodeUnknownResult(TransportSchema)(record).pipe(
      Result.mapError((cause) => failure('Invalid Webull transport coordinate or producer timestamp', cause)),
    )
    if (transport.partition > 2147483647 || BigInt(transport.offset) > 9223372036854775807n)
      return yield* Result.fail(failure('Webull transport coordinate exceeds Kafka bounds'))
    const envelope = yield* decodeJson(EnvelopeSchema, record.value, 'Invalid native Webull envelope')
    // This consumer uses HTTP bars only. Other native channels must not extend or invalidate their availability.
    if (
      !(envelope.source.type === 'http' && envelope.source.endpoint === '/market-data/stocks/bars/list') &&
      !(envelope.source.type === 'collector' && envelope.source.operation === 'gap')
    )
      return { kind: WebullCaptureKind.Ignored }
    const receivedAt = yield* canonicalRawTimestamp(envelope.receivedAt)
    if (
      envelope.source.type === 'http' &&
      Math.abs(transport.timestampMs - Number(intradayInstantNanos(receivedAt) / 1000000n)) >
        marketFeatureClockSkewAllowanceMs
    )
      return yield* Result.fail(failure('Webull timestamp violates the producer clock contract'))
    const bytes = Buffer.from(envelope.payloadBase64, 'base64')
    if (
      bytes.byteLength > 4 * 1024 * 1024 ||
      bytes.toString('base64') !== envelope.payloadBase64 ||
      createHash('sha256').update(bytes).digest('hex') !== envelope.payloadSha256
    )
      return yield* Result.fail(failure('Webull native bytes or payload hash differ'))
    const receipt: WebullCaptureReceipt = {
      captureId: envelope.captureId,
      receivedAt,
      payloadSha256: envelope.payloadSha256,
      recordHash: createHash('sha256').update(record.value).digest('hex'),
      sourceTopic: transport.topic,
      sourcePartition: transport.partition,
      sourceOffset: transport.offset,
    }
    if (envelope.source.type === 'collector' && envelope.source.operation === 'gap') {
      const text = yield* Result.try({
        try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        catch: (cause) => failure('Invalid Webull gap UTF-8', cause),
      })
      return { kind: WebullCaptureKind.Gap, receipt, gap: yield* decodeJson(GapSchema, text, 'Invalid Webull gap') }
    }
    if (envelope.source.type !== 'http' || envelope.source.endpoint !== '/market-data/stocks/bars/list')
      return { kind: WebullCaptureKind.Ignored }
    const request = yield* decodeJson(
      RequestSchema,
      envelope.source.requestBody ?? '',
      'Invalid Webull completed-M1 request',
    )
    const end = request.end_time + 1
    if (
      request.symbols.join('\n') !== envelope.source.requestedSymbols.join('\n') ||
      request.start_time % 60000 !== 0 ||
      end % 60000 !== 0 ||
      end - request.start_time !== 300000 ||
      BigInt(end) * 1000000n > intradayInstantNanos(receipt.receivedAt)
    )
      return yield* Result.fail(failure('Webull request identity or completed recovery window differs'))
    const sessions = new Set(request.trading_sessions.split(','))
    if (
      sessions.size !== request.trading_sessions.split(',').length ||
      [...sessions].some((session) => !Object.values(WebullSession).some((allowed) => allowed === session))
    )
      return yield* Result.fail(failure('Invalid Webull requested trading session'))
    const text = yield* Result.try({
      try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      catch: (cause) => failure('Invalid Webull bar UTF-8', cause),
    })
    const body = yield* decodeJson(BodySchema, text, 'Invalid Webull bar payload or real-time entitlement')
    const bars: WebullMinuteBar[] = []
    const requests = new Map<string, WebullBarRequest>()
    for (const group of body.result) {
      if (!request.symbols.includes(group.symbol) || requests.has(group.symbol))
        return yield* Result.fail(failure('Unexpected or repeated Webull response symbol'))
      const seen = new Set<number>()
      let excluded = 0
      for (const bar of group.result) {
        const startMs = minuteStart(bar.time)
        const low = BigDecimal.fromStringUnsafe(bar.low),
          high = BigDecimal.fromStringUnsafe(bar.high)
        if (
          startMs === undefined ||
          BigDecimal.isGreaterThan(low, high) ||
          [bar.open, bar.close].some(
            (price) =>
              BigDecimal.isLessThan(BigDecimal.fromStringUnsafe(price), low) ||
              BigDecimal.isGreaterThan(BigDecimal.fromStringUnsafe(price), high),
          )
        )
          return yield* Result.fail(failure('Webull bar time or OHLC values are inconsistent'))
        if (startMs < request.start_time || startMs + 60000 > end) {
          excluded++
          continue
        }
        if (seen.has(startMs) || !sessions.has(bar.trading_session))
          return yield* Result.fail(failure('Repeated Webull minute or unexpected session'))
        const session = yield* Schema.decodeUnknownResult(Schema.Enum(WebullSession))(bar.trading_session).pipe(
          Result.mapError((cause) => failure('Invalid Webull session', cause)),
        )
        seen.add(startMs)
        bars.push({
          symbol: group.symbol,
          startMs,
          session,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
        })
      }
      requests.set(group.symbol, {
        symbol: group.symbol,
        state:
          seen.size > 0
            ? WebullRequestState.Observed
            : excluded > 0
              ? WebullRequestState.Excluded
              : WebullRequestState.Empty,
        observations: seen.size,
        excluded,
      })
    }
    return {
      kind: WebullCaptureKind.Bars,
      receipt,
      bars,
      requests: request.symbols.map(
        (symbol) => requests.get(symbol) ?? { symbol, state: WebullRequestState.Omitted, observations: 0, excluded: 0 },
      ),
    }
  })
