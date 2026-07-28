import { Result, Schema } from 'effect'

import { makeEquitySeriesArtifact } from '../../evidence-contracts'
import { QualificationResultSchema } from '../../qualification'
import { summarizeEvaluation } from '../../risk-balanced-trend'
import { strictParseOptions } from '../../schemas'
import { evidenceRecoveryContract as evidenceContract } from '../evidence-recovery'
import type { PersistEvaluationInput } from './model'
import { persistenceCanonicalHash, persistenceMismatch } from './persistence-failures'
import { validatePersistenceEvaluation } from './persistence-evaluation'
import type {
  PersistenceArtifact,
  PersistenceEvidenceMaterial,
  PersistencePlan,
  PersistencePlanFailure,
  ValidatedPersistenceEvaluation,
} from './persistence-model'
import { validateQualificationOpenInput } from './qualification'

const decodeQualificationResult = Schema.decodeUnknownResult(QualificationResultSchema, strictParseOptions)

const makeArtifact = (
  name: string,
  schemaVersion: string,
  payload: unknown,
  itemCount = 0,
): Result.Result<PersistenceArtifact, PersistencePlanFailure> =>
  Result.map(persistenceCanonicalHash('artifact-payload', payload, name), (contentHash) => ({
    name,
    schemaVersion,
    contentHash,
    payload,
    itemCount,
  }))

const makePersistenceEvidence = (
  input: PersistEvaluationInput,
): Result.Result<PersistenceEvidenceMaterial, PersistencePlanFailure> =>
  Result.gen(function* () {
    const { evaluation, reconciliation } = input
    const baseArtifacts = [
      yield* makeArtifact('evaluation-summary', evidenceContract.summarySchemaVersion, summarizeEvaluation(evaluation)),
      yield* makeArtifact('input-manifest', evaluation.inputManifest.schemaVersion, evaluation.inputManifest),
      yield* makeArtifact('strategy', 'bayn.performance-metrics.v2', evaluation.strategy),
      yield* makeArtifact('buy-and-hold', 'bayn.performance-metrics.v2', evaluation.buyAndHold),
      yield* makeArtifact('direct-volatility-timing', 'bayn.performance-metrics.v2', evaluation.directVolTiming),
      yield* makeArtifact('double-cost-strategy', 'bayn.performance-metrics.v2', evaluation.doubleCostStrategy),
      yield* makeArtifact(
        'simulated-orders',
        'bayn.simulated-orders.v2',
        {
          schemaVersion: 'bayn.simulated-orders.v2',
          executionModel: evaluation.simulation.executionModel,
          costMultiplierMicros: evaluation.simulation.costMultiplierMicros,
          items: evaluation.simulation.orders,
        },
        evaluation.simulation.orders.length,
      ),
      yield* makeArtifact(
        'cash-changes',
        'bayn.cash-changes.v2',
        { schemaVersion: 'bayn.cash-changes.v2', items: evaluation.simulation.cashChanges },
        evaluation.simulation.cashChanges.length,
      ),
      yield* makeArtifact(
        'daily-position-marks',
        'bayn.daily-position-marks.v3',
        { schemaVersion: 'bayn.daily-position-marks.v3', items: evaluation.simulation.dailyMarks },
        evaluation.simulation.dailyMarks.length,
      ),
      yield* makeArtifact(
        evidenceContract.signalDecisionsArtifactName,
        evidenceContract.signalDecisionsSchemaVersion,
        { schemaVersion: evidenceContract.signalDecisionsSchemaVersion, items: evaluation.signalDecisions },
        evaluation.signalDecisions.length,
      ),
      yield* makeArtifact(
        'buy-and-hold-series',
        'bayn.daily-performance-series.v1',
        {
          schemaVersion: 'bayn.daily-performance-series.v1',
          series: 'buy-and-hold',
          items: evaluation.benchmarkSeries.buyAndHold,
        },
        evaluation.benchmarkSeries.buyAndHold.length,
      ),
      yield* makeArtifact(
        'direct-volatility-timing-series',
        'bayn.daily-performance-series.v1',
        {
          schemaVersion: 'bayn.daily-performance-series.v1',
          series: 'direct-volatility-timing',
          items: evaluation.benchmarkSeries.directVolTiming,
        },
        evaluation.benchmarkSeries.directVolTiming.length,
      ),
      yield* makeArtifact(
        'double-cost-strategy-series',
        'bayn.daily-performance-series.v1',
        {
          schemaVersion: 'bayn.daily-performance-series.v1',
          series: 'double-cost-strategy',
          items: evaluation.benchmarkSeries.doubleCostStrategy,
        },
        evaluation.benchmarkSeries.doubleCostStrategy.length,
      ),
      yield* makeArtifact(
        'equity-series',
        'bayn.equity-series.v1',
        makeEquitySeriesArtifact(evaluation.equitySeries),
        evaluation.equitySeries.length,
      ),
      yield* makeArtifact(
        'marked-equity-reconciliation',
        evaluation.markedEquityReconciliation.schemaVersion,
        evaluation.markedEquityReconciliation,
      ),
      yield* makeArtifact('reconciliation', 'bayn.reconciliation.v1', reconciliation),
    ]

    const events: Array<PersistencePlan['events'][number]> = []
    for (const [ordinal, event] of evaluation.events.entries()) {
      events.push({
        ordinal,
        id: event.id,
        kind: event.kind,
        contentHash: yield* persistenceCanonicalHash('event-payload', event, event.id),
        payload: event,
      })
    }
    const gates: Array<PersistencePlan['gates'][number]> = []
    for (const [ordinal, gate] of evaluation.verdict.gates.entries()) {
      gates.push({
        ordinal,
        name: gate.name,
        passed: gate.passed,
        actual: gate.actual,
        required: gate.required,
        contentHash: yield* persistenceCanonicalHash('gate-payload', gate, gate.name),
      })
    }
    if (events.length === 0) return yield* persistenceMismatch('events-empty', ['events', 'length'], 0, 'at least 1')
    if (gates.length === 0) return yield* persistenceMismatch('gates-empty', ['gates', 'length'], 0, 'at least 1')
    return { baseArtifacts, events, gates }
  })

