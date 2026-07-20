import { Config, Effect, Redacted, Schema, SchemaTransformation } from 'effect'

import { EmbeddedBuildMetadataSchema, embeddedBuildMetadata, type EmbeddedBuildMetadata } from './build'
import { operationalError, type OperationalError } from './errors'

export interface RuntimeBuildMetadata extends EmbeddedBuildMetadata {
  readonly imageDigest: string
}

export interface RuntimeConfig {
  readonly host: string
  readonly port: number
  readonly build: RuntimeBuildMetadata
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
const SourceRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
const ImageRepository = Schema.String.check(Schema.isPattern(/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/))
const ImageDigest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const ReplicaAddresses = Schema.Trim.pipe(
  Schema.decodeTo(
    Schema.Array(NonEmptyString).check(Schema.isMinLength(1)),
    SchemaTransformation.transform<readonly string[], string>({
      decode: (value) =>
        value
          .split(',')
          .map((address) => address.trim())
          .filter(Boolean),
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
  sourceRevision: Config.schema(SourceRevision, 'BAYN_CODE_REVISION'),
  imageRepository: Config.schema(ImageRepository, 'BAYN_IMAGE_REPOSITORY'),
  imageDigest: Config.schema(ImageDigest, 'BAYN_IMAGE_DIGEST'),
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
  Config.map((config) => ({
    host: config.host,
    port: config.port,
    configuredBuild: {
      sourceRevision: config.sourceRevision,
      imageRepository: config.imageRepository,
      imageDigest: config.imageDigest,
    },
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
  })),
)

const StrictParseOptions = { onExcessProperty: 'error' } as const
const decodeEmbeddedBuildMetadata = Schema.decodeUnknownSync(EmbeddedBuildMetadataSchema, StrictParseOptions)

export const loadConfig = (
  embedded: EmbeddedBuildMetadata = embeddedBuildMetadata,
): Effect.Effect<RuntimeConfig, OperationalError> =>
  runtimeConfig.pipe(
    Effect.mapError((cause) => operationalError('config', 'load', 'invalid runtime configuration', cause)),
    Effect.flatMap((config) =>
      Effect.try({
        try: (): RuntimeConfig => {
          const decodedBuild = decodeEmbeddedBuildMetadata(embedded)
          if (config.configuredBuild.sourceRevision !== decodedBuild.sourceRevision) {
            throw new Error(
              `configured source revision ${config.configuredBuild.sourceRevision} does not match embedded revision ${decodedBuild.sourceRevision}`,
            )
          }
          if (config.configuredBuild.imageRepository !== decodedBuild.imageRepository) {
            throw new Error(
              `configured image repository ${config.configuredBuild.imageRepository} does not match embedded repository ${decodedBuild.imageRepository}`,
            )
          }
          const { configuredBuild, ...runtime } = config
          return {
            ...runtime,
            build: { ...decodedBuild, imageDigest: configuredBuild.imageDigest },
          }
        },
        catch: (cause) => operationalError('config', 'provenance', 'invalid build provenance', cause),
      }),
    ),
  )
