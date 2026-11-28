import { Schema } from 'effect'

import { GitSourceRevisionSchema, ImageDigestSchema, ImageRepositorySchema, Sha256Schema } from '../schemas'
import { JevInstructionsSchema } from './instructions-contract'
import { NativeReplayIdentitySchema } from '../intraday-replay/native-policy'
import { ResearchStrategyBindingSchema } from '../system-assessment/strategy-binding'

export const JevInstructionVariantSpecSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-instruction-variant.v1'),
  evaluation: Schema.Literals(['portfolio', 'entry-controls']),
  sourceRevision: GitSourceRevisionSchema,
  imageRepository: ImageRepositorySchema,
  baseImageDigest: ImageDigestSchema,
  instructions: JevInstructionsSchema,
  dependencyReceiptSha256: Sha256Schema,
})

export const JevInstructionVariantBuildSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-instruction-variant-build.v1'),
  spec: JevInstructionVariantSpecSchema,
  baselineInstructionsHash: Sha256Schema,
  instructionsHash: Sha256Schema,
  strategyBehaviorHash: Sha256Schema,
  strategyParameterHash: Sha256Schema,
  executableSha256: Sha256Schema,
  bunVersion: Schema.Literal('1.4.2'),
  replacedSourceModule: Schema.Literal('services/bayn/src/jev/instructions.ts'),
  sourceVerification: Schema.Literal('CLEAN_COMMITTED_BUILD_INPUTS'),
  dependencyVerification: Schema.Literal('PINNED_IMAGE_INPUT_BYTES'),
  baseImageVerification: Schema.Literal('REQUIRES_RUNTIME_READBACK'),
  qualification: Schema.Literal('UNQUALIFIED'),
  receiptHash: Sha256Schema,
})

const compilerDependencyFields = {
  sourceRevision: GitSourceRevisionSchema,
  bunVersion: Schema.Literal('1.4.2'),
  files: Schema.Record(Schema.String, Sha256Schema),
  controlFiles: Schema.Record(Schema.String, Sha256Schema),
  compilerFiles: Schema.Record(Schema.String, Sha256Schema),
}
export const JevCompilerDependencyReceiptV4Schema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-compiler-dependencies.v4'),
  ...compilerDependencyFields,
  nativeReplayPolicies: Schema.Array(NativeReplayIdentitySchema).check(Schema.isMinLength(3), Schema.isMaxLength(3)),
})
export const JevCompilerDependencyReceiptV5Schema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-compiler-dependencies.v5'),
  ...compilerDependencyFields,
  applicationStrategyBinding: ResearchStrategyBindingSchema,
  compiledReplayStrategies: Schema.Array(ResearchStrategyBindingSchema).check(
    Schema.isMinLength(4),
    Schema.isMaxLength(5),
  ),
})
export const JevCompilerDependencyReceiptSchema = Schema.Union([
  JevCompilerDependencyReceiptV4Schema,
  JevCompilerDependencyReceiptV5Schema,
])
