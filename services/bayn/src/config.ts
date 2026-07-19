import { Config, Effect, Redacted } from 'effect'

import { baynError, type BaynError } from './errors'
import { defaultProtocol } from './protocol'
import type { TsmomProtocol } from './types'

export interface BaynConfig {
  readonly host: string
  readonly port: number
  readonly codeRevision: string
  readonly runOnStartup: boolean
  readonly operationTimeoutMs: number
  readonly clickhouse: {
    readonly url: string
    readonly username: string
    readonly password: string
    readonly database: string
    readonly table: string
    readonly datasetVersion: string
  }
  readonly tigerBeetle: {
    readonly clusterId: bigint
    readonly replicaAddresses: readonly string[]
    readonly ledger: number
  }
  readonly protocol: TsmomProtocol
}

const nonEmptyString = (name: string) =>
  Config.string(name).pipe(
    Config.map((value) => value.trim()),
    Config.validate({ message: `${name} is required`, validation: (value) => value.length > 0 }),
  )

const positiveInteger = (name: string, fallback: number) =>
  Config.integer(name).pipe(
    Config.withDefault(fallback),
    Config.validate({ message: `${name} must be a positive integer`, validation: (value) => value > 0 }),
  )

const clickhouseIdentifier = (name: string, fallback: string) =>
  nonEmptyString(name).pipe(
    Config.withDefault(fallback),
    Config.validate({
      message: `${name} must be a ClickHouse identifier`,
      validation: (value) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value),
    }),
  )

const baynConfig = Config.all({
  host: nonEmptyString('BAYN_HTTP_HOST').pipe(Config.withDefault('0.0.0.0')),
  port: Config.port('BAYN_HTTP_PORT').pipe(Config.withDefault(8080)),
  codeRevision: nonEmptyString('BAYN_CODE_REVISION'),
  runOnStartup: Config.boolean('BAYN_RUN_ON_STARTUP').pipe(Config.withDefault(true)),
  operationTimeoutMs: positiveInteger('BAYN_OPERATION_TIMEOUT_MS', 30_000),
  clickhouseUrl: nonEmptyString('BAYN_CLICKHOUSE_URL'),
  clickhouseUsername: nonEmptyString('BAYN_CLICKHOUSE_USERNAME'),
  clickhousePassword: Config.redacted(nonEmptyString('BAYN_CLICKHOUSE_PASSWORD')),
  clickhouseDatabase: clickhouseIdentifier('BAYN_CLICKHOUSE_DATABASE', 'signal'),
  clickhouseTable: clickhouseIdentifier('BAYN_CLICKHOUSE_TABLE', 'adjusted_daily_bars_v1'),
  datasetVersion: nonEmptyString('BAYN_DATASET_VERSION'),
  tigerBeetleClusterId: nonEmptyString('BAYN_TIGERBEETLE_CLUSTER_ID').pipe(
    Config.withDefault('2001'),
    Config.mapAttempt((value) => BigInt(value)),
  ),
  tigerBeetleReplicaAddresses: nonEmptyString('BAYN_TIGERBEETLE_ADDRESSES').pipe(
    Config.map((value) =>
      value
        .split(',')
        .map((address) => address.trim())
        .filter(Boolean),
    ),
    Config.validate({
      message: 'BAYN_TIGERBEETLE_ADDRESSES must contain at least one address',
      validation: (addresses) => addresses.length > 0,
    }),
  ),
  tigerBeetleLedger: positiveInteger('BAYN_TIGERBEETLE_LEDGER', 7001),
}).pipe(
  Config.map(
    (config): BaynConfig => ({
      host: config.host,
      port: config.port,
      codeRevision: config.codeRevision,
      runOnStartup: config.runOnStartup,
      operationTimeoutMs: config.operationTimeoutMs,
      clickhouse: {
        url: config.clickhouseUrl,
        username: config.clickhouseUsername,
        password: Redacted.value(config.clickhousePassword),
        database: config.clickhouseDatabase,
        table: config.clickhouseTable,
        datasetVersion: config.datasetVersion,
      },
      tigerBeetle: {
        clusterId: config.tigerBeetleClusterId,
        replicaAddresses: config.tigerBeetleReplicaAddresses,
        ledger: config.tigerBeetleLedger,
      },
      protocol: defaultProtocol,
    }),
  ),
)

export const loadConfig: Effect.Effect<BaynConfig, BaynError> = baynConfig.pipe(
  Effect.mapError((cause) => baynError('config', 'load', 'invalid Bayn configuration', cause)),
)
