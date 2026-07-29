import { Config, Option, Redacted, Schema, SchemaTransformation } from 'effect'

import { BrokerProvider, alpacaSandboxBaseUrl } from '../broker/connection'
import { BrokerEnvironment, BrokerEnvironmentSchema } from '../broker/identity'
import { EvaluationBoundsSchema, IsoDateSchema, Sha256Schema } from '../contracts'
import { BrokerAccess, BrokerAccessSchema } from '../execution/authority'
import { CapitalAuthoritySelection } from '../execution/configuration'
import {
  GitSourceRevisionSchema as SourceRevision,
  ImageDigestSchema as ImageDigest,
  ImageRepositorySchema as ImageRepository,
  PositiveIntegerSchema as PositiveInteger,
  TrimmedNonEmptyStringSchema as NonEmptyString,
} from '../schemas'
import type { ParsedRuntimeConfig, RuntimeOperation } from './model'

const ProvenanceMode = Schema.Literals(['production', 'development'])
const RetryAttempts = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))
const OperationalThresholdMs = Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 86_400_000 }))
const LegacyAuthorityTokenSchema = Schema.Literals(['OBSERVE', 'PAPER'])
const RuntimeOperationTokenSchema = Schema.Literals(['EXECUTION_CANDIDATE_DISCOVERY', 'PAPER_CANDIDATE_DISCOVERY'])
const CapitalAuthoritySelectionSchema = Schema.Enum(CapitalAuthoritySelection)

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
const operationalThreshold = (name: string, fallback: number) =>
  Config.schema(OperationalThresholdMs, name).pipe(Config.withDefault(fallback))

const runtimeOperation = Config.schema(RuntimeOperationTokenSchema, 'BAYN_OPERATION').pipe(
  Config.map((): RuntimeOperation => 'ExecutionCandidateDiscovery'),
)

