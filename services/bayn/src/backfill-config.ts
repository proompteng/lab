import { Config, Effect, Redacted, Schema } from 'effect'

export interface BackfillConfig {
  readonly clickhouseUrl: string
  readonly clickhouseUsername: string
  readonly clickhousePassword: Redacted.Redacted<string>
  readonly alpacaKey: Redacted.Redacted<string>
  readonly alpacaSecret: Redacted.Redacted<string>
  readonly database: string
  readonly table: string
  readonly cluster: string
  readonly start: string
  readonly end: string
  readonly feed: 'iex' | 'sip'
  readonly datasetVersion: string
}

const NonEmptyString = Schema.Trim.check(Schema.isMinLength(1))
const Identifier = NonEmptyString.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_]*$/))
const IsoDate = NonEmptyString.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter((value: string) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), {
    expected: 'a valid ISO date (YYYY-MM-DD)',
  }),
)

const nonEmptyString = (name: string) => Config.schema(NonEmptyString, name)

const secretString = (name: string) => nonEmptyString(name).pipe(Config.map((value) => Redacted.make(value)))

const identifier = (name: string, fallback: string) =>
  Config.schema(Identifier, name).pipe(Config.withDefault(fallback))

const isoDate = (name: string) => Config.schema(IsoDate, name)

export const loadBackfillConfig: Effect.Effect<BackfillConfig, Config.ConfigError> = Config.all({
  clickhouseUrl: nonEmptyString('BAYN_CLICKHOUSE_URL'),
  clickhouseUsername: nonEmptyString('BAYN_CLICKHOUSE_USERNAME'),
  clickhousePassword: secretString('BAYN_CLICKHOUSE_PASSWORD'),
  alpacaKey: secretString('APCA_API_KEY_ID'),
  alpacaSecret: secretString('APCA_API_SECRET_KEY'),
  database: identifier('BAYN_CLICKHOUSE_DATABASE', 'signal'),
  table: identifier('BAYN_CLICKHOUSE_TABLE', 'adjusted_daily_bars_v1'),
  cluster: identifier('BAYN_CLICKHOUSE_CLUSTER', 'default'),
  start: isoDate('BAYN_DATASET_START'),
  end: isoDate('BAYN_DATASET_END'),
  feed: Config.literals(['iex', 'sip'], 'BAYN_ALPACA_FEED').pipe(Config.withDefault('iex')),
  datasetVersion: nonEmptyString('BAYN_DATASET_VERSION'),
})
