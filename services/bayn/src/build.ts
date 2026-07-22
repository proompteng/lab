import { Effect, Schema } from 'effect'

import { operationalError, type OperationalError } from './errors'

declare const __BAYN_BUILD_SOURCE_REVISION__: string
declare const __BAYN_BUILD_IMAGE_REPOSITORY__: string
declare const __BAYN_BUILD_STRATEGY_BEHAVIOR_HASH__: string
declare const __BAYN_BUILD_STRATEGY_PARAMETER_HASH__: string

const SourceRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
const ImageRepository = Schema.String.check(Schema.isPattern(/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/))
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

export const EmbeddedBuildMetadataSchema = Schema.Struct({
  sourceRevision: SourceRevision,
  imageRepository: ImageRepository,
  strategyBehaviorHash: Sha256,
  strategyParameterHash: Sha256,
})
export type EmbeddedBuildMetadata = typeof EmbeddedBuildMetadataSchema.Type

const sourceRevision =
  typeof __BAYN_BUILD_SOURCE_REVISION__ === 'undefined' ? undefined : __BAYN_BUILD_SOURCE_REVISION__
const imageRepository =
  typeof __BAYN_BUILD_IMAGE_REPOSITORY__ === 'undefined' ? undefined : __BAYN_BUILD_IMAGE_REPOSITORY__
const strategyBehaviorHash =
  typeof __BAYN_BUILD_STRATEGY_BEHAVIOR_HASH__ === 'undefined' ? undefined : __BAYN_BUILD_STRATEGY_BEHAVIOR_HASH__
const strategyParameterHash =
  typeof __BAYN_BUILD_STRATEGY_PARAMETER_HASH__ === 'undefined' ? undefined : __BAYN_BUILD_STRATEGY_PARAMETER_HASH__

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

export const verifyParameterHash = (
  metadata: EmbeddedBuildMetadata,
  actualParameterHash: string,
): Effect.Effect<void, OperationalError> =>
  metadata.strategyParameterHash === actualParameterHash
    ? Effect.void
    : Effect.fail(operationalError('config', 'provenance', 'compiled strategy parameters do not match build metadata'))