const validatePersistenceQualification = (
  input: PersistEvaluationInput,
): Result.Result<PersistEvaluationInput['qualification'], PersistencePlanFailure> =>
  Result.gen(function* () {
    const suppliedQualification = input.qualification
    if (suppliedQualification === undefined) return undefined
    const { evaluation, parameters, provenance } = input
    const validated = yield* Result.mapError(
      validateQualificationOpenInput({
        lock: suppliedQualification.lock,
        inputManifest: evaluation.inputManifest,
        parameters,
        provenance,
      }),
      (cause): PersistencePlanFailure => ({ _tag: 'PersistenceQualificationInvalid', cause }),
    )
    const result = yield* Result.mapError(
      decodeQualificationResult(suppliedQualification.result),
      (cause): PersistencePlanFailure => ({ _tag: 'PersistenceQualificationResultInvalid', cause }),
    )
    const lock = validated.lock
    const scalarFacts = [
      [['lock', 'candidateRunId'], lock.candidateRunId, evaluation.runId],
      [['lock', 'data', 'selectedSessionCount'], lock.data.selectedSessionCount, evaluation.strategy.observations],
      [
        ['lock', 'data', 'selectedSessionCount'],
        lock.data.selectedSessionCount,
        evaluation.simulation.dailyMarks.length,
      ],
      [['lock', 'data', 'selectedRebalanceCount'], lock.data.selectedRebalanceCount, evaluation.signalDecisions.length],
      [['result', 'lockId'], result.lockId, lock.lockId],
      [['result', 'runId'], result.runId, evaluation.runId],
    ] as const
    for (const [path, observed, expected] of scalarFacts) {
      if (observed !== expected) return yield* persistenceMismatch('qualification-result', path, observed, expected)
    }
    const resultVerdictHash = yield* persistenceCanonicalHash(
      'qualification-verdict',
      result.evaluationVerdict,
      'result',
    )
    const evaluationVerdictHash = yield* persistenceCanonicalHash(
      'qualification-verdict',
      evaluation.verdict,
      'evaluation',
    )
    if (resultVerdictHash !== evaluationVerdictHash) {
      return yield* persistenceMismatch(
        'qualification-result',
        ['result', 'evaluationVerdictHash'],
        resultVerdictHash,
        evaluationVerdictHash,
      )
    }
    const resultTrialsHash = yield* persistenceCanonicalHash(
      'qualification-prior-trials',
      result.analysis.priorTrialRunIds,
      'result',
    )
    const lockTrialsHash = yield* persistenceCanonicalHash('qualification-prior-trials', lock.priorTrialRunIds, 'lock')
    if (resultTrialsHash !== lockTrialsHash) {
      return yield* persistenceMismatch(
        'qualification-result',
        ['result', 'analysis', 'priorTrialRunIdsHash'],
        resultTrialsHash,
        lockTrialsHash,
      )
    }
    return { lock, result }
  })

