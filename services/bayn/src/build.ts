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

export const EmbeddedBuildMetadataSchema = Schema.Struct({
  sourceRevision: SourceRevision,
  imageRepository: ImageRepository,
  strategyBehaviorHash: Sha256,
  strategyParameterHash: Sha256,
})
export type EmbeddedBuildMetadata = typeof EmbeddedBuildMetadataSchema.Type

export const EmbeddedStrategyIdentitySchema = Schema.Struct({
  name: StrictNonEmptyString,
  protocolHash: Sha256,
})
export type EmbeddedStrategyIdentity = typeof EmbeddedStrategyIdentitySchema.Type

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

const hasNoEmbeddedStrategyIdentity = strategyName === undefined && strategyProtocolHash === undefined

export const embeddedStrategyIdentity: EmbeddedStrategyIdentity | undefined = hasNoEmbeddedStrategyIdentity
  ? undefined
  : {
      name: strategyName ?? 'incomplete',
      protocolHash: strategyProtocolHash ?? 'incomplete',
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
  identity: EmbeddedStrategyIdentity,
  actualStrategyName: string,
): Effect.Effect<void, OperationalError> =>
  identity.name === actualStrategyName
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
  identity: EmbeddedStrategyIdentity,
  actualProtocolHash: string,
): Effect.Effect<void, OperationalError> =>
  identity.protocolHash === actualProtocolHash
    ? Effect.void
    : Effect.fail(
        operationalError({
          component: 'config',
          operation: 'provenance',
          message: 'compiled strategy protocol does not match build metadata',
        }),
      )

export const verifyStrategyProtocolHash = Pipeable.dual(2, verifyStrategyProtocolHashDataFirst)
