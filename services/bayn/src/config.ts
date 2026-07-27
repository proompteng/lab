import { Config, Effect, Option, pipe, Redacted, Result, Schema, SchemaTransformation } from 'effect'

import {
  BrokerProvider,
  alpacaSandboxBaseUrl,
  decodeBrokerConnection,
  renderBrokerConnectionDecodeFailure,
  type BrokerConnection,
  type BrokerConnectionDecodeFailure,
} from './broker/connection'
import { EmbeddedBuildMetadataSchema, embeddedBuildMetadata, type EmbeddedBuildMetadata } from './build'
import { EvaluationBoundsSchema, IsoDateSchema, Sha256Schema, type EvaluationBounds } from './contracts'
import { OperationalError, operationalError } from './errors'
import { BrokerEnvironment, BrokerEnvironmentSchema } from './execution/authority'
import { Authority } from './paper'
import {
  GitSourceRevisionSchema as SourceRevision,
  ImageDigestSchema as ImageDigest,
  ImageRepositorySchema as ImageRepository,
  PositiveIntegerSchema as PositiveInteger,
  TrimmedNonEmptyStringSchema as NonEmptyString,
  strictParseOptions as StrictParseOptions,
} from './schemas'

export interface RuntimeBuildMetadata extends EmbeddedBuildMetadata {
  readonly imageDigest: string
  readonly verification: 'embedded' | 'development-configured'
}

export interface RuntimeConfig {
  readonly host: string
  readonly port: number
  readonly qualificationRunId?: string
  readonly maximumAuthority: Authority
  readonly build: RuntimeBuildMetadata
  readonly healthIntervalMs: number
  readonly operationTimeoutMs: number
  readonly cycleStallThresholdMs: number
  readonly reconciliationStaleThresholdMs: number
  readonly unknownMutationThresholdMs: number
  readonly alpaca?: BrokerConnection & {
    readonly authorityGenerationHash: string
    readonly reconciliationIntervalMs: number
  }
  readonly clickhouse: {
    readonly url: string
    readonly username: string
    readonly password: Redacted.Redacted<string>
    readonly snapshotId: string
    readonly publicationAsOf: string
    readonly calendarVersion: string
    readonly bounds: EvaluationBounds
  }
  readonly postgres: {
    readonly url: Redacted.Redacted<string>
    readonly tls: boolean
    readonly caPath: string
  }
  readonly tigerBeetle: {
    readonly clusterId: bigint
    readonly replicaAddresses: readonly string[]
    readonly ledger: number
  }
}

export interface AutonomousCycleRuntimeConfig {
  readonly cyclePollIntervalMs: number
}

export type RuntimeOperation = 'PAPER_CANDIDATE_DISCOVERY'

export type AlpacaRuntimeConfig = NonNullable<RuntimeConfig['alpaca']>

type LoadedRuntimeConfigBase = Omit<RuntimeConfig, 'alpaca' | 'maximumAuthority' | 'qualificationRunId'> &
  AutonomousCycleRuntimeConfig

export type LoadedRuntimeConfig = LoadedRuntimeConfigBase &
  (
    | {
        readonly runtimeMode: 'BrokerlessService'
        readonly qualificationRunId?: string
        readonly maximumAuthority: Authority.Observe
        readonly alpaca?: undefined
      }
    | {
        readonly runtimeMode: 'AutonomousObserveService'
        readonly qualificationRunId?: string
        readonly maximumAuthority: Authority.Observe
        readonly alpaca: AlpacaRuntimeConfig
      }
    | {
        readonly runtimeMode: 'PaperCandidateDiscovery'
        readonly qualificationRunId: string
        readonly maximumAuthority: Authority.Observe
        readonly alpaca: AlpacaRuntimeConfig
      }
  )