const makePersistenceArtifactManifest = (
  input: PersistEvaluationInput,
  validated: ValidatedPersistenceEvaluation,
  evidence: PersistenceEvidenceMaterial,
): Result.Result<
  {
    readonly schemaVersion: 'bayn.qualification-artifact-manifest.v1'
    readonly identity: unknown
    readonly execution: unknown
    readonly artifacts: readonly unknown[]
    readonly events: { readonly count: number; readonly contentHash: string }
    readonly gates: { readonly count: number; readonly contentHash: string }
  },
  PersistencePlanFailure
> =>
  Result.gen(function* () {
    const { evaluation, provenance } = input
    const eventsHash = yield* persistenceCanonicalHash(
      'artifact-manifest-events',
      evidence.events.map(({ ordinal, id, kind, contentHash }) => ({ ordinal, id, kind, contentHash })),
    )
    const gatesHash = yield* persistenceCanonicalHash(
      'artifact-manifest-gates',
      evidence.gates.map(({ ordinal, name, passed, contentHash }) => ({ ordinal, name, passed, contentHash })),
    )
    return {
      schemaVersion: 'bayn.qualification-artifact-manifest.v1',
      identity: {
        runId: evaluation.runId,
        evaluationSchemaVersion: evaluation.schemaVersion,
        protocolHash: validated.protocolHash,
        sourceRevision: provenance.sourceRevision,
        image: provenance.image,
        snapshotId: validated.snapshotId,
        publicationId: evaluation.inputManifest.finalizedSnapshot.publicationId,
        inputManifestHash: evaluation.inputManifest.hash,
        bounds: evaluation.inputManifest.bounds,
        calendarVersion: evaluation.inputManifest.finalizedSnapshot.calendarVersion,
      },
      execution: {
        parameterSchemaVersion: provenance.strategy.parameterSchemaVersion,
        parameterHash: provenance.strategy.parameterHash,
        simulationSchemaVersion: evaluation.simulation.schemaVersion,
        executionModel: evaluation.simulation.executionModel,
        costMultiplierMicros: evaluation.simulation.costMultiplierMicros,
      },
      artifacts: [...evidence.baseArtifacts]
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        .map((artifact) => ({
          name: artifact.name,
          schemaVersion: artifact.schemaVersion,
          itemCount: artifact.itemCount,
          contentHash: artifact.contentHash,
        })),
      events: { count: evidence.events.length, contentHash: eventsHash },
      gates: { count: evidence.gates.length, contentHash: gatesHash },
    }
  })

export const makePersistencePlan = (
  input: PersistEvaluationInput,
): Result.Result<PersistencePlan, PersistencePlanFailure> =>
  Result.gen(function* () {
    const validated = yield* validatePersistenceEvaluation(input, evidenceContract.inputManifestSchemaVersion)
    const evidence = yield* makePersistenceEvidence(input)
    const qualification = yield* validatePersistenceQualification(input)
    const artifactManifest = yield* makePersistenceArtifactManifest(input, validated, evidence)
    const artifacts = [
      ...evidence.baseArtifacts,
      yield* makeArtifact('qualification-artifact-manifest', artifactManifest.schemaVersion, artifactManifest),
    ]
    return {
      ...input,
      qualification,
      strategyName: input.provenance.strategy.name,
      protocolHash: validated.protocolHash,
      snapshotId: validated.snapshotId,
      artifacts,
      events: evidence.events,
      gates: evidence.gates,
    }
  })
