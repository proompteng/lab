import { Config, Effect, Redacted, Schema, SchemaTransformation } from 'effect'

import { IsoDateSchema, type IsoDate, type PublisherProvenance } from './domain'

declare const __SIGNAL_PUBLISHER_BUILD_SOURCE_REVISION__: string | undefined
declare const __SIGNAL_PUBLISHER_BUILD_IMAGE_REPOSITORY__: string | undefined

interface EmbeddedPublisherBuild {
  readonly sourceRevision: string
  readonly imageRepository: string
}

export interface PublisherConfig {
  readonly clickhouse: {
    readonly url: string
    readonly username: string
    readonly password: Redacted.Redacted<string>
  }
  readonly alpaca: {
    readonly dataUrl: string
    readonly tradingUrl: string
    readonly key: Redacted.Redacted<string>
    readonly secret: Redacted.Redacted<string>
    readonly feed: 'iex' | 'sip'
  }
  readonly symbols: readonly string[]
  readonly startDate: IsoDate
  readonly calendarVersion: string
  readonly finalizationLagMinutes: number
  readonly operationTimeoutMs: number
  readonly provenance: PublisherProvenance
}

const embeddedPublisherBuild: EmbeddedPublisherBuild | undefined =
  typeof __SIGNAL_PUBLISHER_BUILD_SOURCE_REVISION__ === 'string' &&
  typeof __SIGNAL_PUBLISHER_BUILD_IMAGE_REPOSITORY__ === 'string'
    ? {
        sourceRevision: __SIGNAL_PUBLISHER_BUILD_SOURCE_REVISION__,
        imageRepository: __SIGNAL_PUBLISHER_BUILD_IMAGE_REPOSITORY__,
      }
    : undefined

const NonEmptyString = Schema.Trim.check(Schema.isMinLength(1))
const SourceRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
const ImageRepository = Schema.String.check(Schema.isPattern(/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/))
const ImageDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const SymbolList = Schema.Trim.pipe(
  Schema.decodeTo(
    Schema.Array(NonEmptyString).check(Schema.isMinLength(1)),
    SchemaTransformation.transform<readonly string[], string>({
      decode: (value) =>
        value
          .split(',')
          .map((symbol) => symbol.trim().toUpperCase())
          .filter(Boolean),
      encode: (symbols) => symbols.join(','),
    }),
  ),
)

const nonEmptyString = (name: string) => Config.schema(NonEmptyString, name)
const secretString = (name: string) => nonEmptyString(name).pipe(Config.map(Redacted.make))
const positiveInteger = (name: string, fallback: number) =>
  Config.schema(PositiveInteger, name).pipe(Config.withDefault(fallback))

const httpUrl = (value: string, name: string): string => {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must use http or https`)
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`)
  return url.toString().replace(/\/$/, '')
}

const rawConfig = Config.all({
  clickhouseUrl: nonEmptyString('SIGNAL_CLICKHOUSE_URL'),
  clickhouseUsername: nonEmptyString('SIGNAL_CLICKHOUSE_USERNAME'),
  clickhousePassword: secretString('SIGNAL_CLICKHOUSE_PASSWORD'),
  alpacaDataUrl: nonEmptyString('SIGNAL_ALPACA_DATA_URL').pipe(Config.withDefault('https://data.alpaca.markets')),
  alpacaTradingUrl: nonEmptyString('SIGNAL_ALPACA_TRADING_URL').pipe(
    Config.withDefault('https://paper-api.alpaca.markets'),
  ),
  alpacaKey: secretString('APCA_API_KEY_ID'),
  alpacaSecret: secretString('APCA_API_SECRET_KEY'),
  feed: Config.literals(['iex', 'sip'], 'SIGNAL_ALPACA_FEED').pipe(Config.withDefault('iex')),
  symbols: Config.schema(SymbolList, 'SIGNAL_SYMBOLS'),
  startDate: Config.schema(IsoDateSchema, 'SIGNAL_START_DATE'),
  calendarVersion: nonEmptyString('SIGNAL_CALENDAR_VERSION').pipe(Config.withDefault('alpaca-us-equity-calendar-v1')),
  finalizationLagMinutes: positiveInteger('SIGNAL_FINALIZATION_LAG_MINUTES', 90),
  operationTimeoutMs: positiveInteger('SIGNAL_OPERATION_TIMEOUT_MS', 60_000),
  sourceRevision: Config.schema(SourceRevision, 'SIGNAL_CODE_REVISION'),
  imageRepository: Config.schema(ImageRepository, 'SIGNAL_IMAGE_REPOSITORY'),
  imageDigest: Config.schema(ImageDigest, 'SIGNAL_IMAGE_DIGEST'),
})

export const loadConfig = (
  build: EmbeddedPublisherBuild | undefined = embeddedPublisherBuild,
): Effect.Effect<PublisherConfig, Error> =>
  rawConfig.pipe(
    Effect.mapError((cause) => new Error(`invalid Signal publisher configuration: ${cause.message}`)),
    Effect.flatMap((config) =>
      Effect.try({
        try: (): PublisherConfig => {
          if (build === undefined) throw new Error('production publisher requires compile-time build metadata')
          if (config.sourceRevision !== build.sourceRevision) {
            throw new Error(
              `configured source revision ${config.sourceRevision} does not match embedded revision ${build.sourceRevision}`,
            )
          }
          if (config.imageRepository !== build.imageRepository) {
            throw new Error(
              `configured image repository ${config.imageRepository} does not match embedded repository ${build.imageRepository}`,
            )
          }
          const symbols = [...config.symbols].sort()
          if (new Set(symbols).size !== symbols.length) throw new Error('SIGNAL_SYMBOLS contains duplicates')
          for (const symbol of symbols) {
            if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) throw new Error(`invalid symbol: ${symbol}`)
          }
          return {
            clickhouse: {
              url: httpUrl(config.clickhouseUrl, 'SIGNAL_CLICKHOUSE_URL'),
              username: config.clickhouseUsername,
              password: config.clickhousePassword,
            },
            alpaca: {
              dataUrl: httpUrl(config.alpacaDataUrl, 'SIGNAL_ALPACA_DATA_URL'),
              tradingUrl: httpUrl(config.alpacaTradingUrl, 'SIGNAL_ALPACA_TRADING_URL'),
              key: config.alpacaKey,
              secret: config.alpacaSecret,
              feed: config.feed,
            },
            symbols,
            startDate: config.startDate as IsoDate,
            calendarVersion: config.calendarVersion,
            finalizationLagMinutes: config.finalizationLagMinutes,
            operationTimeoutMs: config.operationTimeoutMs,
            provenance: {
              sourceRevision: build.sourceRevision,
              imageRepository: build.imageRepository,
              imageDigest: config.imageDigest,
            },
          }
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }),
    ),
  )
