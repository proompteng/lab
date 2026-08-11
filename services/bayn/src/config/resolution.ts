import { Redacted, Result, Schema } from 'effect'

import { decodeBrokerConnection, type BrokerConnection } from '../broker/connection'
import { BrokerEnvironment } from '../broker/identity'
import { EmbeddedBuildMetadataSchema, type EmbeddedBuildMetadata } from '../build'
import { BrokerAccess, CapitalAuthorityKind } from '../execution/authority'
import { CapitalAuthoritySelection, resolveExecutionPolicy, type ExecutionPolicy } from '../execution/configuration'
import { strictParseOptions as StrictParseOptions } from '../schemas'
import type {
  AlpacaCredentialPresence,
  AlpacaRuntimeConfig,
  LegacyAuthorityToken,
  LoadedRuntimeConfig,
  ParsedRuntimeConfig,
  RuntimeBuildMetadata,
  RuntimeConfigResolutionFailure,
  RuntimeConfigResolutionInput,
} from './model'
import { evaluationBoundsDecoder } from './source'

const decodeEmbeddedBuildMetadata = Schema.decodeUnknownResult(EmbeddedBuildMetadataSchema, StrictParseOptions)

const fail = <A>(failure: RuntimeConfigResolutionFailure): Result.Result<A, RuntimeConfigResolutionFailure> =>
  Result.fail(failure)

const decodeBounds = (
  parsed: ParsedRuntimeConfig,
): Result.Result<ParsedRuntimeConfig, RuntimeConfigResolutionFailure> => {
  const decoded = evaluationBoundsDecoder(parsed.clickhouse.bounds)
  return Result.isFailure(decoded)
    ? fail({ _tag: 'InvalidEvaluationBounds', cause: decoded.failure })
    : Result.succeed({
        ...parsed,
        clickhouse: { ...parsed.clickhouse, bounds: decoded.success },
      })
}

const validateCycleTiming = (
  parsed: ParsedRuntimeConfig,
): Result.Result<ParsedRuntimeConfig, RuntimeConfigResolutionFailure> =>
  parsed.cyclePollIntervalMs < parsed.cycleStallThresholdMs
    ? Result.succeed(parsed)
    : fail({
        _tag: 'CyclePollIntervalNotShorterThanStallThreshold',
        cyclePollIntervalMs: parsed.cyclePollIntervalMs,
        cycleStallThresholdMs: parsed.cycleStallThresholdMs,
      })

const validateLifecyclePorts = (
  parsed: ParsedRuntimeConfig,
): Result.Result<ParsedRuntimeConfig, RuntimeConfigResolutionFailure> =>
  parsed.lifecycleOwner === 'Process' || parsed.port !== parsed.lifecycleCommandPort
    ? Result.succeed(parsed)
    : fail({
        _tag: 'LifecycleCommandPortConflict',
        httpPort: parsed.port,
        lifecycleCommandPort: parsed.lifecycleCommandPort,
      })

const validateLifecycleMode = (
  parsed: ParsedRuntimeConfig,
  alpaca: AlpacaRuntimeConfig | undefined,
): Result.Result<void, RuntimeConfigResolutionFailure> =>
  parsed.lifecycleOwner === 'Process' || (alpaca !== undefined && parsed.configuredOperation === undefined)
    ? Result.succeed(undefined)
    : fail({ _tag: 'RestateLifecycleRequiresAutonomousService' })

