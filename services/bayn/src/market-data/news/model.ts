import { Context, Data, type Effect, Redacted, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import {
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../../schemas'
import { intradayInstantNanos } from '../intraday/time'

export const newsLookbackMs = 60 * 60_000
export const newsArticleLimit = 3

const ProviderInstant = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/),
  Schema.makeFilter(
    (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19),
  ),
)
const instantNanos = (value: string) => intradayInstantNanos(value.includes('.') ? value : value.replace('Z', '.000Z'))
const Text = Schema.String.check(
  Schema.isMaxLength(8_000),
  Schema.makeFilter((value) => value.isWellFormed()),
)

export const NewsArticleSchema = Schema.Struct({
  id: PositiveIntegerSchema,
  created_at: ProviderInstant,
  updated_at: ProviderInstant,
  headline: Text.check(Schema.isMinLength(1)),
  summary: Text,
  source: StrictNonEmptyStringSchema,
  url: Schema.String.check(Schema.isMaxLength(2_048)),
  symbols: Schema.Array(SymbolSchema).check(Schema.isUnique()),
})
export type NewsArticle = typeof NewsArticleSchema.Type

export const NewsPageSchema = Schema.Struct({
  news: Schema.Array(NewsArticleSchema).check(Schema.isMaxLength(newsArticleLimit)),
  next_page_token: Schema.NullOr(StrictNonEmptyStringSchema.check(Schema.isMaxLength(2_048))),
})

export const NewsQuerySchema = Schema.Struct({ symbol: SymbolSchema, asOf: UtcInstantSchema })
export type NewsQuery = typeof NewsQuerySchema.Type

const NewsSnapshotMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.company-news-snapshot.v1'),
  source: Schema.Literal('alpaca-news-v1beta1'),
  query: NewsQuerySchema,
  requestedAt: UtcInstantSchema,
  receivedAt: UtcInstantSchema,
  articles: Schema.Array(NewsArticleSchema).check(Schema.isMaxLength(newsArticleLimit)),
  pages: Schema.Array(
    Schema.Struct({ requestPageToken: Schema.NullOr(StrictNonEmptyStringSchema), response: Schema.Json }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
})
export const NewsSnapshotSchema = Schema.Struct({ ...NewsSnapshotMaterialSchema.fields, contentHash: Sha256Schema })
export type NewsSnapshot = typeof NewsSnapshotSchema.Type

export enum NewsFailure {
  Request = 'REQUEST',
  Transport = 'TRANSPORT',
  Response = 'RESPONSE',
  Status = 'STATUS',
  Timeout = 'TIMEOUT',
}
export class NewsError extends Data.TaggedError('NewsError')<{
  readonly failure: NewsFailure
  readonly message: string
  readonly status?: number
  readonly cause?: Redacted.Redacted<unknown>
}> {}

const invalid = (message: string) => Result.fail(new NewsError({ failure: NewsFailure.Response, message }))

export const makeNewsSnapshot = (input: unknown) =>
  Schema.decodeUnknownResult(
    NewsSnapshotMaterialSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError(
      (cause) =>
        new NewsError({
          failure: NewsFailure.Response,
          message: 'News snapshot is malformed',
          cause: Redacted.make(cause),
        }),
    ),
    Result.flatMap((material) => {
      if (material.requestedAt < material.query.asOf || material.receivedAt < material.requestedAt)
        return invalid('News observation clock precedes its query or request')
      const asOf = instantNanos(material.query.asOf)
      const start = asOf - BigInt(newsLookbackMs) * 1_000_000n
      let previous = asOf
      let nextToken: string | null = null
      const tokens = new Set<string>()
      const ids = new Set<number>()
      const articles: NewsArticle[] = []
      for (const [index, retained] of material.pages.entries()) {
        if (
          retained.requestPageToken !== nextToken ||
          (index > 0 && (nextToken === null || articles.length >= newsArticleLimit))
        )
          return invalid('News pagination does not continue the retained response')
        const decoded = Schema.decodeUnknownResult(NewsPageSchema)(retained.response)
        if (Result.isFailure(decoded))
          return Result.fail(
            new NewsError({
              failure: NewsFailure.Response,
              message: 'News response page is malformed',
              cause: Redacted.make(decoded.failure),
            }),
          )
        for (const article of decoded.success.news) {
          const published = instantNanos(article.created_at)
          const updated = instantNanos(article.updated_at)
          if (
            updated < published ||
            updated < start ||
            updated > previous ||
            !article.symbols.includes(material.query.symbol) ||
            ids.has(article.id)
          )
            return invalid('News articles violate chronology, ordering, identity or symbol binding')
          previous = updated
          ids.add(article.id)
          articles.push(article)
        }
        nextToken = decoded.success.next_page_token
        if (nextToken !== null && tokens.has(nextToken)) return invalid('News pagination repeats a continuation token')
        if (nextToken !== null) tokens.add(nextToken)
      }
      if (articles.length < newsArticleLimit && nextToken !== null)
        return invalid('News observation stopped before its requested coverage was available')
      const selected = articles.slice(0, newsArticleLimit)
      const selectedHash = canonicalHashV1Result(selected)
      const materialHash = canonicalHashV1Result(material.articles)
      if (
        Result.isFailure(selectedHash) ||
        Result.isFailure(materialHash) ||
        selectedHash.success !== materialHash.success
      )
        return invalid('Selected news differs from the retained provider pages')
      return canonicalHashV1Result(material).pipe(
        Result.mapError(
          (cause) =>
            new NewsError({
              failure: NewsFailure.Response,
              message: 'News snapshot cannot be hashed',
              cause: Redacted.make(cause),
            }),
        ),
        Result.map((contentHash) => ({ ...material, contentHash })),
      )
    }),
  )

export const decodeNewsSnapshot = (input: unknown) =>
  Schema.decodeUnknownResult(
    NewsSnapshotSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError(
      (cause) =>
        new NewsError({
          failure: NewsFailure.Response,
          message: 'Stored news snapshot is malformed',
          cause: Redacted.make(cause),
        }),
    ),
    Result.flatMap(({ contentHash, ...material }) =>
      makeNewsSnapshot(material).pipe(
        Result.flatMap((snapshot) =>
          snapshot.contentHash === contentHash
            ? Result.succeed(snapshot)
            : invalid('Stored news snapshot hash differs'),
        ),
      ),
    ),
  )

export class CompanyNews extends Context.Service<
  CompanyNews,
  {
    readonly read: (query: NewsQuery) => Effect.Effect<NewsSnapshot, NewsError>
  }
>()('@proompteng/bayn/CompanyNews') {}
