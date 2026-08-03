import { Result } from 'effect'

import { makeRunIdentityResult, makeStrategyProtocolHashResult } from '../../contracts'
import { reconcileMarkedEquity } from '../../simulation-reconciliation'
import type { DecisionEvent } from '../../types'
import type { PersistEvaluationInput } from './model'
import { persistenceCanonicalHash, persistenceMismatch } from './persistence-failures'
import type { PersistencePlanFailure, ValidatedPersistenceEvaluation } from './persistence-model'

const makeProtocolHash = (input: PersistEvaluationInput): Result.Result<string, PersistencePlanFailure> =>
  Result.mapError(
    makeStrategyProtocolHashResult(input.provenance.strategy),
    (cause): PersistencePlanFailure => ({
      _tag: 'PersistenceContractConstructionFailed',
      operation: 'strategy-protocol',
      cause,
    }),
  )

const makeExpectedRunId = (input: PersistEvaluationInput): Result.Result<string, PersistencePlanFailure> =>
  Result.map(
    Result.mapError(
      makeRunIdentityResult({
        schemaVersion: 'bayn.run-identity.v1',
        sourceRevision: input.provenance.sourceRevision,
        image: input.provenance.image,
        strategy: {
          name: input.provenance.strategy.name,
          behaviorHash: input.provenance.strategy.behaviorHash,
          parameters: input.parameters,
        },
        finalizedSnapshot: input.evaluation.inputManifest.finalizedSnapshot,
        calendarVersion: input.evaluation.inputManifest.finalizedSnapshot.calendarVersion,
        bounds: input.evaluation.inputManifest.bounds,
      }),
      (cause): PersistencePlanFailure => ({
        _tag: 'PersistenceContractConstructionFailed',
        operation: 'run-identity',
        cause,
      }),
    ),
    (identity) => identity.runId,
  )

