import { Result, Schema } from 'effect'
import { CholeskyDecomposition, Matrix } from 'ml-matrix'

import { canonicalHashV1Result } from '../hash'
import {
  IsoDateSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  SignedMicrosSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import { sixBarResearchDefinition } from './six-bar-features'
import {
  decodeSixBarRidgeArtifact,
  SixBarRidgeFailure,
  SixBarRidgeFeatureSchema,
  SixBarRidgeProvenanceSchema,
  sixBarRidgeRecipe,
} from './six-bar-ridge'

export enum SixBarRidgePartition {
  Training = 'TRAINING',
  Validation = 'VALIDATION',
  Holdout = 'HOLDOUT',
}
export enum SixBarRidgeLabelStatus {
  Resolved = 'RESOLVED',
  NoEntryFill = 'NO_ENTRY_FILL',
}
export const SixBarRidgeManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.six-bar-ridge-training-manifest.v1'),
  featureDefinitionHash: Sha256Schema,
  recipeHash: Sha256Schema,
  provenance: SixBarRidgeProvenanceSchema,
  allocationBudgetMicros: PositiveMicrosSchema,
  fitCutoffAt: UtcInstantSchema,
  sessions: Schema.Array(
    Schema.Struct({
      date: IsoDateSchema,
      openAt: UtcInstantSchema,
      closeAt: UtcInstantSchema,
      firstDecisionAt: UtcInstantSchema,
      partition: Schema.Enum(SixBarRidgePartition),
      requiredFeatureRowHashes: Schema.Array(Sha256Schema).check(Schema.isUnique()),
    }),
  ).check(Schema.isMinLength(1)),
})
export const SixBarRidgeTrainingRowSchema = Schema.Struct({
  features: SixBarRidgeFeatureSchema,
  label: Schema.Struct({
    status: Schema.Enum(SixBarRidgeLabelStatus),
    netExecutionPnlMicros: SignedMicrosSchema,
    completeAt: UtcInstantSchema,
    evidenceHash: Sha256Schema,
  }),
})
const fail = (message: string, cause?: unknown) => new SixBarRidgeFailure({ message, cause })
const finite = (value: number) =>
  Number.isFinite(value) ? Result.succeed(value) : Result.fail(fail('Ridge arithmetic overflowed'))
const product = (left: number, right: number) => {
  const value = left * right
  return left !== 0 && right !== 0 && value === 0 ? Result.fail(fail('Ridge arithmetic underflowed')) : finite(value)
}
const sum = (values: readonly number[]) =>
  Result.gen(function* () {
    let total = 0,
      correction = 0
    for (const value of values) {
      const adjusted = yield* finite(value - correction)
      const next = yield* finite(total + adjusted)
      correction = yield* finite(next - total - adjusted)
      total = next
    }
    return total
  })
const weighted = (values: readonly number[], weights: readonly number[]) =>
  Result.gen(function* () {
    const terms = []
    for (const [index, value] of values.entries()) {
      const weight = weights[index]
      if (weight === undefined) return yield* Result.fail(fail('Ridge weight dimensions are incomplete'))
      terms.push(yield* product(value, weight))
    }
    return yield* sum(terms)
  })
const lexical = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

