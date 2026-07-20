import { isIP } from 'node:net'

import { Config, Effect, Redacted, Schema, SchemaTransformation } from 'effect'

import { operationalError, type OperationalError } from './errors'

export interface RuntimeConfig {
  readonly host: string
  readonly port: number
  readonly codeRevision: string
  readonly runOnStartup: boolean
  readonly operationTimeoutMs: number
  readonly clickhouse: {
    readonly url: string
    readonly username: string
    readonly password: Redacted.Redacted<string>
    readonly database: string
    readonly table: string
    readonly datasetVersion: string
  }
  readonly tigerBeetle: {
    readonly clusterId: bigint
    readonly replicaAddresses: readonly string[]
    readonly ledger: number
  }
}

const NonEmptyString = Schema.Trim.check(Schema.isMinLength(1))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const ClickHouseIdentifier = NonEmptyString.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_]*$/))
const normalizeReplicaAddress = (address: string): string => (isIP(address) === 4 ? `${address}:3001` : address)
const ReplicaAddresses = Schema.Trim.pipe(
  Schema.decodeTo(
    Schema.Array(NonEmptyString).check(Schema.isMinLength(1)),
    SchemaTransformation.transform<readonly string[], string>({
      decode: (value) =>
        value
          .split(',')
          .map((address) => address.trim())
          .filter(Boolean)
          .map(normalizeReplicaAddress),
      encode: (addresses) => addresses.join(','),
    }),
  ),
)

const nonEmptyString = (name: string) => Config.schema(NonEmptyString, name)

const secretString = (name: string) => nonEmptyString(name).pipe(Config.map((value) => Redacted.make(value)))

const positiveInteger = (name: string, fallback: number) =>
  Config.schema(PositiveInteger, name).pipe(Config.withDefault(fallback))

const clickhouseIdentifier = (name: string, fallback: string) =>
  Config.schema(ClickHouseIdentifier, name).pipe(Config.withDefault(fallback))

const runtimeConfig = Config.all({
  host: nonEmptyString('BAYN_HTTP_HOST').pipe(Config.withDefault('0.0.0.0')),
  port: Config.port('BAYN_HTTP_PORT').pipe(Config.withDefault(8080)),
  codeRevision: nonEmptyString('BAYN_CODE_REVISION'),
  runOnStartup: Config.boolean('BAYN_RUN_ON_STARTUP').pipe(Config.withDefault(true)),
  operationTimeoutMs: positiveInteger('BAYN_OPERATION_TIMEOUT_MS', 30_000),
  clickhouseUrl: nonEmptyString('BAYN_CLICKHOUSE_URL'),
  clickhouseUsername: nonEmptyString('BAYN_CLICKHOUSE_USERNAME'),
  clickhousePassword: secretString('BAYN_CLICKHOUSE_PASSWORD'),
  clickhouseDatabase: clickhouseIdentifier('BAYN_CLICKHOUSE_DATABASE', 'signal'),
  clickhouseTable: clickhouseIdentifier('BAYN_CLICKHOUSE_TABLE', 'adjusted_daily_bars_v1'),
  datasetVersion: nonEmptyString('BAYN_DATASET_VERSION'),
  tigerBeetleClusterId: Config.schema(Schema.BigIntFromString, 'BAYN_TIGERBEETLE_CLUSTER_ID').pipe(
    Config.withDefault(2001n),
  ),
  tigerBeetleReplicaAddresses: Config.schema(ReplicaAddresses, 'BAYN_TIGERBEETLE_ADDRESSES'),
  tigerBeetleLedger: positiveInteger('BAYN_TIGERBEETLE_LEDGER', 7001),
}).pipe(
  Config.map(
    (config): RuntimeConfig => ({
      host: config.host,
      port: config.port,
      codeRevision: config.codeRevision,
      runOnStartup: config.runOnStartup,
      operationTimeoutMs: config.operationTimeoutMs,
      clickhouse: {
        url: config.clickhouseUrl,
        username: config.clickhouseUsername,
        password: config.clickhousePassword,
        database: config.clickhouseDatabase,
        table: config.clickhouseTable,
        datasetVersion: config.datasetVersion,
      },
      tigerBeetle: {
        clusterId: config.tigerBeetleClusterId,
        replicaAddresses: config.tigerBeetleReplicaAddresses,
        ledger: config.tigerBeetleLedger,
      },
    }),
  ),
)

export const loadConfig: Effect.Effect<RuntimeConfig, OperationalError> = runtimeConfig.pipe(
  Effect.mapError((cause) => operationalError('config', 'load', 'invalid runtime configuration', cause)),
)
