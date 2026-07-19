import { Config, ConfigError, Effect, Redacted } from 'effect'

export interface BackfillConfig {
  readonly clickhouseUrl: string
  readonly clickhouseUsername: string
  readonly clickhousePassword: string
  readonly alpacaKey: string
  readonly alpacaSecret: string
  readonly database: string
  readonly table: string
  readonly cluster: string
  readonly start: string
  readonly end: string
  readonly feed: 'iex' | 'sip'
  readonly datasetVersion: string
}

const nonEmptyString = (name: string) =>
  Config.string(name).pipe(
    Config.map((value) => value.trim()),
    Config.validate({ message: `${name} is required`, validation: (value) => value.length > 0 }),
  )

const identifier = (name: string, fallback: string) =>
  nonEmptyString(name).pipe(
    Config.withDefault(fallback),
    Config.validate({
      message: `${name} must be a ClickHouse identifier`,
      validation: (value) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value),
    }),
  )

const isoDate = (name: string) =>
  nonEmptyString(name).pipe(
    Config.validate({
      message: `${name} must be an ISO date`,
      validation: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)),
    }),
  )

export const loadBackfillConfig: Effect.Effect<BackfillConfig, ConfigError.ConfigError> = Config.all({
  clickhouseUrl: nonEmptyString('BAYN_CLICKHOUSE_URL'),
  clickhouseUsername: nonEmptyString('BAYN_CLICKHOUSE_USERNAME'),
  clickhousePassword: Config.redacted(nonEmptyString('BAYN_CLICKHOUSE_PASSWORD')),
  alpacaKey: Config.redacted(nonEmptyString('APCA_API_KEY_ID')),
  alpacaSecret: Config.redacted(nonEmptyString('APCA_API_SECRET_KEY')),
  database: identifier('BAYN_CLICKHOUSE_DATABASE', 'signal'),
  table: identifier('BAYN_CLICKHOUSE_TABLE', 'adjusted_daily_bars_v1'),
  cluster: identifier('BAYN_CLICKHOUSE_CLUSTER', 'default'),
  start: isoDate('BAYN_DATASET_START'),
  end: isoDate('BAYN_DATASET_END'),
  feed: Config.literal('iex', 'sip')('BAYN_ALPACA_FEED').pipe(Config.withDefault('iex')),
  datasetVersion: nonEmptyString('BAYN_DATASET_VERSION'),
}).pipe(
  Effect.map((config) => ({
    ...config,
    clickhousePassword: Redacted.value(config.clickhousePassword),
    alpacaKey: Redacted.value(config.alpacaKey),
    alpacaSecret: Redacted.value(config.alpacaSecret),
  })),
)