export const fitSixBarRidge = (manifestInput: unknown, rowsInput: unknown, expectedManifestHash: string) =>
  Result.gen(function* () {
    const manifest = yield* Schema.decodeUnknownResult(SixBarRidgeManifestSchema, strictParseOptions)(manifestInput)
    const rows = yield* Schema.decodeUnknownResult(
      Schema.Array(SixBarRidgeTrainingRowSchema),
      strictParseOptions,
    )(rowsInput)
    yield* Schema.decodeUnknownResult(Sha256Schema)(expectedManifestHash)
    const manifestHash = yield* canonicalHashV1Result(manifest)
    if (
      manifestHash !== expectedManifestHash ||
      manifest.recipeHash !== (yield* canonicalHashV1Result(sixBarRidgeRecipe)) ||
      manifest.featureDefinitionHash !== (yield* canonicalHashV1Result(sixBarResearchDefinition))
    )
      return yield* Result.fail(fail('Ridge training manifest differs from its independently pinned binding'))
    const budget = Number(manifest.allocationBudgetMicros)
    if (!Number.isSafeInteger(budget))
      return yield* Result.fail(fail('Ridge allocation budget must be exact float64 micro-units'))
    const ranks = { TRAINING: 0, VALIDATION: 1, HOLDOUT: 2 } as const
    const sessions = manifest.sessions
    for (const [index, session] of sessions.entries()) {
      const previous = sessions[index - 1]
      if (
        session.openAt >= session.closeAt ||
        session.firstDecisionAt < session.openAt ||
        session.firstDecisionAt >= session.closeAt ||
        session.date !== session.openAt.slice(0, 10) ||
        session.date !== session.closeAt.slice(0, 10) ||
        (previous !== undefined &&
          (previous.date >= session.date ||
            previous.closeAt >= session.openAt ||
            ranks[previous.partition] > ranks[session.partition])) ||
        (session.partition !== SixBarRidgePartition.Training && session.requiredFeatureRowHashes.length > 0) ||
        (session.partition === SixBarRidgePartition.Training && session.closeAt >= manifest.fitCutoffAt)
      )
        return yield* Result.fail(fail('Ridge sessions must be complete, chronological, disjoint whole-day partitions'))
    }
    const evaluation = sessions.find((session) => session.partition !== SixBarRidgePartition.Training)
    if (evaluation === undefined || manifest.fitCutoffAt > evaluation.firstDecisionAt)
      return yield* Result.fail(fail('Ridge fitting cutoff must precede a declared evaluation decision'))
    const trainingSessions = sessions.filter((session) => session.partition === SixBarRidgePartition.Training)
    const nonemptyTrainingDays = trainingSessions.filter(
      (session) => session.requiredFeatureRowHashes.length > 0,
    ).length
    const requiredRows = trainingSessions.reduce((total, session) => total + session.requiredFeatureRowHashes.length, 0)
    if (nonemptyTrainingDays === 0 || rows.length !== requiredRows)
      return yield* Result.fail(fail('Ridge fit requires every declared training row and at least one nonempty day'))
    const orderedRows = [...rows].sort(
      (left, right) =>
        lexical(left.features.sessionDate, right.features.sessionDate) ||
        lexical(left.features.decisionAt, right.features.decisionAt) ||
        lexical(left.features.symbol, right.features.symbol) ||
        lexical(left.features.featureEvidenceHash, right.features.featureEvidenceHash),
    )
    const seen = new Set<string>()
    const identities = new Set<string>()
    const weights = [],
      targets = []
    for (const row of orderedRows) {
      const features = row.features,
        label = row.label
      const session = trainingSessions.find((entry) => entry.date === features.sessionDate)
      const hash = yield* canonicalHashV1Result(features)
      const identity = [features.sessionDate, features.decisionAt, features.symbol].join('/')
      if (
        session === undefined ||
        !session.requiredFeatureRowHashes.includes(hash) ||
        seen.has(hash) ||
        identities.has(identity) ||
        features.symbol === sixBarResearchDefinition.benchmarkSymbol ||
        features.featureDefinitionHash !== manifest.featureDefinitionHash ||
        features.availableAt > features.decisionAt ||
        features.availableAt < session.openAt ||
        features.decisionAt < session.firstDecisionAt ||
        features.decisionAt >= session.closeAt ||
        label.completeAt < features.decisionAt ||
        label.completeAt >= manifest.fitCutoffAt ||
        label.completeAt >= evaluation.firstDecisionAt ||
        (label.status === SixBarRidgeLabelStatus.NoEntryFill && BigInt(label.netExecutionPnlMicros) !== 0n)
      )
        return yield* Result.fail(
          fail('Ridge training row is missing, duplicate, noncausal, or outside its declared partition'),
        )
      const pnl = Number(label.netExecutionPnlMicros)
      if (!Number.isSafeInteger(pnl)) return yield* Result.fail(fail('Ridge label must be exact float64 micro-units'))
      seen.add(hash)
      identities.add(identity)
      weights.push(1 / (nonemptyTrainingDays * session.requiredFeatureRowHashes.length))
      targets.push(yield* product(pnl / budget, 10_000))
    }
    const means = [],
      scales = [],
      columns: number[][] = []
    for (let column = 0; column < 7; column++) {
      const values = []
      for (const row of orderedRows) {
        const value = row.features.values[column]
        if (value === undefined) return yield* Result.fail(fail('Ridge feature dimensions are incomplete'))
        values.push(value)
      }
      const first = values[0]
      if (first === undefined) return yield* Result.fail(fail('Ridge training column is empty'))
      if (values.every((value) => value === first)) {
        means.push(first)
        scales.push(0)
        columns.push(values.map(() => 0))
        continue
      }
      const mean = yield* weighted(values, weights)
      const differences = [],
        squares = []
      for (const value of values) {
        const difference = yield* finite(value - mean)
        differences.push(difference)
      }
      const residualMean = yield* weighted(differences, weights)
      for (const difference of differences) {
        const centeredDifference = yield* finite(difference - residualMean)
        squares.push(yield* product(centeredDifference, centeredDifference))
      }
      const variance = yield* weighted(squares, weights)
      const scale = Math.sqrt(variance)
      if (scale <= 0 || !Number.isFinite(scale))
        return yield* Result.fail(fail('Distinct ridge feature values collapsed to an invalid population scale'))
      const normalized = []
      for (const difference of differences) {
        const value = yield* finite(difference / scale)
        if (difference !== 0 && value === 0) return yield* Result.fail(fail('Ridge normalization underflowed'))
        normalized.push(value)
      }
      means.push(mean)
      scales.push(scale)
      columns.push(normalized)
    }
    const targetMean = yield* weighted(targets, weights)
    const columnMeans = [],
      centered: number[][] = []
    for (const column of columns) {
      const mean = yield* weighted(column, weights)
      columnMeans.push(mean)
      const values = []
      for (const value of column) values.push(yield* finite(value - mean))
      centered.push(values)
    }
    const gram = Matrix.eye(7)
    const rhs = Matrix.zeros(7, 1)
    for (const [j, left] of centered.entries()) {
      const targetProducts = []
      for (const [index, value] of left.entries()) {
        const target = targets[index]
        if (target === undefined) return yield* Result.fail(fail('Ridge target dimensions are incomplete'))
        targetProducts.push(yield* product(value, target - targetMean))
      }
      rhs.set(j, 0, yield* weighted(targetProducts, weights))
      for (const [k, right] of centered.entries()) {
        if (k < j) continue
        const products = []
        for (const [index, value] of left.entries()) {
          const other = right[index]
          if (other === undefined) return yield* Result.fail(fail('Ridge covariance dimensions are incomplete'))
          products.push(yield* product(value, other))
        }
        const value = yield* finite((yield* weighted(products, weights)) + (j === k ? sixBarRidgeRecipe.lambda : 0))
        gram.set(j, k, value)
        gram.set(k, j, value)
      }
    }
    const coefficients = yield* Result.try({
      try: () => new CholeskyDecomposition(gram).solve(rhs).getColumn(0),
      catch: (cause) => fail('Ridge Cholesky solve failed', cause),
    })
    const interceptCorrections = []
    for (const [j, coefficient] of coefficients.entries()) {
      yield* finite(coefficient)
      const columnMean = columnMeans[j]
      if (columnMean === undefined) return yield* Result.fail(fail('Ridge coefficient dimensions are incomplete'))
      interceptCorrections.push(yield* product(coefficient, columnMean))
      const terms = []
      for (const [k, other] of coefficients.entries()) terms.push(yield* product(gram.get(j, k), other))
      const prediction = yield* sum(terms)
      if (Math.abs(prediction - rhs.get(j, 0)) > 1e-10 * Math.max(1, Math.abs(prediction), Math.abs(rhs.get(j, 0))))
        return yield* Result.fail(fail('Ridge solver residual exceeds float64 tolerance'))
    }
    const payload = {
      schemaVersion: 'bayn.six-bar-ridge-artifact.v1',
      qualification: 'UNQUALIFIED',
      controllerCoverage: 'UNKNOWN',
      recipeHash: manifest.recipeHash,
      featureDefinitionHash: manifest.featureDefinitionHash,
      featureOrder: sixBarResearchDefinition.features,
      solver: sixBarRidgeRecipe.solver,
      provenance: manifest.provenance,
      allocationBudgetMicros: manifest.allocationBudgetMicros,
      manifestHash,
      trainingDataHash: yield* canonicalHashV1Result(orderedRows),
      fitCutoffAt: manifest.fitCutoffAt,
      firstEvaluationDecisionAt: evaluation.firstDecisionAt,
      trainingSessions: trainingSessions.map((session) => ({
        date: session.date,
        rowCount: session.requiredFeatureRowHashes.length,
      })),
      nonemptyTrainingDays,
      trainingRows: rows.length,
      means,
      scales,
      coefficients,
      intercept: yield* finite(targetMean - (yield* sum(interceptCorrections))),
    }
    const artifactHash = yield* canonicalHashV1Result(payload)
    return yield* decodeSixBarRidgeArtifact(
      { ...payload, artifactHash },
      {
        artifactHash,
        manifestHash,
        sourceRevision: manifest.provenance.sourceRevision,
      },
    )
  }).pipe(Result.mapError((cause) => fail('Invalid offline ridge training input or computation', cause)))