const validatePaperReconciliationTiming = (
  parsed: ParsedRuntimeConfig,
  execution: ExecutionPolicy,
  alpaca: AlpacaRuntimeConfig | undefined,
): Result.Result<void, RuntimeConfigResolutionFailure> => {
  const mutationCapable = execution.brokerAccess === BrokerAccess.Mutation
  if (!mutationCapable || alpaca === undefined) return Result.succeed(undefined)
  const reconciliationPassTimeoutMs = parsed.operationTimeoutMs
  const priorReconciliationTailTimeoutMs = reconciliationPassTimeoutMs
  const requiredFreshnessWindowMs =
    BigInt(alpaca.reconciliationIntervalMs) +
    BigInt(priorReconciliationTailTimeoutMs) +
    BigInt(reconciliationPassTimeoutMs)
  if (requiredFreshnessWindowMs < BigInt(parsed.reconciliationStaleThresholdMs)) {
    return Result.succeed(undefined)
  }
  return fail({
    _tag: 'PaperReconciliationCadenceNotWithinStaleThreshold',
    reconciliationIntervalMs: alpaca.reconciliationIntervalMs,
    priorReconciliationTailTimeoutMs,
    reconciliationPassTimeoutMs,
    reconciliationStaleThresholdMs: parsed.reconciliationStaleThresholdMs,
  })
}

const credentialPresence = (parsed: ParsedRuntimeConfig): AlpacaCredentialPresence => ({
  accountId: parsed.configuredAlpaca.accountId !== undefined,
  keyId: parsed.configuredAlpaca.key !== undefined,
  secretKey: parsed.configuredAlpaca.secret !== undefined,
})

const configuredCredentialCount = (presence: AlpacaCredentialPresence): number =>
  Number(presence.accountId) + Number(presence.keyId) + Number(presence.secretKey)

const decodeAlpaca = (
  parsed: ParsedRuntimeConfig,
): Result.Result<AlpacaRuntimeConfig | undefined, RuntimeConfigResolutionFailure> => {
  const configured = credentialPresence(parsed)
  const count = configuredCredentialCount(configured)
  if (count === 0) return Result.succeed(undefined)
  if (count !== 3) return fail({ _tag: 'IncompleteAlpacaCredentials', configured })
  if (parsed.authorityGenerationHash === undefined) return fail({ _tag: 'MissingAlpacaAuthorityGeneration' })

  const accountId = parsed.configuredAlpaca.accountId
  const key = parsed.configuredAlpaca.key
  const secret = parsed.configuredAlpaca.secret
  if (accountId === undefined || key === undefined || secret === undefined) {
    return fail({ _tag: 'IncompleteAlpacaCredentials', configured })
  }
  const decoded = decodeBrokerConnection({
    provider: parsed.configuredAlpaca.provider,
    environment: parsed.configuredAlpaca.environment,
    baseUrl: parsed.configuredAlpaca.baseUrl,
    expectedAccountId: accountId,
    key,
    secret,
    proxyUrl: parsed.configuredAlpaca.proxyUrl,
    operationTimeoutMs: parsed.operationTimeoutMs,
    retryAttempts: parsed.configuredAlpaca.retryAttempts,
  })
  return Result.isFailure(decoded)
    ? fail({ _tag: 'InvalidBrokerConnection', cause: decoded.failure })
    : Result.succeed({
        ...decoded.success,
        authorityGenerationHash: parsed.authorityGenerationHash,
        reconciliationIntervalMs: parsed.configuredAlpaca.reconciliationIntervalMs,
      })
}

const resolvePolicy = (
  parsed: ParsedRuntimeConfig,
  alpaca: AlpacaRuntimeConfig | undefined,
): Result.Result<ExecutionPolicy, RuntimeConfigResolutionFailure> => {
  const policy = resolveExecutionPolicy({
    brokerIdentity: alpaca?.identity,
    brokerAccess: parsed.brokerAccess,
    capitalAuthority: parsed.capitalAuthority,
    authorityGenerationHash:
      parsed.capitalAuthority === CapitalAuthoritySelection.None ? undefined : parsed.authorityGenerationHash,
    liveCapitalGrantHash: parsed.liveCapitalGrantHash,
  })
  return Result.isFailure(policy)
    ? fail({ _tag: 'InvalidExecutionPolicy', cause: policy.failure })
    : Result.succeed(policy.success)
}

const legacyAuthorityMatches = (legacy: LegacyAuthorityToken, policy: ExecutionPolicy): boolean => {
  switch (legacy) {
    case 'OBSERVE':
      return policy.brokerAccess === BrokerAccess.ReadOnly && policy.capitalAuthority._tag === CapitalAuthorityKind.None
    case 'PAPER':
      return (
        policy.brokerAccess === BrokerAccess.Mutation && policy.capitalAuthority._tag === CapitalAuthorityKind.Sandbox
      )
  }
}

