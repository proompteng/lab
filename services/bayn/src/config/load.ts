import { Effect } from 'effect'

import { embeddedBuildMetadata, type EmbeddedBuildMetadata } from '../build'
import { renderBrokerConnectionDecodeFailure } from '../broker/connection'
import { OperationalError, operationalError } from '../errors'
import { renderExecutionPolicyFailure } from '../execution/configuration'
import type { LoadedRuntimeConfig, RuntimeConfigResolutionFailure } from './model'
import { resolveRuntimeConfig } from './resolution'
import { runtimeConfigSource } from './source'

interface RuntimeConfigFailurePresentation {
  readonly operation: string
  readonly message: string
}

const presentRuntimeConfigFailure = (failure: RuntimeConfigResolutionFailure): RuntimeConfigFailurePresentation => {
  switch (failure._tag) {
    case 'InvalidEvaluationBounds':
      return { operation: 'load', message: `invalid Signal evaluation bounds: ${failure.cause.message}` }
    case 'CyclePollIntervalNotShorterThanStallThreshold':
      return {
        operation: 'cycle-loop',
        message: 'cycle poll interval must be shorter than the cycle stall threshold',
      }
    case 'ExecutionReconciliationCadenceNotWithinStaleThreshold':
      return {
        operation: 'cycle-loop',
        message: `execution reconciliation interval ${failure.reconciliationIntervalMs.toString()}ms plus prior post-timestamp tail bound ${failure.priorReconciliationTailTimeoutMs.toString()}ms plus next full-pass timeout ${failure.reconciliationPassTimeoutMs.toString()}ms must be shorter than the reconciliation stale threshold ${failure.reconciliationStaleThresholdMs.toString()}ms`,
      }
    case 'IncompleteAlpacaCredentials':
      return {
        operation: 'broker-connection',
        message: 'Alpaca account ID, key ID, and secret key must be configured together',
      }
    case 'MissingAlpacaCredentials':
      return {
        operation: 'broker-connection',
        message: 'the autonomous service requires an Alpaca account ID, key ID, and secret key',
      }
    case 'MissingAlpacaAuthorityGeneration':
      return {
        operation: 'authority-generation',
        message: 'Alpaca account binding requires an authority generation hash',
      }
    case 'InvalidBrokerConnection':
      return { operation: 'broker-connection', message: renderBrokerConnectionDecodeFailure(failure.cause) }
    case 'InvalidExecutionPolicy':
      return { operation: 'execution-authority', message: renderExecutionPolicyFailure(failure.cause) }
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
      return { operation: 'provenance', message: `invalid build provenance: ${failure.cause.message}` }
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
  runtimeConfigSource.pipe(
    Effect.mapError((cause) =>
      operationalError({
        component: 'config',
        operation: 'load',
        message: 'invalid runtime configuration',
        cause,
      }),
    ),
    Effect.flatMap((parsed) =>
      Effect.fromResult(resolveRuntimeConfig({ parsed, embeddedBuildMetadata: embedded })).pipe(
        Effect.mapError(resolutionFailureToOperationalError),
      ),
    ),
  )
