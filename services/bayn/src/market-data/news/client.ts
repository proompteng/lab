import { Cause, Clock, Effect, FileSystem, Layer, Redacted, Schema } from 'effect'
import { Headers, HttpClient, HttpClientRequest, HttpIncomingMessage } from 'effect/unstable/http'

import type { BrokerConnection } from '../../broker/connection'
import { utcInstantFromEpochMillis } from '../../time'
import { strictParseOptions } from '../../schemas'
import {
  CompanyNews,
  makeNewsSnapshot,
  NewsError,
  NewsFailure,
  NewsPageSchema,
  NewsQuerySchema,
  newsArticleLimit,
  newsLookbackMs,
  type NewsArticle,
  type NewsQuery,
} from './model'

export const CompanyNewsLive = (credentials: Pick<BrokerConnection, 'key' | 'secret'>, timeoutMs: number) =>
  Layer.effect(
    CompanyNews,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > 10_000 ||
        Redacted.value(credentials.key).length === 0 ||
        Redacted.value(credentials.secret).length === 0
      ) {
        return yield* new NewsError({
          failure: NewsFailure.Request,
          message: 'Company news requires credentials and a 1-10000ms deadline',
        })
      }
      const read = (input: NewsQuery) =>
        Effect.gen(function* () {
          const query = yield* Schema.decodeUnknownEffect(
            NewsQuerySchema,
            strictParseOptions,
          )(input).pipe(
            Effect.mapError(
              (cause) =>
                new NewsError({
                  failure: NewsFailure.Request,
                  message: 'News query is malformed',
                  cause: Redacted.make(cause),
                }),
            ),
          )
          const started = yield* Clock.currentTimeMillis
          if (Date.parse(query.asOf) > started || started - Date.parse(query.asOf) > 10_000)
            return yield* new NewsError({
              failure: NewsFailure.Request,
              message: 'News query must bind a recent observed market snapshot',
            })
          return yield* Effect.gen(function* () {
            const pages: { requestPageToken: string | null; response: Schema.Json }[] = []
            const articles: NewsArticle[] = []
            const seen = new Set<string>()
            let token: string | null = null
            for (let page = 0; page < 10; page += 1) {
              const url = new URL('https://data.alpaca.markets/v1beta1/news')
              url.searchParams.set('symbols', query.symbol)
              url.searchParams.set('start', utcInstantFromEpochMillis(Date.parse(query.asOf) - newsLookbackMs))
              url.searchParams.set('end', query.asOf)
              url.searchParams.set('sort', 'desc')
              url.searchParams.set('limit', String(newsArticleLimit))
              url.searchParams.set('include_content', 'false')
              if (token !== null) url.searchParams.set('page_token', token)
              const response = yield* http.execute(
                HttpClientRequest.get(url, {
                  acceptJson: true,
                  headers: {
                    'APCA-API-KEY-ID': Redacted.value(credentials.key),
                    'APCA-API-SECRET-KEY': Redacted.value(credentials.secret),
                  },
                }),
              )
              if (response.status !== 200)
                return yield* new NewsError({
                  failure: NewsFailure.Status,
                  message: 'Company news returned an unsuccessful status',
                  status: response.status,
                })
              const raw = yield* Schema.decodeUnknownEffect(Schema.Json)(yield* response.json)
              const decoded = yield* Schema.decodeUnknownEffect(NewsPageSchema)(raw)
              pages.push({ requestPageToken: token, response: raw })
              articles.push(...decoded.news)
              token = decoded.next_page_token
              if (token === null || articles.length >= newsArticleLimit) break
              if (seen.has(token))
                return yield* new NewsError({
                  failure: NewsFailure.Response,
                  message: 'News pagination repeats a continuation token',
                })
              seen.add(token)
            }
            const finished = yield* Clock.currentTimeMillis
            if (finished < started || finished - started >= timeoutMs)
              return yield* new NewsError({
                failure: NewsFailure.Timeout,
                message: 'News response arrived outside its read deadline',
              })
            return yield* Effect.fromResult(
              makeNewsSnapshot({
                schemaVersion: 'bayn.company-news-snapshot.v1',
                source: 'alpaca-news-v1beta1',
                query,
                requestedAt: utcInstantFromEpochMillis(started),
                receivedAt: utcInstantFromEpochMillis(finished),
                articles: articles.slice(0, newsArticleLimit),
                pages,
              }),
            )
          }).pipe(
            Effect.timeout(`${timeoutMs} millis`),
            Effect.mapError((cause) =>
              cause instanceof NewsError
                ? cause
                : new NewsError({
                    failure: Cause.isTimeoutError(cause)
                      ? NewsFailure.Timeout
                      : Schema.isSchemaError(cause)
                        ? NewsFailure.Response
                        : NewsFailure.Transport,
                    message: Cause.isTimeoutError(cause)
                      ? 'News read deadline elapsed'
                      : 'News read or response validation failed',
                    cause: Redacted.make(cause),
                  }),
            ),
            Effect.provideService(Headers.CurrentRedactedNames, ['apca-api-key-id', 'apca-api-secret-key']),
            Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(256_000)),
          )
        })
      return { read }
    }),
  )