export interface ParsedRuntimeConfig {
  readonly host: string
  readonly port: number
  readonly qualificationRunId: string | undefined
  readonly configuredOperation: RuntimeOperation | undefined
  readonly maximumAuthority: Authority
  readonly configuredBuild: EmbeddedBuildMetadata & {
    readonly imageDigest: string
  }
  readonly provenanceMode: 'production' | 'development'
  readonly healthIntervalMs: number
  readonly operationTimeoutMs: number
  readonly cycleStallThresholdMs: number
  readonly reconciliationStaleThresholdMs: number
  readonly unknownMutationThresholdMs: number
  readonly cyclePollIntervalMs: number
  readonly authorityGenerationHash: string | undefined
  readonly configuredAlpaca: {
    readonly provider: BrokerProvider
    readonly environment: BrokerEnvironment
    readonly baseUrl: string
    readonly accountId: string | undefined
    readonly key: Redacted.Redacted<string> | undefined
    readonly secret: Redacted.Redacted<string> | undefined
    readonly proxyUrl: string
    readonly retryAttempts: number
    readonly reconciliationIntervalMs: number
  }
  readonly clickhouse: RuntimeConfig['clickhouse']
  readonly postgres: RuntimeConfig['postgres']
  readonly tigerBeetle: RuntimeConfig['tigerBeetle']
}

export interface RuntimeConfigResolutionInput {
  readonly parsed: ParsedRuntimeConfig
  readonly embeddedBuildMetadata: EmbeddedBuildMetadata | undefined
}

interface AlpacaCredentialPresence {
  readonly accountId: boolean
  readonly keyId: boolean
  readonly secretKey: boolean
}

export type RuntimeConfigResolutionFailure =
  | {
      readonly _tag: 'InvalidEvaluationBounds'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'CyclePollIntervalNotShorterThanStallThreshold'
      readonly cyclePollIntervalMs: number
      readonly cycleStallThresholdMs: number
    }
  | {
      readonly _tag: 'IncompleteAlpacaCredentials'
      readonly configured: AlpacaCredentialPresence
    }
  | {
      readonly _tag: 'MissingAlpacaAuthorityGeneration'
    }
  | {
      readonly _tag: 'InvalidBrokerConnection'
      readonly cause: BrokerConnectionDecodeFailure
    }
  | {
      readonly _tag: 'PaperAuthorityRequiresAlpacaBinding'
      readonly maximumAuthority: Authority.Paper
    }
  | {
      readonly _tag: 'PaperAuthorityRequiresBoundedOperation'
      readonly maximumAuthority: Authority.Paper
    }
  | {
      readonly _tag: 'PaperCandidateDiscoveryRequiresObserveAuthority'
      readonly maximumAuthority: Authority.Paper
    }
  | {
      readonly _tag: 'PaperCandidateDiscoveryRequiresQualificationRun'
    }
  | {
      readonly _tag: 'PaperCandidateDiscoveryRequiresAlpacaBinding'
    }
  | {
      readonly _tag: 'ProductionProvenanceRequiresEmbeddedMetadata'
      readonly provenanceMode: 'production'
    }
  | {
      readonly _tag: 'EmbeddedMetadataRequiresProductionProvenance'
      readonly provenanceMode: 'development'
    }
  | {
      readonly _tag: 'ProductionPostgresRequiresTls'
      readonly postgresTls: false
    }
  | {
      readonly _tag: 'InvalidEmbeddedBuildMetadata'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'SourceRevisionMismatch'
      readonly configuredSourceRevision: string
      readonly embeddedSourceRevision: string
    }
  | {
      readonly _tag: 'ImageRepositoryMismatch'
      readonly configuredImageRepository: string
      readonly embeddedImageRepository: string
    }
  | {
      readonly _tag: 'StrategyBehaviorHashMismatch'
      readonly configuredStrategyBehaviorHash: string
      readonly embeddedStrategyBehaviorHash: string
    }
  | {
      readonly _tag: 'StrategyParameterHashMismatch'
      readonly configuredStrategyParameterHash: string
      readonly embeddedStrategyParameterHash: string
    }

const ProvenanceMode = Schema.Literals(['production', 'development'])
const RetryAttempts = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))
const OperationalThresholdMs = Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 86_400_000 }))
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

