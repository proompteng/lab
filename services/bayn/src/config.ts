import { Config, Effect, Option, Redacted, Result, Schema, SchemaTransformation } from 'effect'

import { EmbeddedBuildMetadataSchema, embeddedBuildMetadata, type EmbeddedBuildMetadata } from './build'
import { EvaluationBoundsSchema, IsoDateSchema, Sha256Schema, type EvaluationBounds } from './contracts'
import { OperationalError, operationalError } from './errors'
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

export interface PaperProofRuntimeCommand {
  readonly command: 'PREPARE'
  readonly phase: 'DISCOVER'
}

export interface RuntimeConfig {
  readonly host: string
  readonly port: number
  readonly qualificationRunId?: string
  readonly paperProofCommand?: PaperProofRuntimeCommand
  readonly maximumAuthority: Authority
  readonly build: RuntimeBuildMetadata
  readonly healthIntervalMs: number
  readonly operationTimeoutMs: number
  readonly cycleStallThresholdMs: number
  readonly reconciliationStaleThresholdMs: number
  readonly unknownMutationThresholdMs: number
  readonly alpaca?: {
    readonly accountId: string
    readonly authorityGenerationHash: string
    readonly key: Redacted.Redacted<string>
    readonly secret: Redacted.Redacted<string>
    readonly proxyUrl: string
    readonly retryAttempts: number
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

export type LoadedRuntimeConfig = RuntimeConfig & AutonomousCycleRuntimeConfig

export interface ParsedRuntimeConfig {
  readonly host: string
  readonly port: number
  readonly qualificationRunId: string | undefined
  readonly configuredPaperProofCommand: 'PREPARE' | undefined
  readonly configuredPaperProofPhase: 'DISCOVER' | undefined
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
      readonly _tag: 'PaperAuthorityRequiresAlpacaBinding'
      readonly maximumAuthority: Authority.Paper
    }
  | {
      readonly _tag: 'IncompletePaperProofCommand'
      readonly commandConfigured: boolean
      readonly phaseConfigured: boolean
    }
  | {
      readonly _tag: 'PaperProofCommandRequiresObserveAuthority'
      readonly maximumAuthority: Authority.Paper
    }
  | {
      readonly _tag: 'PaperProofCommandRequiresQualificationRun'
    }
  | {
      readonly _tag: 'PaperProofCommandRequiresAlpacaBinding'
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
  paperProofCommand: Config.option(Config.schema(Schema.Literal('PREPARE'), 'BAYN_PAPER_COMMAND')),
  paperProofPhase: Config.option(Config.schema(Schema.Literal('DISCOVER'), 'BAYN_PAPER_PREPARE_PHASE')),
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
      configuredPaperProofCommand: Option.getOrUndefined(config.paperProofCommand),
      configuredPaperProofPhase: Option.getOrUndefined(config.paperProofPhase),
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

export const resolveRuntimeConfig = ({
  parsed: config,
  embeddedBuildMetadata: embedded,
}: RuntimeConfigResolutionInput): Result.Result<LoadedRuntimeConfig, RuntimeConfigResolutionFailure> => {
  const boundsResult = decodeEvaluationBounds(config.clickhouse.bounds)
  if (Result.isFailure(boundsResult)) {
    return Result.fail({ _tag: 'InvalidEvaluationBounds', cause: boundsResult.failure })
  }
  if (config.cyclePollIntervalMs >= config.cycleStallThresholdMs) {
    return Result.fail({
      _tag: 'CyclePollIntervalNotShorterThanStallThreshold',
      cyclePollIntervalMs: config.cyclePollIntervalMs,
      cycleStallThresholdMs: config.cycleStallThresholdMs,
    })
  }

  const credentialPresence = {
    accountId: config.configuredAlpaca.accountId !== undefined,
    keyId: config.configuredAlpaca.key !== undefined,
    secretKey: config.configuredAlpaca.secret !== undefined,
  } satisfies AlpacaCredentialPresence
  const anyCredential = credentialPresence.accountId || credentialPresence.keyId || credentialPresence.secretKey
  const credentials =
    config.configuredAlpaca.accountId !== undefined &&
    config.configuredAlpaca.key !== undefined &&
    config.configuredAlpaca.secret !== undefined
      ? {
          accountId: config.configuredAlpaca.accountId,
          key: config.configuredAlpaca.key,
          secret: config.configuredAlpaca.secret,
        }
      : undefined
  if (anyCredential && credentials === undefined) {
    return Result.fail({ _tag: 'IncompleteAlpacaCredentials', configured: credentialPresence })
  }

  let alpaca: RuntimeConfig['alpaca']
  if (credentials === undefined) {
    alpaca = undefined
  } else {
    if (config.authorityGenerationHash === undefined) {
      return Result.fail({ _tag: 'MissingAlpacaAuthorityGeneration' })
    }
    alpaca = {
      ...credentials,
      authorityGenerationHash: config.authorityGenerationHash,
      proxyUrl: config.configuredAlpaca.proxyUrl,
      retryAttempts: config.configuredAlpaca.retryAttempts,
      reconciliationIntervalMs: config.configuredAlpaca.reconciliationIntervalMs,
    }
  }
  if (config.maximumAuthority === Authority.Paper && alpaca === undefined) {
    return Result.fail({
      _tag: 'PaperAuthorityRequiresAlpacaBinding',
      maximumAuthority: Authority.Paper,
    })
  }

  const commandConfigured = config.configuredPaperProofCommand !== undefined
  const phaseConfigured = config.configuredPaperProofPhase !== undefined
  if (commandConfigured !== phaseConfigured) {
    return Result.fail({
      _tag: 'IncompletePaperProofCommand',
      commandConfigured,
      phaseConfigured,
    })
  }

  let paperProofCommand: PaperProofRuntimeCommand | undefined
  if (config.configuredPaperProofCommand !== undefined && config.configuredPaperProofPhase !== undefined) {
    if (config.maximumAuthority !== Authority.Observe) {
      return Result.fail({
        _tag: 'PaperProofCommandRequiresObserveAuthority',
        maximumAuthority: config.maximumAuthority,
      })
    }
    if (config.qualificationRunId === undefined) {
      return Result.fail({ _tag: 'PaperProofCommandRequiresQualificationRun' })
    }
    if (alpaca === undefined) {
      return Result.fail({ _tag: 'PaperProofCommandRequiresAlpacaBinding' })
    }
    paperProofCommand = {
      command: config.configuredPaperProofCommand,
      phase: config.configuredPaperProofPhase,
    }
  }

  if (embedded === undefined && config.provenanceMode !== 'development') {
    return Result.fail({
      _tag: 'ProductionProvenanceRequiresEmbeddedMetadata',
      provenanceMode: 'production',
    })
  }
  if (embedded !== undefined && config.provenanceMode !== 'production') {
    return Result.fail({
      _tag: 'EmbeddedMetadataRequiresProductionProvenance',
      provenanceMode: 'development',
    })
  }
  if (embedded !== undefined && !config.postgres.tls) {
    return Result.fail({
      _tag: 'ProductionPostgresRequiresTls',
      postgresTls: false,
    })
  }

  let decodedBuild: EmbeddedBuildMetadata
  if (embedded === undefined) {
    decodedBuild = {
      sourceRevision: config.configuredBuild.sourceRevision,
      imageRepository: config.configuredBuild.imageRepository,
      strategyBehaviorHash: config.configuredBuild.strategyBehaviorHash,
      strategyParameterHash: config.configuredBuild.strategyParameterHash,
    }
  } else {
    const decodedBuildResult = decodeEmbeddedBuildMetadata(embedded)
    if (Result.isFailure(decodedBuildResult)) {
      return Result.fail({
        _tag: 'InvalidEmbeddedBuildMetadata',
        cause: decodedBuildResult.failure,
      })
    }
    decodedBuild = decodedBuildResult.success
    if (config.configuredBuild.sourceRevision !== decodedBuild.sourceRevision) {
      return Result.fail({
        _tag: 'SourceRevisionMismatch',
        configuredSourceRevision: config.configuredBuild.sourceRevision,
        embeddedSourceRevision: decodedBuild.sourceRevision,
      })
    }
    if (config.configuredBuild.imageRepository !== decodedBuild.imageRepository) {
      return Result.fail({
        _tag: 'ImageRepositoryMismatch',
        configuredImageRepository: config.configuredBuild.imageRepository,
        embeddedImageRepository: decodedBuild.imageRepository,
      })
    }
    if (config.configuredBuild.strategyBehaviorHash !== decodedBuild.strategyBehaviorHash) {
      return Result.fail({
        _tag: 'StrategyBehaviorHashMismatch',
        configuredStrategyBehaviorHash: config.configuredBuild.strategyBehaviorHash,
        embeddedStrategyBehaviorHash: decodedBuild.strategyBehaviorHash,
      })
    }
    if (config.configuredBuild.strategyParameterHash !== decodedBuild.strategyParameterHash) {
      return Result.fail({
        _tag: 'StrategyParameterHashMismatch',
        configuredStrategyParameterHash: config.configuredBuild.strategyParameterHash,
        embeddedStrategyParameterHash: decodedBuild.strategyParameterHash,
      })
    }
  }

  const {
    configuredAlpaca: _configuredAlpaca,
    authorityGenerationHash: _authorityGenerationHash,
    configuredPaperProofCommand: _configuredPaperProofCommand,
    configuredPaperProofPhase: _configuredPaperProofPhase,
    configuredBuild,
    provenanceMode,
    ...runtime
  } = config
  const resolved: LoadedRuntimeConfig = {
    ...runtime,
    clickhouse: {
      ...runtime.clickhouse,
      bounds: boundsResult.success,
    },
    build: {
      ...decodedBuild,
      imageDigest: configuredBuild.imageDigest,
      verification: provenanceMode === 'production' ? 'embedded' : 'development-configured',
    },
    ...(paperProofCommand === undefined ? {} : { paperProofCommand }),
    ...(alpaca === undefined ? {} : { alpaca }),
  }
  return Result.succeed(resolved)
}

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
    case 'PaperAuthorityRequiresAlpacaBinding':
      return {
        operation: 'alpaca',
        message: 'PAPER maximum authority requires a complete Alpaca account binding',
      }
    case 'IncompletePaperProofCommand':
      return {
        operation: 'paper-command',
        message: 'BAYN_PAPER_COMMAND and BAYN_PAPER_PREPARE_PHASE must be configured together',
      }
    case 'PaperProofCommandRequiresObserveAuthority':
      return {
        operation: 'paper-command',
        message: 'PREPARE DISCOVER requires OBSERVE maximum authority',
      }
    case 'PaperProofCommandRequiresQualificationRun':
      return {
        operation: 'paper-command',
        message: 'PREPARE DISCOVER requires a pinned terminal qualification run',
      }
    case 'PaperProofCommandRequiresAlpacaBinding':
      return {
        operation: 'paper-command',
        message: 'PREPARE DISCOVER requires a complete Alpaca read binding',
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
