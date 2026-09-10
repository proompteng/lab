import { Cause, Effect, Redacted, Schema } from 'effect'
import { Headers, HttpClient, HttpClientRequest } from 'effect/unstable/http'

import type { PublisherConfig } from './config'
import {
  AlpacaBarsResponseSchema,
  AlpacaCalendarResponseSchema,
  type AlpacaBar,
  type AlpacaCalendarSession,
  type IsoDate,
} from './domain'
import { PublicationError, publicationError } from './errors'

const parseOptions = { onExcessProperty: 'ignore' } as const
const redactedHeaders = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'apca-api-key-id',
  'apca-api-secret-key',
] as const

const fetchJson = (
  url: URL,
  config: PublisherConfig,
): Effect.Effect<unknown, PublicationError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.get(url, {
      acceptJson: true,
      headers: {
        'APCA-API-KEY-ID': Redacted.value(config.alpaca.key),
        'APCA-API-SECRET-KEY': Redacted.value(config.alpaca.secret),
      },
    })
    const response = yield* client
      .execute(request)
      .pipe(Effect.provideService(Headers.CurrentRedactedNames, redactedHeaders))
    if (response.status < 200 || response.status >= 300) {
      const detail = yield* response.text.pipe(Effect.orElseSucceed(() => ''))
      return yield* Effect.fail(
        publicationError(
          'provider',
          `Alpaca request failed for ${url.pathname}: HTTP ${response.status}${detail ? `: ${detail.slice(0, 1_000)}` : ''}`,
        ),
      )
    }
    return yield* response.json.pipe(
      Effect.mapError((cause) =>
        publicationError('provider', `Alpaca returned invalid JSON for ${url.pathname}`, cause),
      ),
    )
  }).pipe(
    Effect.timeout(`${config.operationTimeoutMs} millis`),
    Effect.mapError((cause) =>
      cause instanceof PublicationError
        ? cause
        : Cause.isTimeoutError(cause)
          ? publicationError('provider', `Alpaca request timed out for ${url.pathname}`, cause)
          : publicationError('provider', `Alpaca request failed for ${url.pathname}`, cause),
    ),
  )

export const fetchCalendar = (
  config: PublisherConfig,
  start: IsoDate,
  end: IsoDate,
): Effect.Effect<readonly AlpacaCalendarSession[], PublicationError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = new URL('/v2/calendar', config.alpaca.tradingUrl)
    url.searchParams.set('start', start)
    url.searchParams.set('end', end)
    const payload = yield* fetchJson(url, config)
    return yield* Schema.decodeUnknownEffect(
      AlpacaCalendarResponseSchema,
      parseOptions,
    )(payload).pipe(
      Effect.mapError((cause) => publicationError('provider', 'Alpaca calendar response is invalid', cause)),
    )
  })

export const fetchBars = (
  config: PublisherConfig,
  start: IsoDate,
  publicationAsOf: IsoDate,
  queryEnd: string,
): Effect.Effect<Readonly<Record<string, readonly AlpacaBar[]>>, PublicationError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const bars = new Map<string, AlpacaBar[]>()
    const seenTokens = new Set<string>()
    let pageToken: string | null = null
    let pageCount = 0
    do {
      pageCount += 1
      if (pageCount > 100)
        return yield* Effect.fail(publicationError('provider', 'Alpaca pagination exceeded 100 pages'))
      const url = new URL('/v2/stocks/bars', config.alpaca.dataUrl)
      url.searchParams.set('symbols', config.symbols.join(','))
      url.searchParams.set('timeframe', '1Day')
      url.searchParams.set('start', `${start}T00:00:00Z`)
      url.searchParams.set('end', queryEnd)
      url.searchParams.set('adjustment', 'all')
      url.searchParams.set('asof', publicationAsOf)
      url.searchParams.set('feed', config.alpaca.feed)
      url.searchParams.set('sort', 'asc')
      url.searchParams.set('limit', '10000')
      if (pageToken !== null) url.searchParams.set('page_token', pageToken)

      const payload = yield* fetchJson(url, config)
      const decoded = yield* Schema.decodeUnknownEffect(
        AlpacaBarsResponseSchema,
        parseOptions,
      )(payload).pipe(
        Effect.mapError((cause) => publicationError('provider', 'Alpaca bars response is invalid', cause)),
      )
      for (const [symbol, pageBars] of Object.entries(decoded.bars)) {
        bars.set(symbol, [...(bars.get(symbol) ?? []), ...pageBars])
      }
      pageToken = decoded.next_page_token
      if (pageToken !== null) {
        if (seenTokens.has(pageToken)) {
          return yield* Effect.fail(publicationError('provider', 'Alpaca returned a repeated page token'))
        }
        seenTokens.add(pageToken)
      }
    } while (pageToken !== null)
    return Object.fromEntries([...bars.entries()].sort(([left], [right]) => left.localeCompare(right)))
  })
