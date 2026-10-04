import { Data, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import {
  GitSourceRevisionSchema,
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  SymbolSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import { sixBarResearchDefinition } from './six-bar-features'

export const sixBarRidgeRecipe = {
  schemaVersion: 'bayn.six-bar-ridge-recipe.v1',
  features: sixBarResearchDefinition.features,
  target: '10000 * net-execution-pnl / fixed-allocation-budget',
  weighting: 'equal-nonempty-training-days',
  normalization: 'training-weighted-population-standard-deviation',
  constantFeatures: 'exact-constant-to-zero',
  intercept: 'unpenalized',
  lambda: 1,
  solver: 'ml-matrix@6.15.0/CholeskyDecomposition',
  arithmetic: 'deterministic-cpu-float64',
} as const

export const SixBarRidgeValuesSchema = Schema.Tuple([
  Schema.Finite,
  Schema.Finite,
  Schema.Finite,
  Schema.Finite,
  Schema.Finite,
  Schema.Finite,
  Schema.Finite,
])
export const SixBarRidgeFeatureSchema = Schema.Struct({
  sessionDate: IsoDateSchema,
  symbol: SymbolSchema,
  featureDefinitionHash: Sha256Schema,
  featureEvidenceHash: Sha256Schema,
  availableAt: UtcInstantSchema,
  decisionAt: UtcInstantSchema,
  values: SixBarRidgeValuesSchema,
})
export const SixBarRidgeProvenanceSchema = Schema.Struct({
  sourceRevision: GitSourceRevisionSchema,
  sourceManifestHash: Sha256Schema,
  labelDefinitionHash: Sha256Schema,
  calendarHash: Sha256Schema,
})
export const SixBarRidgeArtifactSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.six-bar-ridge-artifact.v1'),
  qualification: Schema.Literal('UNQUALIFIED'),
  controllerCoverage: Schema.Literal('UNKNOWN'),
  recipeHash: Sha256Schema,
  featureDefinitionHash: Sha256Schema,
  featureOrder: Schema.Array(Schema.String),
  solver: Schema.Literal(sixBarRidgeRecipe.solver),
  provenance: SixBarRidgeProvenanceSchema,
  allocationBudgetMicros: PositiveMicrosSchema,
  manifestHash: Sha256Schema,
  trainingDataHash: Sha256Schema,
  fitCutoffAt: UtcInstantSchema,
  firstEvaluationDecisionAt: UtcInstantSchema,
  trainingSessions: Schema.Array(Schema.Struct({ date: IsoDateSchema, rowCount: NonNegativeIntegerSchema })),
  nonemptyTrainingDays: PositiveIntegerSchema,
  trainingRows: PositiveIntegerSchema,
  means: SixBarRidgeValuesSchema,
  scales: SixBarRidgeValuesSchema,
  coefficients: SixBarRidgeValuesSchema,
  intercept: Schema.Finite,
  artifactHash: Sha256Schema,
})
const ExpectedBindingSchema = Schema.Struct({
  artifactHash: Sha256Schema,
  manifestHash: Sha256Schema,
  sourceRevision: GitSourceRevisionSchema,
})
export type SixBarRidgeArtifact = typeof SixBarRidgeArtifactSchema.Type
export class SixBarRidgeFailure extends Data.TaggedError('SixBarRidgeFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}
const fail = (message: string, cause?: unknown) => new SixBarRidgeFailure({ message, cause })

export const decodeSixBarRidgeArtifact = (input: unknown, expectedBinding: unknown) =>
  Result.gen(function* () {
    const artifact = yield* Schema.decodeUnknownResult(SixBarRidgeArtifactSchema, strictParseOptions)(input)
    const expected = yield* Schema.decodeUnknownResult(ExpectedBindingSchema, strictParseOptions)(expectedBinding)
    const { artifactHash, ...payload } = artifact
    if (
      artifactHash !== expected.artifactHash ||
      artifactHash !== (yield* canonicalHashV1Result(payload)) ||
      artifact.manifestHash !== expected.manifestHash ||
      artifact.provenance.sourceRevision !== expected.sourceRevision ||
      artifact.recipeHash !== (yield* canonicalHashV1Result(sixBarRidgeRecipe)) ||
      artifact.featureDefinitionHash !== (yield* canonicalHashV1Result(sixBarResearchDefinition)) ||
      artifact.featureOrder.length !== 7 ||
      artifact.featureOrder.some((name, index) => name !== sixBarResearchDefinition.features[index])
    )
      return yield* Result.fail(fail('Ridge artifact differs from its expected content, recipe, or provenance'))
    if (
      !Number.isSafeInteger(Number(artifact.allocationBudgetMicros)) ||
      artifact.fitCutoffAt > artifact.firstEvaluationDecisionAt ||
      artifact.trainingSessions.length === 0 ||
      artifact.trainingSessions.some((session, index) => {
        const previous = artifact.trainingSessions[index - 1]
        return (
          (previous !== undefined && previous.date >= session.date) || session.date > artifact.fitCutoffAt.slice(0, 10)
        )
      }) ||
      artifact.trainingSessions.filter((session) => session.rowCount > 0).length !== artifact.nonemptyTrainingDays ||
      artifact.trainingSessions.reduce((total, session) => total + session.rowCount, 0) !== artifact.trainingRows ||
      artifact.scales.some((scale, index) => scale < 0 || (scale === 0 && artifact.coefficients[index] !== 0))
    )
      return yield* Result.fail(fail('Ridge artifact has invalid scales, training counts, or chronological boundaries'))
    return artifact
  }).pipe(Result.mapError((cause) => fail('Invalid offline ridge artifact', cause)))

export const scoreSixBarRidge = (input: unknown, candidatesInput: unknown, expectedBinding: unknown) =>
  Result.gen(function* () {
    const artifact = yield* decodeSixBarRidgeArtifact(input, expectedBinding)
    const candidates = yield* Schema.decodeUnknownResult(
      Schema.Array(SixBarRidgeFeatureSchema),
      strictParseOptions,
    )(candidatesInput)
    const first = candidates[0]
    const symbols = new Set<string>()
    const scores: { symbol: string; scoreBps: number }[] = []
    for (const candidate of candidates) {
      if (
        symbols.has(candidate.symbol) ||
        candidate.symbol === sixBarResearchDefinition.benchmarkSymbol ||
        candidate.featureDefinitionHash !== artifact.featureDefinitionHash ||
        candidate.availableAt > candidate.decisionAt ||
        candidate.decisionAt < artifact.fitCutoffAt ||
        candidate.decisionAt !== first?.decisionAt ||
        candidate.sessionDate !== first.sessionDate
      )
        return yield* Result.fail(
          fail('Ridge candidates must share one causal decision and have unique candidate symbols'),
        )
      symbols.add(candidate.symbol)
      let scoreBps = artifact.intercept
      for (const [index, value] of candidate.values.entries()) {
        const mean = artifact.means[index],
          scale = artifact.scales[index],
          coefficient = artifact.coefficients[index]
        if (mean === undefined || scale === undefined || coefficient === undefined)
          return yield* Result.fail(fail('Ridge artifact dimensions are incomplete'))
        if (scale === 0) continue
        const difference = value - mean
        const standardized = difference / scale
        const contribution = standardized * coefficient
        if (
          !Number.isFinite(difference) ||
          !Number.isFinite(standardized) ||
          !Number.isFinite(contribution) ||
          (difference !== 0 && standardized === 0) ||
          (standardized !== 0 && coefficient !== 0 && contribution === 0)
        )
          return yield* Result.fail(fail('Ridge scoring arithmetic overflowed or underflowed'))
        scoreBps += contribution
        if (!Number.isFinite(scoreBps)) return yield* Result.fail(fail('Ridge score overflowed'))
      }
      scores.push({ symbol: candidate.symbol, scoreBps })
    }
    scores.sort(
      (left, right) =>
        right.scoreBps - left.scoreBps || (left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0),
    )
    const best = scores[0]
    return {
      qualification: 'UNQUALIFIED' as const,
      controllerCoverage: 'UNKNOWN' as const,
      artifactHash: artifact.artifactHash,
      scores,
      selectedSymbol: best !== undefined && best.scoreBps > 0 ? best.symbol : null,
    }
  }).pipe(Result.mapError((cause) => fail('Invalid offline ridge scoring request', cause)))
