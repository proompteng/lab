import { Effect, Schema } from 'effect'

import { operationalError, type OperationalError } from './errors'
import {
  GitSourceRevisionSchema as SourceRevision,
  ImageRepositorySchema as ImageRepository,
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as StrictNonEmptyString,
} from './schemas'
import { Pipeable } from './pipeable'

declare const __BAYN_BUILD_SOURCE_REVISION__: string
declare const __BAYN_BUILD_IMAGE_REPOSITORY__: string
declare const __BAYN_BUILD_STRATEGY_BEHAVIOR_HASH__: string
declare const __BAYN_BUILD_STRATEGY_PARAMETER_HASH__: string
declare const __BAYN_BUILD_STRATEGY_NAME__: string
declare const __BAYN_BUILD_STRATEGY_PROTOCOL_HASH__: string
declare const __BAYN_BUILD_EXECUTION_RISK_POLICY_HASH__: string

export const EmbeddedBuildMetadataSchema = Schema.Struct({
  sourceRevision: SourceRevision,
  imageRepository: ImageRepository,
  strategyBehaviorHash: Sha256,
  strategyParameterHash: Sha256,
})
export type EmbeddedBuildMetadata = typeof EmbeddedBuildMetadataSchema.Type

export const EmbeddedRuntimeIdentitySchema = Schema.Struct({
  strategyName: StrictNonEmptyString,
  strategyProtocolHash: Sha256,
  executionRiskPolicyHash: Sha256,
})
export type EmbeddedRuntimeIdentity = typeof EmbeddedRuntimeIdentitySchema.Type

const sourceRevision =
  typeof __BAYN_BUILD_SOURCE_REVISION__ === 'undefined' ? undefined : __BAYN_BUILD_SOURCE_REVISION__
const imageRepository =
  typeof __BAYN_BUILD_IMAGE_REPOSITORY__ === 'undefined' ? undefined : __BAYN_BUILD_IMAGE_REPOSITORY__
const strategyBehaviorHash =
  typeof __BAYN_BUILD_STRATEGY_BEHAVIOR_HASH__ === 'undefined' ? undefined : __BAYN_BUILD_STRATEGY_BEHAVIOR_HASH__
const strategyParameterHash =
  typeof __BAYN_BUILD_STRATEGY_PARAMETER_HASH__ === 'undefined' ? undefined : __BAYN_BUILD_STRATEGY_PARAMETER_HASH__
const strategyName = typeof __BAYN_BUILD_STRATEGY_NAME__ === 'undefined' ? undefined : __BAYN_BUILD_STRATEGY_NAME__
const strategyProtocolHash =
  typeof __BAYN_BUILD_STRATEGY_PROTOCOL_HASH__ === 'undefined' ? undefined : __BAYN_BUILD_STRATEGY_PROTOCOL_HASH__
const executionRiskPolicyHash =
  typeof __BAYN_BUILD_EXECUTION_RISK_POLICY_HASH__ === 'undefined'
    ? undefined
    : __BAYN_BUILD_EXECUTION_RISK_POLICY_HASH__

const hasNoEmbeddedMetadata =
  sourceRevision === undefined &&
  imageRepository === undefined &&
  strategyBehaviorHash === undefined &&
  strategyParameterHash === undefined

export const embeddedBuildMetadata: EmbeddedBuildMetadata | undefined = hasNoEmbeddedMetadata
  ? undefined
  : {
      sourceRevision: sourceRevision ?? 'incomplete',
      imageRepository: imageRepository ?? 'incomplete',
      strategyBehaviorHash: strategyBehaviorHash ?? 'incomplete',
      strategyParameterHash: strategyParameterHash ?? 'incomplete',
    }

const hasNoEmbeddedRuntimeIdentity =
  strategyName === undefined && strategyProtocolHash === undefined && executionRiskPolicyHash === undefined

export const embeddedRuntimeIdentity: EmbeddedRuntimeIdentity | undefined = hasNoEmbeddedRuntimeIdentity
  ? undefined
  : {
      strategyName: strategyName ?? 'incomplete',
      strategyProtocolHash: strategyProtocolHash ?? 'incomplete',
      executionRiskPolicyHash: executionRiskPolicyHash ?? 'incomplete',
    }

const verifyParameterHashDataFirst = (
  metadata: EmbeddedBuildMetadata,
  actualParameterHash: string,
): Effect.Effect<void, OperationalError> =>
  metadata.strategyParameterHash === actualParameterHash
    ? Effect.void
    : Effect.fail(
        operationalError({
          component: 'config',
          operation: 'provenance',
          message: 'compiled strategy parameters do not match build metadata',
        }),
      )

export const verifyParameterHash = Pipeable.dual(2, verifyParameterHashDataFirst)

const verifyBehaviorHashDataFirst = (
  metadata: EmbeddedBuildMetadata,
  actualBehaviorHash: string,
): Effect.Effect<void, OperationalError> =>
  metadata.strategyBehaviorHash === actualBehaviorHash
    ? Effect.void
    : Effect.fail(
        operationalError({
          component: 'config',
          operation: 'provenance',
          message: 'compiled strategy behavior does not match build metadata',
        }),
      )

export const verifyBehaviorHash = Pipeable.dual(2, verifyBehaviorHashDataFirst)

const verifyStrategyNameDataFirst = (
  identity: EmbeddedRuntimeIdentity,
  actualStrategyName: string,
): Effect.Effect<void, OperationalError> =>
  identity.strategyName === actualStrategyName
    ? Effect.void
    : Effect.fail(
        operationalError({
          component: 'config',
          operation: 'provenance',
          message: 'compiled strategy name does not match build metadata',
        }),
      )

export const verifyStrategyName = Pipeable.dual(2, verifyStrategyNameDataFirst)

const verifyStrategyProtocolHashDataFirst = (
  identity: EmbeddedRuntimeIdentity,
  actualProtocolHash: string,
): Effect.Effect<void, OperationalError> =>
  identity.strategyProtocolHash === actualProtocolHash
    ? Effect.void
    : Effect.fail(
        operationalError({
          component: 'config',
          operation: 'provenance',
          message: 'compiled strategy protocol does not match build metadata',
        }),
      )

export const verifyStrategyProtocolHash = Pipeable.dual(2, verifyStrategyProtocolHashDataFirst)

const verifyExecutionRiskPolicyHashDataFirst = (
  identity: EmbeddedRuntimeIdentity,
  actualPolicyHash: string,
): Effect.Effect<void, OperationalError> =>
  identity.executionRiskPolicyHash === actualPolicyHash
    ? Effect.void
    : Effect.fail(
        operationalError({
          component: 'config',
          operation: 'provenance',
          message: 'compiled execution risk policy does not match build metadata',
        }),
      )

export const verifyExecutionRiskPolicyHash = Pipeable.dual(2, verifyExecutionRiskPolicyHashDataFirst)