const runtimeConfig = Config.all({
  host: nonEmptyString('BAYN_HTTP_HOST').pipe(Config.withDefault('0.0.0.0')),
  port: Config.port('BAYN_HTTP_PORT').pipe(Config.withDefault(8080)),
  sourceRevision: Config.schema(SourceRevision, 'BAYN_CODE_REVISION'),
  imageRepository: Config.schema(ImageRepository, 'BAYN_IMAGE_REPOSITORY'),
  imageDigest: Config.schema(ImageDigest, 'BAYN_IMAGE_DIGEST'),
  strategyBehaviorHash: Config.schema(Sha256Schema, 'BAYN_STRATEGY_BEHAVIOR_HASH'),
  strategyParameterHash: Config.schema(Sha256Schema, 'BAYN_STRATEGY_PARAMETER_HASH'),
  provenanceMode: Config.schema(ProvenanceMode, 'BAYN_PROVENANCE_MODE').pipe(Config.withDefault('production')),
  qualificationRunId: Config.option(Config.schema(Sha256Schema, 'BAYN_QUALIFICATION_RUN_ID')),
  operation: Config.option(Config.schema(Schema.Literal('PAPER_CANDIDATE_DISCOVERY'), 'BAYN_OPERATION')),
  maximumAuthority: Config.schema(Schema.Enum(Authority), 'BAYN_MAXIMUM_AUTHORITY').pipe(
    Config.withDefault(Authority.Observe),
  ),
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
      maximumAuthority: config.maximumAuthority,
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

const decodeEvaluationBounds = Schema.decodeUnknownResult(EvaluationBoundsSchema)
const decodeEmbeddedBuildMetadata = Schema.decodeUnknownResult(EmbeddedBuildMetadataSchema, StrictParseOptions)

type RuntimeModeResolutionInput = {
  readonly configuredOperation: RuntimeOperation | undefined
  readonly qualificationRunId: string | undefined
  readonly maximumAuthority: Authority
  readonly alpaca: AlpacaRuntimeConfig | undefined
}

type RuntimeModeSelection =
  | {
      readonly runtimeMode: 'BrokerlessService'
      readonly qualificationRunId: string | undefined
      readonly maximumAuthority: Authority.Observe
      readonly alpaca: undefined
    }
  | {
      readonly runtimeMode: 'AutonomousObserveService'
      readonly qualificationRunId: string | undefined
      readonly maximumAuthority: Authority.Observe
      readonly alpaca: AlpacaRuntimeConfig
    }
  | {
      readonly runtimeMode: 'PaperCandidateDiscovery'
      readonly qualificationRunId: string
      readonly maximumAuthority: Authority.Observe
      readonly alpaca: AlpacaRuntimeConfig
    }

const serviceRuntimeMode = (
  input: RuntimeModeResolutionInput,
): Result.Result<RuntimeModeSelection, RuntimeConfigResolutionFailure> => {
  if (input.alpaca === undefined) {
    return input.maximumAuthority === Authority.Observe
      ? Result.succeed({
          runtimeMode: 'BrokerlessService',
          qualificationRunId: input.qualificationRunId,
          maximumAuthority: Authority.Observe,
          alpaca: undefined,
        })
      : Result.fail({
          _tag: 'PaperAuthorityRequiresAlpacaBinding',
          maximumAuthority: Authority.Paper,
        })
  }
  return input.maximumAuthority === Authority.Observe
    ? Result.succeed({
        runtimeMode: 'AutonomousObserveService',
        qualificationRunId: input.qualificationRunId,
        maximumAuthority: Authority.Observe,
        alpaca: input.alpaca,
      })
    : Result.fail({
        _tag: 'PaperAuthorityRequiresBoundedOperation',
        maximumAuthority: Authority.Paper,
      })
}

const paperCandidateDiscoveryMode = (
  input: RuntimeModeResolutionInput,
): Result.Result<RuntimeModeSelection, RuntimeConfigResolutionFailure> => {
  if (input.maximumAuthority === Authority.Paper) {
    return Result.fail({
      _tag: 'PaperCandidateDiscoveryRequiresObserveAuthority',
      maximumAuthority: Authority.Paper,
    })
  }
  if (input.qualificationRunId === undefined) {
    return Result.fail({ _tag: 'PaperCandidateDiscoveryRequiresQualificationRun' })
  }
  if (input.alpaca === undefined) {
    return Result.fail({ _tag: 'PaperCandidateDiscoveryRequiresAlpacaBinding' })
  }
  return Result.succeed({
    runtimeMode: 'PaperCandidateDiscovery',
    qualificationRunId: input.qualificationRunId,
    maximumAuthority: Authority.Observe,
    alpaca: input.alpaca,
  })
}

const resolveRuntimeMode = (
  input: RuntimeModeResolutionInput,
): Result.Result<RuntimeModeSelection, RuntimeConfigResolutionFailure> =>
  input.configuredOperation === undefined ? serviceRuntimeMode(input) : paperCandidateDiscoveryMode(input)

const attachRuntimeMode = (base: LoadedRuntimeConfigBase, selection: RuntimeModeSelection): LoadedRuntimeConfig => ({
  ...base,
  ...selection,
})

type BoundsResolved = RuntimeConfigResolutionInput & {
  readonly evaluationBounds: EvaluationBounds
}

type AlpacaCredentials = {
  readonly accountId: string
  readonly key: Redacted.Redacted<string>
  readonly secret: Redacted.Redacted<string>
}

type CredentialsResolved = BoundsResolved & {
  readonly alpacaCredentials: AlpacaCredentials | undefined
}

type AlpacaResolved = CredentialsResolved & {
  readonly alpaca: AlpacaRuntimeConfig | undefined
}

type RuntimeModeResolved = AlpacaResolved & {
  readonly runtimeMode: RuntimeModeSelection
}

type BuildResolved = RuntimeModeResolved & {
  readonly decodedBuild: EmbeddedBuildMetadata
}

const resolveEvaluationBounds = (
  input: RuntimeConfigResolutionInput,
): Result.Result<BoundsResolved, RuntimeConfigResolutionFailure> =>
  pipe(
    decodeEvaluationBounds(input.parsed.clickhouse.bounds),
    Result.mapError(
      (cause): RuntimeConfigResolutionFailure => ({
        _tag: 'InvalidEvaluationBounds',
        cause,
      }),
    ),
    Result.map((evaluationBounds) => ({ ...input, evaluationBounds })),
  )

const validateCycleTiming = (input: BoundsResolved): Result.Result<BoundsResolved, RuntimeConfigResolutionFailure> =>
  input.parsed.cyclePollIntervalMs < input.parsed.cycleStallThresholdMs
    ? Result.succeed(input)
    : Result.fail({
        _tag: 'CyclePollIntervalNotShorterThanStallThreshold',
        cyclePollIntervalMs: input.parsed.cyclePollIntervalMs,
        cycleStallThresholdMs: input.parsed.cycleStallThresholdMs,
      })

const alpacaCredentialPresence = (config: ParsedRuntimeConfig): AlpacaCredentialPresence => ({
  accountId: config.configuredAlpaca.accountId !== undefined,
  keyId: config.configuredAlpaca.key !== undefined,
  secretKey: config.configuredAlpaca.secret !== undefined,
})

const completeAlpacaCredentials = (config: ParsedRuntimeConfig): Option.Option<AlpacaCredentials> =>
  Option.all({
    accountId: Option.fromNullishOr(config.configuredAlpaca.accountId),
    key: Option.fromNullishOr(config.configuredAlpaca.key),
    secret: Option.fromNullishOr(config.configuredAlpaca.secret),
  })

const hasAnyAlpacaCredential = (presence: AlpacaCredentialPresence): boolean =>
  presence.accountId || presence.keyId || presence.secretKey

const resolveAlpacaCredentials = (
  input: BoundsResolved,
): Result.Result<CredentialsResolved, RuntimeConfigResolutionFailure> => {
  const presence = alpacaCredentialPresence(input.parsed)
  const alpacaCredentials = Option.getOrUndefined(completeAlpacaCredentials(input.parsed))
  return !hasAnyAlpacaCredential(presence) || alpacaCredentials !== undefined
    ? Result.succeed({ ...input, alpacaCredentials })
    : Result.fail({
        _tag: 'IncompleteAlpacaCredentials',
        configured: presence,
      })
}

const resolveAlpacaBinding = (
  input: CredentialsResolved,
): Result.Result<AlpacaResolved, RuntimeConfigResolutionFailure> => {
  if (input.alpacaCredentials === undefined) return Result.succeed({ ...input, alpaca: undefined })
  if (input.parsed.authorityGenerationHash === undefined) {
    return Result.fail({ _tag: 'MissingAlpacaAuthorityGeneration' })
  }
  const authorityGenerationHash = input.parsed.authorityGenerationHash
  return pipe(
    decodeBrokerConnection({
      provider: input.parsed.configuredAlpaca.provider,
      environment: input.parsed.configuredAlpaca.environment,
      baseUrl: input.parsed.configuredAlpaca.baseUrl,
      expectedAccountId: input.alpacaCredentials.accountId,
      key: input.alpacaCredentials.key,
      secret: input.alpacaCredentials.secret,
      proxyUrl: input.parsed.configuredAlpaca.proxyUrl,
      operationTimeoutMs: input.parsed.operationTimeoutMs,
      retryAttempts: input.parsed.configuredAlpaca.retryAttempts,
    }),
    Result.mapError(
      (cause): RuntimeConfigResolutionFailure => ({
        _tag: 'InvalidBrokerConnection',
        cause,
      }),
    ),
    Result.map((connection) => ({
      ...input,
      alpaca: {
        ...connection,
        authorityGenerationHash,
        reconciliationIntervalMs: input.parsed.configuredAlpaca.reconciliationIntervalMs,
      },
    })),
  )
}

const resolveConfiguredRuntimeMode = (
  input: AlpacaResolved,
): Result.Result<RuntimeModeResolved, RuntimeConfigResolutionFailure> =>
  pipe(
    resolveRuntimeMode({
      configuredOperation: input.parsed.configuredOperation,
      qualificationRunId: input.parsed.qualificationRunId,
      maximumAuthority: input.parsed.maximumAuthority,
      alpaca: input.alpaca,
    }),
    Result.map((runtimeMode) => ({ ...input, runtimeMode })),
  )

const validateProvenanceMode = (
  input: RuntimeModeResolved,
): Result.Result<RuntimeModeResolved, RuntimeConfigResolutionFailure> => {
  if (input.embeddedBuildMetadata === undefined) {
    return input.parsed.provenanceMode === 'development'
      ? Result.succeed(input)
      : Result.fail({
          _tag: 'ProductionProvenanceRequiresEmbeddedMetadata',
          provenanceMode: 'production',
        })
  }
  return input.parsed.provenanceMode === 'production'
    ? Result.succeed(input)
    : Result.fail({
        _tag: 'EmbeddedMetadataRequiresProductionProvenance',
        provenanceMode: 'development',
      })
}

const validateProductionPostgresTls = (
  input: RuntimeModeResolved,
): Result.Result<RuntimeModeResolved, RuntimeConfigResolutionFailure> =>
  input.embeddedBuildMetadata === undefined || input.parsed.postgres.tls
    ? Result.succeed(input)
    : Result.fail({
        _tag: 'ProductionPostgresRequiresTls',
        postgresTls: false,
      })

const configuredBuildMetadata = (config: ParsedRuntimeConfig): EmbeddedBuildMetadata => ({
  sourceRevision: config.configuredBuild.sourceRevision,
  imageRepository: config.configuredBuild.imageRepository,
  strategyBehaviorHash: config.configuredBuild.strategyBehaviorHash,
  strategyParameterHash: config.configuredBuild.strategyParameterHash,
})

const resolveBuildMetadata = (
  input: RuntimeModeResolved,
): Result.Result<BuildResolved, RuntimeConfigResolutionFailure> => {
  if (input.embeddedBuildMetadata === undefined) {
    return Result.succeed({
      ...input,
      decodedBuild: configuredBuildMetadata(input.parsed),
    })
  }
  return pipe(
    decodeEmbeddedBuildMetadata(input.embeddedBuildMetadata),
    Result.mapError(
      (cause): RuntimeConfigResolutionFailure => ({
        _tag: 'InvalidEmbeddedBuildMetadata',
        cause,
      }),
    ),
    Result.map((decodedBuild) => ({ ...input, decodedBuild })),
  )
}

const validateSourceRevision = (input: BuildResolved): Result.Result<BuildResolved, RuntimeConfigResolutionFailure> =>
  input.parsed.configuredBuild.sourceRevision === input.decodedBuild.sourceRevision
    ? Result.succeed(input)
    : Result.fail({
        _tag: 'SourceRevisionMismatch',
        configuredSourceRevision: input.parsed.configuredBuild.sourceRevision,
        embeddedSourceRevision: input.decodedBuild.sourceRevision,
      })

const validateImageRepository = (input: BuildResolved): Result.Result<BuildResolved, RuntimeConfigResolutionFailure> =>
  input.parsed.configuredBuild.imageRepository === input.decodedBuild.imageRepository
    ? Result.succeed(input)
    : Result.fail({
        _tag: 'ImageRepositoryMismatch',
        configuredImageRepository: input.parsed.configuredBuild.imageRepository,
        embeddedImageRepository: input.decodedBuild.imageRepository,
      })

const validateStrategyBehaviorHash = (
  input: BuildResolved,
): Result.Result<BuildResolved, RuntimeConfigResolutionFailure> =>
  input.parsed.configuredBuild.strategyBehaviorHash === input.decodedBuild.strategyBehaviorHash
    ? Result.succeed(input)
    : Result.fail({
        _tag: 'StrategyBehaviorHashMismatch',
        configuredStrategyBehaviorHash: input.parsed.configuredBuild.strategyBehaviorHash,
        embeddedStrategyBehaviorHash: input.decodedBuild.strategyBehaviorHash,
      })

const validateStrategyParameterHash = (
  input: BuildResolved,
): Result.Result<BuildResolved, RuntimeConfigResolutionFailure> =>
  input.parsed.configuredBuild.strategyParameterHash === input.decodedBuild.strategyParameterHash
    ? Result.succeed(input)
    : Result.fail({
        _tag: 'StrategyParameterHashMismatch',
        configuredStrategyParameterHash: input.parsed.configuredBuild.strategyParameterHash,
        embeddedStrategyParameterHash: input.decodedBuild.strategyParameterHash,
      })

const assembleLoadedRuntimeConfig = ({
  parsed: config,
  evaluationBounds,
  runtimeMode,
  decodedBuild,
}: BuildResolved): LoadedRuntimeConfig => {
  const {
    configuredAlpaca: _configuredAlpaca,
    authorityGenerationHash: _authorityGenerationHash,
    configuredOperation: _configuredOperation,
    qualificationRunId: _qualificationRunId,
    maximumAuthority: _maximumAuthority,
    configuredBuild,
    provenanceMode,
    ...runtime
  } = config
  return attachRuntimeMode(
    {
      ...runtime,
      clickhouse: {
        ...runtime.clickhouse,
        bounds: evaluationBounds,
      },
      build: {
        ...decodedBuild,
        imageDigest: configuredBuild.imageDigest,
        verification: provenanceMode === 'production' ? 'embedded' : 'development-configured',
      },
    },
    runtimeMode,
  )
}

export const resolveRuntimeConfig = (
  input: RuntimeConfigResolutionInput,
): Result.Result<LoadedRuntimeConfig, RuntimeConfigResolutionFailure> =>
  pipe(
    resolveEvaluationBounds(input),
    Result.flatMap(validateCycleTiming),
    Result.flatMap(resolveAlpacaCredentials),
    Result.flatMap(resolveAlpacaBinding),
    Result.flatMap(resolveConfiguredRuntimeMode),
    Result.flatMap(validateProvenanceMode),
    Result.flatMap(validateProductionPostgresTls),
    Result.flatMap(resolveBuildMetadata),
    Result.flatMap(validateSourceRevision),
    Result.flatMap(validateImageRepository),
    Result.flatMap(validateStrategyBehaviorHash),
    Result.flatMap(validateStrategyParameterHash),
    Result.map(assembleLoadedRuntimeConfig),
  )

interface RuntimeConfigFailurePresentation {
  readonly operation: string
  readonly message: string
}

const presentRuntimeConfigFailure = (failure: RuntimeConfigResolutionFailure): RuntimeConfigFailurePresentation => {
  switch (failure._tag) {
    case 'InvalidEvaluationBounds':
      return {
        operation: 'load',
        message: `invalid Signal evaluation bounds: ${failure.cause.message}`,
      }
    case 'CyclePollIntervalNotShorterThanStallThreshold':
      return {
        operation: 'cycle-loop',
        message: 'cycle poll interval must be shorter than the cycle stall threshold',
      }
    case 'IncompleteAlpacaCredentials':
      return {
        operation: 'alpaca',
        message: 'Alpaca account ID, key ID, and secret key must be configured together',
      }
    case 'MissingAlpacaAuthorityGeneration':
      return {
        operation: 'authority-generation',
        message: 'Alpaca account binding requires an authority generation hash',
      }
    case 'InvalidBrokerConnection':
      return {
        operation: 'broker-connection',
        message: renderBrokerConnectionDecodeFailure(failure.cause),
      }
    case 'PaperAuthorityRequiresAlpacaBinding':
      return {
        operation: 'alpaca',
        message: 'PAPER maximum authority requires a complete Alpaca account binding',
      }
    case 'PaperAuthorityRequiresBoundedOperation':
      return {
        operation: 'operation',
        message: 'PAPER maximum authority requires an explicit bounded runtime operation',
      }
    case 'PaperCandidateDiscoveryRequiresObserveAuthority':
      return {
        operation: 'operation',
        message: 'PAPER_CANDIDATE_DISCOVERY requires OBSERVE maximum authority',
      }
    case 'PaperCandidateDiscoveryRequiresQualificationRun':
      return {
        operation: 'operation',
        message: 'PAPER_CANDIDATE_DISCOVERY requires a pinned terminal qualification run',
      }
    case 'PaperCandidateDiscoveryRequiresAlpacaBinding':
      return {
        operation: 'operation',
        message: 'PAPER_CANDIDATE_DISCOVERY requires a complete Alpaca read binding',
      }
    case 'ProductionProvenanceRequiresEmbeddedMetadata':
      return {
        operation: 'provenance',
        message: 'invalid build provenance: production provenance requires compile-time build metadata',
      }
    case 'EmbeddedMetadataRequiresProductionProvenance':
      return {
        operation: 'provenance',
        message: 'invalid build provenance: development provenance cannot override embedded production metadata',
      }
    case 'ProductionPostgresRequiresTls':
      return {
        operation: 'provenance',
        message: 'invalid build provenance: production PostgreSQL connections require verified TLS',
      }
    case 'InvalidEmbeddedBuildMetadata':
      return {
        operation: 'provenance',
        message: `invalid build provenance: ${failure.cause.message}`,
      }
    case 'SourceRevisionMismatch':
      return {
        operation: 'provenance',
        message: `invalid build provenance: configured source revision ${failure.configuredSourceRevision} does not match embedded revision ${failure.embeddedSourceRevision}`,
      }
    case 'ImageRepositoryMismatch':
      return {
        operation: 'provenance',
        message: `invalid build provenance: configured image repository ${failure.configuredImageRepository} does not match embedded repository ${failure.embeddedImageRepository}`,
      }
    case 'StrategyBehaviorHashMismatch':
      return {
        operation: 'provenance',
        message: 'invalid build provenance: configured strategy behavior hash does not match embedded build metadata',
      }
    case 'StrategyParameterHashMismatch':
      return {
        operation: 'provenance',
        message: 'invalid build provenance: configured strategy parameter hash does not match embedded build metadata',
      }
  }
  const exhaustive: never = failure
  return exhaustive
}

const resolutionFailureToOperationalError = (failure: RuntimeConfigResolutionFailure): OperationalError => {
  const presentation = presentRuntimeConfigFailure(failure)
  return new OperationalError({
    component: 'config',
    operation: presentation.operation,
    message: presentation.message,
    retryable: false,
    cause: failure,
  })
}

export const loadConfig = (
  embedded: EmbeddedBuildMetadata | undefined = embeddedBuildMetadata,
): Effect.Effect<LoadedRuntimeConfig, OperationalError> =>
  runtimeConfig.pipe(
    Effect.mapError((cause) => operationalError('config', 'load', 'invalid runtime configuration', cause)),
    Effect.flatMap((parsed) =>
      Effect.fromResult(resolveRuntimeConfig({ parsed, embeddedBuildMetadata: embedded })).pipe(
        Effect.mapError(resolutionFailureToOperationalError),
      ),
    ),
  )