export const validatePersistenceEvaluation = (
  input: PersistEvaluationInput,
  inputManifestSchemaVersion: string,
): Result.Result<ValidatedPersistenceEvaluation, PersistencePlanFailure> =>
  Result.gen(function* () {
    const { evaluation, parameters, provenance, reconciliation } = input
    if (evaluation.schemaVersion !== provenance.contractVersions.evaluation) {
      return yield* persistenceMismatch(
        'evaluation-schema-version',
        ['evaluation', 'schemaVersion'],
        evaluation.schemaVersion,
        provenance.contractVersions.evaluation,
      )
    }
    if (
      evaluation.inputManifest.schemaVersion !== inputManifestSchemaVersion ||
      provenance.contractVersions.inputManifest !== inputManifestSchemaVersion
    ) {
      return yield* persistenceMismatch(
        'input-manifest-schema-version',
        ['inputManifest', 'schemaVersion'],
        {
          evaluation: evaluation.inputManifest.schemaVersion,
          runtime: provenance.contractVersions.inputManifest,
        },
        inputManifestSchemaVersion,
      )
    }

    const parameterHash = yield* persistenceCanonicalHash('parameters', parameters)
    if (parameterHash !== provenance.strategy.parameterHash) {
      return yield* persistenceMismatch(
        'parameter-hash',
        ['provenance', 'strategy', 'parameterHash'],
        provenance.strategy.parameterHash,
        parameterHash,
      )
    }
    const executionHash = yield* persistenceCanonicalHash(
      'execution-model',
      evaluation.simulation.executionModel,
      'simulation',
    )
    const expectedExecutionHash = yield* persistenceCanonicalHash(
      'execution-model',
      parameters.executionModel,
      'parameters',
    )
    if (executionHash !== expectedExecutionHash) {
      return yield* persistenceMismatch(
        'execution-model',
        ['evaluation', 'simulation', 'executionModelHash'],
        executionHash,
        expectedExecutionHash,
      )
    }
    if (evaluation.simulation.costMultiplierMicros !== '1000000') {
      return yield* persistenceMismatch(
        'cost-multiplier',
        ['evaluation', 'simulation', 'costMultiplierMicros'],
        evaluation.simulation.costMultiplierMicros,
        '1000000',
      )
    }

    const protocolHash = yield* makeProtocolHash(input)
    if (protocolHash !== evaluation.protocolHash) {
      return yield* persistenceMismatch(
        'protocol-hash',
        ['evaluation', 'protocolHash'],
        evaluation.protocolHash,
        protocolHash,
      )
    }
    if (evaluation.codeRevision !== provenance.sourceRevision) {
      return yield* persistenceMismatch(
        'source-revision',
        ['evaluation', 'codeRevision'],
        evaluation.codeRevision,
        provenance.sourceRevision,
      )
    }
    if (reconciliation.runId !== evaluation.runId || reconciliation.exact !== true) {
      return yield* persistenceMismatch(
        'accounting-reconciliation',
        ['reconciliation', 'identity'],
        { runId: reconciliation.runId, exact: reconciliation.exact },
        { runId: evaluation.runId, exact: true },
      )
    }

    const { hash: inputManifestHash, ...manifestMaterial } = evaluation.inputManifest
    const expectedManifestHash = yield* persistenceCanonicalHash('input-manifest', manifestMaterial)
    if (inputManifestHash !== expectedManifestHash) {
      return yield* persistenceMismatch(
        'input-manifest-hash',
        ['evaluation', 'inputManifest', 'hash'],
        inputManifestHash,
        expectedManifestHash,
      )
    }
    const snapshotId = evaluation.inputManifest.finalizedSnapshot.snapshotId
    const expectedRunId = yield* makeExpectedRunId(input)
    if (evaluation.runId !== expectedRunId) {
      return yield* persistenceMismatch('run-identity', ['evaluation', 'runId'], evaluation.runId, expectedRunId)
    }

    const equityProofResult = reconcileMarkedEquity({
      runId: evaluation.runId,
      initialCapitalMicros: evaluation.initialCapitalMicros,
      evaluatorTotalFeesMicros: evaluation.strategy.totalFeesMicros,
      evaluatorEndingEquityMicros: evaluation.strategy.endingEquityMicros,
      events: evaluation.events,
      simulation: evaluation.simulation,
    })
    if (Result.isFailure(equityProofResult)) {
      return yield* Result.fail({
        _tag: 'SimulationReconciliationFailed',
        issues: equityProofResult.failure,
      } satisfies PersistencePlanFailure)
    }
    const equityProof = equityProofResult.success
    const proofReconciliationHash = yield* persistenceCanonicalHash(
      'marked-equity-reconciliation',
      equityProof.reconciliation,
      'reconstructed',
    )
    const evaluationReconciliationHash = yield* persistenceCanonicalHash(
      'marked-equity-reconciliation',
      evaluation.markedEquityReconciliation,
      'evaluation',
    )
    if (proofReconciliationHash !== evaluationReconciliationHash) {
      return yield* persistenceMismatch(
        'marked-equity-proof',
        ['evaluation', 'markedEquityReconciliationHash'],
        evaluationReconciliationHash,
        proofReconciliationHash,
      )
    }
    const proofEquityHash = yield* persistenceCanonicalHash('equity-series', equityProof.equitySeries, 'reconstructed')
    const evaluationEquityHash = yield* persistenceCanonicalHash('equity-series', evaluation.equitySeries, 'evaluation')
    if (proofEquityHash !== evaluationEquityHash) {
      return yield* persistenceMismatch(
        'marked-equity-proof',
        ['evaluation', 'equitySeriesHash'],
        evaluationEquityHash,
        proofEquityHash,
      )
    }

    const decisionEvents = evaluation.events.filter(
      (event): event is DecisionEvent => event.kind === 'decision' && event.terminalClose !== true,
    )
    if (evaluation.signalDecisions.length !== decisionEvents.length) {
      return yield* persistenceMismatch(
        'signal-decisions',
        ['evaluation', 'signalDecisions', 'length'],
        evaluation.signalDecisions.length,
        decisionEvents.length,
      )
    }
    for (const [index, decision] of evaluation.signalDecisions.entries()) {
      const event = decisionEvents[index]
      if (event === undefined) {
        return yield* persistenceMismatch(
          'signal-decisions',
          ['evaluation', 'signalDecisions', index],
          decision,
          'decision event',
        )
      }
      const facts = [
        ['decisionId', decision.decisionId, event.id],
        ['signalDate', decision.signalDate, event.signalDate],
        ['executionDate', decision.executionDate, event.executionDate],
      ] as const
      for (const [path, observed, expected] of facts) {
        if (observed !== expected) {
          return yield* persistenceMismatch(
            'signal-decisions',
            ['evaluation', 'signalDecisions', index, path],
            observed,
            expected,
          )
        }
      }
      const decisionWeightsHash = yield* persistenceCanonicalHash(
        'signal-target-weights',
        decision.targetWeights,
        `decision:${decision.decisionId}`,
      )
      const eventWeightsHash = yield* persistenceCanonicalHash(
        'signal-target-weights',
        event.targetWeights,
        `event:${event.id}`,
      )
      if (decisionWeightsHash !== eventWeightsHash) {
        return yield* persistenceMismatch(
          'signal-decisions',
          ['evaluation', 'signalDecisions', index, 'targetWeightsHash'],
          decisionWeightsHash,
          eventWeightsHash,
        )
      }
    }

    const candidateDates = evaluation.simulation.dailyMarks.map((point) => point.sessionDate)
    if (candidateDates.length !== evaluation.strategy.observations) {
      return yield* persistenceMismatch(
        'daily-series',
        ['evaluation', 'simulation', 'dailyMarks', 'length'],
        candidateDates.length,
        evaluation.strategy.observations,
      )
    }
    for (const [seriesName, series] of Object.entries(evaluation.benchmarkSeries)) {
      if (series.length !== candidateDates.length) {
        return yield* persistenceMismatch(
          'daily-series',
          ['evaluation', 'benchmarkSeries', seriesName, 'length'],
          series.length,
          candidateDates.length,
        )
      }
      for (const [index, point] of series.entries()) {
        if (point.sessionDate !== candidateDates[index]) {
          return yield* persistenceMismatch(
            'daily-series',
            ['evaluation', 'benchmarkSeries', seriesName, index, 'sessionDate'],
            point.sessionDate,
            candidateDates[index],
          )
        }
      }
    }

    return { protocolHash, snapshotId }
  })