const validateLegacyAuthority = (
  parsed: ParsedRuntimeConfig,
  policy: ExecutionPolicy,
): Result.Result<void, RuntimeConfigResolutionFailure> =>
  parsed.legacyMaximumAuthority === undefined || legacyAuthorityMatches(parsed.legacyMaximumAuthority, policy)
    ? Result.succeed(undefined)
    : fail({
        _tag: 'LegacyAuthorityMismatch',
        legacyMaximumAuthority: parsed.legacyMaximumAuthority,
        brokerAccess: parsed.brokerAccess,
        capitalAuthority: parsed.capitalAuthority,
      })

const validateOperation = (
  parsed: ParsedRuntimeConfig,
  policy: ExecutionPolicy,
  alpaca: AlpacaRuntimeConfig | undefined,
): Result.Result<void, RuntimeConfigResolutionFailure> => {
  if (parsed.configuredOperation === undefined) return Result.succeed(undefined)
  if (policy.brokerAccess !== BrokerAccess.ReadOnly || policy.capitalAuthority._tag !== CapitalAuthorityKind.None) {
    return fail({
      _tag: 'ExecutionCandidateDiscoveryRequiresReadOnlyNoCapital',
      brokerAccess: parsed.brokerAccess,
      capitalAuthority: parsed.capitalAuthority,
    })
  }
  if (parsed.qualificationRunId === undefined) {
    return fail({ _tag: 'ExecutionCandidateDiscoveryRequiresQualificationRun' })
  }
  if (alpaca === undefined) return fail({ _tag: 'ExecutionCandidateDiscoveryRequiresAlpacaBinding' })
  if (parsed.configuredOperation === 'ExecutionPrepare') {
    if (parsed.executionPrepareRequest === undefined) return fail({ _tag: 'ExecutionPrepareRequiresRequest' })
    if (alpaca.environment !== BrokerEnvironment.Sandbox) {
      return fail({
        _tag: 'ExecutionPrepareRequiresSandboxBroker',
        brokerEnvironment: alpaca.environment,
      })
    }
  }
  return Result.succeed(undefined)
}

const validateProvenanceMode = (
  parsed: ParsedRuntimeConfig,
  embedded: EmbeddedBuildMetadata | undefined,
): Result.Result<void, RuntimeConfigResolutionFailure> => {
  if (parsed.provenanceMode === 'production' && embedded === undefined) {
    return fail({ _tag: 'ProductionProvenanceRequiresEmbeddedMetadata', provenanceMode: 'production' })
  }
  if (parsed.provenanceMode === 'development' && embedded !== undefined) {
    return fail({ _tag: 'EmbeddedMetadataRequiresProductionProvenance', provenanceMode: 'development' })
  }
  return Result.succeed(undefined)
}

const validatePostgresTls = (parsed: ParsedRuntimeConfig): Result.Result<void, RuntimeConfigResolutionFailure> =>
  parsed.provenanceMode === 'production' && !parsed.postgres.tls
    ? fail({ _tag: 'ProductionPostgresRequiresTls', postgresTls: false })
    : Result.succeed(undefined)

