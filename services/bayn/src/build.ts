import { Schema } from 'effect'

declare const __BAYN_BUILD_SOURCE_REVISION__: string
declare const __BAYN_BUILD_IMAGE_REPOSITORY__: string
declare const __BAYN_BUILD_STRATEGY_BEHAVIOR_HASH__: string

const SourceRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
const ImageRepository = Schema.String.check(Schema.isPattern(/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/))
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

export const EmbeddedBuildMetadataSchema = Schema.Struct({
  sourceRevision: SourceRevision,
  imageRepository: ImageRepository,
  strategyBehaviorHash: Sha256,
})
export type EmbeddedBuildMetadata = typeof EmbeddedBuildMetadataSchema.Type

export const embeddedBuildMetadata = {
  sourceRevision: typeof __BAYN_BUILD_SOURCE_REVISION__ === 'undefined' ? 'unbuilt' : __BAYN_BUILD_SOURCE_REVISION__,
  imageRepository: typeof __BAYN_BUILD_IMAGE_REPOSITORY__ === 'undefined' ? 'unbuilt' : __BAYN_BUILD_IMAGE_REPOSITORY__,
  strategyBehaviorHash:
    typeof __BAYN_BUILD_STRATEGY_BEHAVIOR_HASH__ === 'undefined' ? 'unbuilt' : __BAYN_BUILD_STRATEGY_BEHAVIOR_HASH__,
} as const