export const runtimeConfigSource = Config.all({
  host: nonEmptyString('BAYN_HTTP_HOST').pipe(Config.withDefault('0.0.0.0')),
  port: Config.port('BAYN_HTTP_PORT').pipe(Config.withDefault(8080)),
  sourceRevision: Config.schema(SourceRevision, 'BAYN_CODE_REVISION'),
  imageRepository: Config.schema(ImageRepository, 'BAYN_IMAGE_REPOSITORY'),
  imageDigest: Config.schema(ImageDigest, 'BAYN_IMAGE_DIGEST'),
  strategyBehaviorHash: Config.schema(Sha256Schema, 'BAYN_STRATEGY_BEHAVIOR_HASH'),
  strategyParameterHash: Config.schema(Sha256Schema, 'BAYN_STRATEGY_PARAMETER_HASH'),
  provenanceMode: Config.schema(ProvenanceMode, 'BAYN_PROVENANCE_MODE').pipe(Config.withDefault('production')),
  qualificationRunId: Config.option(Config.schema(Sha256Schema, 'BAYN_QUALIFICATION_RUN_ID')),
  operation: Config.option(runtimeOperation),
  legacyMaximumAuthority: Config.option(Config.schema(LegacyAuthorityTokenSchema, 'BAYN_MAXIMUM_AUTHORITY')),
  brokerAccess: Config.schema(BrokerAccessSchema, 'BAYN_BROKER_ACCESS').pipe(Config.withDefault(BrokerAccess.ReadOnly)),
  capitalAuthority: Config.schema(CapitalAuthoritySelectionSchema, 'BAYN_CAPITAL_AUTHORITY').pipe(
    Config.withDefault(CapitalAuthoritySelection.None),
  ),
  liveCapitalGrantHash: Config.option(Config.schema(Sha256Schema, 'BAYN_LIVE_CAPITAL_GRANT_HASH')),
  healthIntervalMs: positiveInteger('BAYN_HEALTH_INTERVAL_MS', 30_000),
  operationTimeoutMs: positiveInteger('BAYN_OPERATION_TIMEOUT_MS', 30_000),
  cycleStallThresholdMs: operationalThreshold('BAYN_CYCLE_STALL_THRESHOLD_MS', 300_000),
  reconciliationStaleThresholdMs: operationalThreshold('BAYN_RECONCILIATION_STALE_THRESHOLD_MS', 120_000),
  unknownMutationThresholdMs: operationalThreshold('BAYN_UNKNOWN_MUTATION_THRESHOLD_MS', 300_000),
  cyclePollIntervalMs: operationalThreshold('BAYN_CYCLE_POLL_INTERVAL_MS', 30_000),
  authorityGenerationHash: Config.option(Config.schema(Sha256Schema, 'BAYN_AUTHORITY_GENERATION_HASH')),
  brokerProvider: Config.schema(Schema.Enum(BrokerProvider), 'BAYN_BROKER_PROVIDER').pipe(
    Config.withDefault(BrokerProvider.Alpaca),
  ),
  brokerEnvironment: Config.schema(BrokerEnvironmentSchema, 'BAYN_BROKER_ENVIRONMENT').pipe(
    Config.withDefault(BrokerEnvironment.Sandbox),
  ),
  alpacaBaseUrl: nonEmptyString('BAYN_ALPACA_BASE_URL').pipe(Config.withDefault(alpacaSandboxBaseUrl)),
  alpacaAccountId: Config.option(nonEmptyString('BAYN_ALPACA_ACCOUNT_ID')),
  alpacaKey: Config.option(secretString('BAYN_ALPACA_KEY_ID')),
  alpacaSecret: Config.option(secretString('BAYN_ALPACA_SECRET_KEY')),
  alpacaProxyUrl: nonEmptyString('BAYN_ALPACA_PROXY_URL').pipe(Config.withDefault('http://bayn-egress-proxy:3128')),
  alpacaRetryAttempts: Config.schema(RetryAttempts, 'BAYN_ALPACA_RETRY_ATTEMPTS').pipe(Config.withDefault(2)),
  reconciliationIntervalMs: positiveInteger('BAYN_RECONCILIATION_INTERVAL_MS', 30_000),
  clickhouseUrl: nonEmptyString('BAYN_CLICKHOUSE_URL'),
  clickhouseUsername: nonEmptyString('BAYN_CLICKHOUSE_USERNAME'),
  clickhousePassword: secretString('BAYN_CLICKHOUSE_PASSWORD'),
  snapshotId: Config.schema(Sha256Schema, 'BAYN_SIGNAL_SNAPSHOT_ID'),
  publicationAsOf: Config.schema(IsoDateSchema, 'BAYN_SIGNAL_PUBLICATION_ASOF'),
  calendarVersion: nonEmptyString('BAYN_SIGNAL_CALENDAR_VERSION'),
  dataStart: Config.schema(IsoDateSchema, 'BAYN_SIGNAL_DATA_START'),
  dataEnd: Config.schema(IsoDateSchema, 'BAYN_SIGNAL_DATA_END'),
  lookbackStart: Config.schema(IsoDateSchema, 'BAYN_SIGNAL_LOOKBACK_START'),
  evaluationStart: Config.schema(IsoDateSchema, 'BAYN_SIGNAL_EVALUATION_START'),
  evaluationEnd: Config.schema(IsoDateSchema, 'BAYN_SIGNAL_EVALUATION_END'),
  postgresUrl: Config.redacted('BAYN_POSTGRES_URL'),
  postgresTls: Config.boolean('BAYN_POSTGRES_TLS').pipe(Config.withDefault(true)),
  postgresCaPath: nonEmptyString('BAYN_POSTGRES_CA_PATH').pipe(
    Config.withDefault('/var/run/secrets/bayn/postgres/ca.crt'),
  ),
  tigerBeetleClusterId: Config.schema(Schema.BigIntFromString, 'BAYN_TIGERBEETLE_CLUSTER_ID').pipe(
    Config.withDefault(2001n),
  ),
  tigerBeetleReplicaAddresses: Config.schema(ReplicaAddresses, 'BAYN_TIGERBEETLE_ADDRESSES'),
  tigerBeetleLedger: positiveInteger('BAYN_TIGERBEETLE_LEDGER', 7001),
}).pipe(
  Config.map(
    (config): ParsedRuntimeConfig => ({
      host: config.host,
      port: config.port,
      qualificationRunId: Option.getOrUndefined(config.qualificationRunId),
      configuredOperation: Option.getOrUndefined(config.operation),
      legacyMaximumAuthority: Option.getOrUndefined(config.legacyMaximumAuthority),
      brokerAccess: config.brokerAccess,
      capitalAuthority: config.capitalAuthority,
      liveCapitalGrantHash: Option.getOrUndefined(config.liveCapitalGrantHash),
      configuredBuild: {
        sourceRevision: config.sourceRevision,
        imageRepository: config.imageRepository,
        imageDigest: config.imageDigest,
        strategyBehaviorHash: config.strategyBehaviorHash,
        strategyParameterHash: config.strategyParameterHash,
      },
      provenanceMode: config.provenanceMode,
      healthIntervalMs: config.healthIntervalMs,
      operationTimeoutMs: config.operationTimeoutMs,
      cycleStallThresholdMs: config.cycleStallThresholdMs,
      reconciliationStaleThresholdMs: config.reconciliationStaleThresholdMs,
      unknownMutationThresholdMs: config.unknownMutationThresholdMs,
      cyclePollIntervalMs: config.cyclePollIntervalMs,
      authorityGenerationHash: Option.getOrUndefined(config.authorityGenerationHash),
      configuredAlpaca: {
        provider: config.brokerProvider,
        environment: config.brokerEnvironment,
        baseUrl: config.alpacaBaseUrl,
        accountId: Option.getOrUndefined(config.alpacaAccountId),
        key: Option.getOrUndefined(config.alpacaKey),
        secret: Option.getOrUndefined(config.alpacaSecret),
        proxyUrl: config.alpacaProxyUrl,
        retryAttempts: config.alpacaRetryAttempts,
        reconciliationIntervalMs: config.reconciliationIntervalMs,
      },
      clickhouse: {
        url: config.clickhouseUrl,
        username: config.clickhouseUsername,
        password: config.clickhousePassword,
        snapshotId: config.snapshotId,
        publicationAsOf: config.publicationAsOf,
        calendarVersion: config.calendarVersion,
        bounds: {
          schemaVersion: 'bayn.evaluation-bounds.v1',
          dataStart: config.dataStart,
          dataEnd: config.dataEnd,
          lookbackStart: config.lookbackStart,
          evaluationStart: config.evaluationStart,
          evaluationEnd: config.evaluationEnd,
        },
      },
      postgres: {
        url: config.postgresUrl,
        tls: config.postgresTls,
        caPath: config.postgresCaPath,
      },
      tigerBeetle: {
        clusterId: config.tigerBeetleClusterId,
        replicaAddresses: config.tigerBeetleReplicaAddresses,
        ledger: config.tigerBeetleLedger,
      },
    }),
  ),
)

export const evaluationBoundsDecoder = Schema.decodeUnknownResult(EvaluationBoundsSchema)