const runtimeBuildMetadata = (
  parsed: ParsedRuntimeConfig,
  embedded: EmbeddedBuildMetadata | undefined,
): Result.Result<RuntimeBuildMetadata, RuntimeConfigResolutionFailure> => {
  if (embedded === undefined) {
    return Result.succeed({
      ...parsed.configuredBuild,
      verification: 'development-configured',
    })
  }
  const decoded = decodeEmbeddedBuildMetadata(embedded)
  if (Result.isFailure(decoded)) return fail({ _tag: 'InvalidEmbeddedBuildMetadata', cause: decoded.failure })
  const verified = decoded.success
  if (parsed.configuredBuild.sourceRevision !== verified.sourceRevision) {
    return fail({
      _tag: 'SourceRevisionMismatch',
      configuredSourceRevision: parsed.configuredBuild.sourceRevision,
      embeddedSourceRevision: verified.sourceRevision,
    })
  }
  if (parsed.configuredBuild.imageRepository !== verified.imageRepository) {
    return fail({
      _tag: 'ImageRepositoryMismatch',
      configuredImageRepository: parsed.configuredBuild.imageRepository,
      embeddedImageRepository: verified.imageRepository,
    })
  }
  if (parsed.configuredBuild.strategyBehaviorHash !== verified.strategyBehaviorHash) {
    return fail({
      _tag: 'StrategyBehaviorHashMismatch',
      configuredStrategyBehaviorHash: parsed.configuredBuild.strategyBehaviorHash,
      embeddedStrategyBehaviorHash: verified.strategyBehaviorHash,
    })
  }
  if (parsed.configuredBuild.strategyParameterHash !== verified.strategyParameterHash) {
    return fail({
      _tag: 'StrategyParameterHashMismatch',
      configuredStrategyParameterHash: parsed.configuredBuild.strategyParameterHash,
      embeddedStrategyParameterHash: verified.strategyParameterHash,
    })
  }
  return Result.succeed({
    ...verified,
    imageDigest: parsed.configuredBuild.imageDigest,
    verification: 'embedded',
  })
}

const baseConfig = (
  parsed: ParsedRuntimeConfig,
  execution: ExecutionPolicy,
  build: RuntimeBuildMetadata,
  alpaca: AlpacaRuntimeConfig | undefined,
) => ({
  host: parsed.host,
  port: parsed.port,
  qualificationRunId: parsed.qualificationRunId,
  paperActivationRequestJson: parsed.paperActivationRequestJson,
  execution,
  build,
  healthIntervalMs: parsed.healthIntervalMs,
  operationTimeoutMs: parsed.operationTimeoutMs,
  lifecycleOwner: parsed.lifecycleOwner,
  lifecycleCommandPort: parsed.lifecycleCommandPort,
  lifecycleControllerKey: parsed.lifecycleControllerKey,
  lifecyclePreviousSourceRevision: parsed.lifecyclePreviousSourceRevision,
  cycleStallThresholdMs: parsed.cycleStallThresholdMs,
  reconciliationStaleThresholdMs: parsed.reconciliationStaleThresholdMs,
  unknownMutationThresholdMs: parsed.unknownMutationThresholdMs,
  cyclePollIntervalMs: parsed.cyclePollIntervalMs,
  alpaca,
  clickhouse: parsed.clickhouse,
  postgres: parsed.postgres,
  tigerBeetle: parsed.tigerBeetle,
})

const loadedConfig = (
  parsed: ParsedRuntimeConfig,
  execution: ExecutionPolicy,
  build: RuntimeBuildMetadata,
  alpaca: AlpacaRuntimeConfig | undefined,
): Result.Result<LoadedRuntimeConfig, RuntimeConfigResolutionFailure> => {
  const common = baseConfig(parsed, execution, build, alpaca)
  if (parsed.configuredOperation === 'ExecutionCandidateDiscovery') {
    const qualificationRunId = parsed.qualificationRunId
    if (qualificationRunId === undefined) {
      return fail({ _tag: 'ExecutionCandidateDiscoveryRequiresQualificationRun' })
    }
    if (alpaca === undefined) {
      return fail({ _tag: 'ExecutionCandidateDiscoveryRequiresAlpacaBinding' })
    }
    return Result.succeed({
      ...common,
      runtimeMode: 'ExecutionCandidateDiscovery',
      qualificationRunId,
      execution: execution as Extract<
        LoadedRuntimeConfig,
        { readonly runtimeMode: 'ExecutionCandidateDiscovery' }
      >['execution'],
      alpaca,
    })
  }
  if (parsed.configuredOperation === 'ExecutionPrepare') {
    const qualificationRunId = parsed.qualificationRunId
    if (qualificationRunId === undefined) {
      return fail({ _tag: 'ExecutionCandidateDiscoveryRequiresQualificationRun' })
    }
    if (alpaca === undefined) {
      return fail({ _tag: 'ExecutionCandidateDiscoveryRequiresAlpacaBinding' })
    }
    const executionPrepareRequest = parsed.executionPrepareRequest
    if (executionPrepareRequest === undefined) {
      return fail({ _tag: 'ExecutionPrepareRequiresRequest' })
    }
    if (alpaca.environment !== BrokerEnvironment.Sandbox) {
      return fail({
        _tag: 'ExecutionPrepareRequiresSandboxBroker',
        brokerEnvironment: alpaca.environment,
      })
    }
    return Result.succeed({
      ...common,
      runtimeMode: 'ExecutionPrepare',
      qualificationRunId,
      executionPrepareRequest,
      execution: execution as Extract<LoadedRuntimeConfig, { readonly runtimeMode: 'ExecutionPrepare' }>['execution'],
      alpaca,
    })
  }
  if (alpaca === undefined) {
    return Result.succeed({
      ...common,
      runtimeMode: 'BrokerlessService',
      execution: execution as Extract<LoadedRuntimeConfig, { readonly runtimeMode: 'BrokerlessService' }>['execution'],
      alpaca: undefined,
    })
  }
  return Result.succeed({
    ...common,
    runtimeMode: 'AutonomousService',
    execution: execution as Extract<LoadedRuntimeConfig, { readonly runtimeMode: 'AutonomousService' }>['execution'],
    alpaca,
  })
}

export const resolveRuntimeConfig = (
  input: RuntimeConfigResolutionInput,
): Result.Result<LoadedRuntimeConfig, RuntimeConfigResolutionFailure> => {
  const bounds = decodeBounds(input.parsed)
  if (Result.isFailure(bounds)) return Result.fail(bounds.failure)
  const parsed = bounds.success
  const timing = validateCycleTiming(parsed)
  if (Result.isFailure(timing)) return Result.fail(timing.failure)
  const lifecyclePorts = validateLifecyclePorts(parsed)
  if (Result.isFailure(lifecyclePorts)) return Result.fail(lifecyclePorts.failure)
  const alpaca = decodeAlpaca(parsed)
  if (Result.isFailure(alpaca)) return Result.fail(alpaca.failure)
  const lifecycleMode = validateLifecycleMode(parsed, alpaca.success)
  if (Result.isFailure(lifecycleMode)) return Result.fail(lifecycleMode.failure)
  const execution = resolvePolicy(parsed, alpaca.success)
  if (Result.isFailure(execution)) return Result.fail(execution.failure)
  const reconciliationTiming = validatePaperReconciliationTiming(parsed, execution.success, alpaca.success)
  if (Result.isFailure(reconciliationTiming)) return Result.fail(reconciliationTiming.failure)
  const legacy = validateLegacyAuthority(parsed, execution.success)
  if (Result.isFailure(legacy)) return Result.fail(legacy.failure)
  const operation = validateOperation(parsed, execution.success, alpaca.success)
  if (Result.isFailure(operation)) return Result.fail(operation.failure)
  const provenance = validateProvenanceMode(parsed, input.embeddedBuildMetadata)
  if (Result.isFailure(provenance)) return Result.fail(provenance.failure)
  const postgresTls = validatePostgresTls(parsed)
  if (Result.isFailure(postgresTls)) return Result.fail(postgresTls.failure)
  const build = runtimeBuildMetadata(parsed, input.embeddedBuildMetadata)
  if (Result.isFailure(build)) return Result.fail(build.failure)
  return loadedConfig(parsed, execution.success, build.success, alpaca.success)
}

export const redactedConfigSummary = (config: LoadedRuntimeConfig) => ({
  ...config,
  clickhouse: { ...config.clickhouse, password: Redacted.make('[REDACTED]') },
  postgres: { ...config.postgres, url: Redacted.make('[REDACTED]') },
  alpaca:
    config.alpaca === undefined
      ? undefined
      : { ...config.alpaca, key: Redacted.make('[REDACTED]'), secret: Redacted.make('[REDACTED]') },
})

export type { BrokerConnection }
