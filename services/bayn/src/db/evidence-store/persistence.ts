import { Result, Schema } from 'effect'

import {
  makeRunIdentityResult,
  makeStrategyProtocolHashResult,
  type ContractConstructionFailure,
  type RuntimeProvenance,
} from '../../contracts'
import { makeEquitySeriesArtifact } from '../../evidence-contracts'
import { canonicalHashV1Result, renderCanonicalJsonFailure, type CanonicalJsonFailure } from '../../hash'
import { QualificationResultSchema } from '../../qualification'
import { summarizeEvaluation } from '../../risk-balanced-trend'
import { strictParseOptions } from '../../schemas'
import {
  reconcileMarkedEquity,
  renderSimulationReconciliationIssues,
  type SimulationReconciliationIssue,
} from '../../simulation-reconciliation'
import type { EvaluationEvent, EvaluationResult, Protocol } from '../../types'
import { evidenceRecoveryContract as evidenceContract, type PersistenceReceipt } from '../evidence-recovery'
import type { PersistEvaluationInput } from './model'
import {
  renderQualificationDecisionFailure,
  validateQualificationOpenInput,
  type QualificationDecisionFailure,
} from './qualification'

interface PersistenceArtifact {
  readonly name: string
  readonly schemaVersion: string
  readonly contentHash: string
  readonly payload: unknown
  readonly itemCount: number
}

export type PersistencePlan = Omit<PersistEvaluationInput, 'qualification'> & {
  readonly qualification: PersistEvaluationInput['qualification']
  readonly strategyName: string
  readonly protocolHash: string
  readonly snapshotId: string
  readonly artifacts: readonly PersistenceArtifact[]
  readonly events: readonly ({
    readonly ordinal: number
    readonly contentHash: string
    readonly payload: EvaluationEvent
  } & Pick<EvaluationEvent, 'id' | 'kind'>)[]
  readonly gates: readonly ({
    readonly ordinal: number
    readonly contentHash: string
  } & EvaluationResult['verdict']['gates'][number])[]
}

const persistencePlanInvariantMessages = {
  'evaluation-schema-version': 'evaluation schema version does not match runtime provenance',
  'input-manifest-schema-version': 'input manifest schema version does not match the evidence contract',
  'parameter-hash': 'strategy parameters and provenance disagree on parameter hash',
  'execution-model': 'simulation execution model does not match strategy parameters',
  'cost-multiplier': 'candidate simulation must use the base execution-cost multiplier',
  'protocol-hash': 'evaluation and provenance disagree on protocol hash',
  'source-revision': 'evaluation code revision does not match runtime provenance',
  'accounting-reconciliation': 'reconciliation does not exactly match the evaluation run',
  'input-manifest-hash': 'input manifest hash does not match its content',
  'run-identity': 'run ID does not match runtime and input provenance',
  'marked-equity-proof': 'independent marked-equity proof diverges from the evaluation evidence',
  'signal-decisions': 'strategy signal decisions diverge from durable decision events',
  'daily-series': 'candidate and benchmark daily series are not exactly aligned',
  'events-empty': 'evaluation produced no durable events',
  'gates-empty': 'evaluation produced no economic gate outcomes',
  'qualification-result': 'qualification result diverges from the locked evaluation',
  'protocol-reference': 'stored protocol lock diverges from the evaluated protocol',
  'receipt-cardinality': 'stored run receipt is missing or duplicated',
  'receipt-identity': 'stored run identity diverged from the evaluated runtime',
  'receipt-artifact-count': 'stored artifact count is incomplete',
  'receipt-event-count': 'stored event count is incomplete',
  'receipt-gate-count': 'stored gate count is incomplete',
  'receipt-artifact-content': 'stored artifact content diverged',
  'receipt-event-content': 'stored event content diverged',
  'receipt-gate-content': 'stored gate content diverged',
  'receipt-status-history': 'stored status history diverged',
} as const

type PersistencePlanInvariant = keyof typeof persistencePlanInvariantMessages
type PersistencePath = readonly [string, ...(number | string)[]]
type PersistenceCanonicalizationOperation =
  | 'artifact-manifest-events'
  | 'artifact-manifest-gates'
  | 'artifact-payload'
  | 'benchmark-series'
  | 'equity-series'
  | 'event-payload'
  | 'execution-model'
  | 'gate-payload'
  | 'input-manifest'
  | 'marked-equity-reconciliation'
  | 'parameters'
  | 'qualification-prior-trials'
  | 'qualification-verdict'
  | 'signal-target-weights'
  | 'protocol-parameters'
  | 'stored-artifact'
  | 'stored-event'
  | 'stored-gate'
  | 'stored-status'

export type PersistencePlanFailure =
  | {
      readonly _tag: 'PersistenceMismatch'
      readonly invariant: PersistencePlanInvariant
      readonly path: PersistencePath
      readonly observed: unknown
      readonly expected: unknown
    }
  | {
      readonly _tag: 'PersistenceCanonicalizationFailed'
      readonly operation: PersistenceCanonicalizationOperation
      readonly subject?: string
      readonly cause: CanonicalJsonFailure
    }
  | {
      readonly _tag: 'PersistenceContractConstructionFailed'
      readonly operation: 'run-identity' | 'strategy-protocol'
      readonly cause: ContractConstructionFailure
    }
  | {
      readonly _tag: 'PersistenceQualificationInvalid'
      readonly cause: QualificationDecisionFailure
    }
  | {
      readonly _tag: 'PersistenceQualificationResultInvalid'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'SimulationReconciliationFailed'
      readonly issues: readonly SimulationReconciliationIssue[]
    }

interface ValidatedPersistenceEvaluation {
  readonly protocolHash: string
  readonly snapshotId: string
}

interface PersistenceEvidenceMaterial {
  readonly baseArtifacts: readonly PersistenceArtifact[]
  readonly events: PersistencePlan['events']
  readonly gates: PersistencePlan['gates']
}

const decodeQualificationResult = Schema.decodeUnknownResult(QualificationResultSchema, strictParseOptions)

const mismatch = (
  invariant: PersistencePlanInvariant,
  path: PersistencePath,
  observed: unknown,
  expected: unknown,
): Result.Result<never, PersistencePlanFailure> =>
  Result.fail({ _tag: 'PersistenceMismatch', invariant, path, observed, expected })

const canonicalHash = (
  operation: PersistenceCanonicalizationOperation,
  value: unknown,
  subject?: string,
): Result.Result<string, PersistencePlanFailure> =>
  Result.mapError(
    canonicalHashV1Result(value),
    (cause): PersistencePlanFailure => ({
      _tag: 'PersistenceCanonicalizationFailed',
      operation,
      ...(subject === undefined ? {} : { subject }),
      cause,
    }),
  )

const makeArtifact = (
  name: string,
  schemaVersion: string,
  payload: unknown,
  itemCount = 0,
): Result.Result<PersistenceArtifact, PersistencePlanFailure> =>
  Result.map(canonicalHash('artifact-payload', payload, name), (contentHash) => ({
    name,
    schemaVersion,
    contentHash,
    payload,
    itemCount,
  }))

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

const validatePersistenceEvaluation = (
  input: PersistEvaluationInput,
): Result.Result<ValidatedPersistenceEvaluation, PersistencePlanFailure> =>
  Result.gen(function* () {
    const { evaluation, parameters, provenance, reconciliation } = input
    if (evaluation.schemaVersion !== provenance.contractVersions.evaluation) {
      return yield* mismatch(
        'evaluation-schema-version',
        ['evaluation', 'schemaVersion'],
        evaluation.schemaVersion,
        provenance.contractVersions.evaluation,
      )
    }
    if (
      evaluation.inputManifest.schemaVersion !== evidenceContract.inputManifestSchemaVersion ||
      provenance.contractVersions.inputManifest !== evidenceContract.inputManifestSchemaVersion
    ) {
      return yield* mismatch(
        'input-manifest-schema-version',
        ['inputManifest', 'schemaVersion'],
        {
          evaluation: evaluation.inputManifest.schemaVersion,
          runtime: provenance.contractVersions.inputManifest,
        },
        evidenceContract.inputManifestSchemaVersion,
      )
    }

    const parameterHash = yield* canonicalHash('parameters', parameters)
    if (parameterHash !== provenance.strategy.parameterHash) {
      return yield* mismatch(
        'parameter-hash',
        ['provenance', 'strategy', 'parameterHash'],
        provenance.strategy.parameterHash,
        parameterHash,
      )
    }
    const executionHash = yield* canonicalHash('execution-model', evaluation.simulation.executionModel, 'simulation')
    const expectedExecutionHash = yield* canonicalHash('execution-model', parameters.executionModel, 'parameters')
    if (executionHash !== expectedExecutionHash) {
      return yield* mismatch(
        'execution-model',
        ['evaluation', 'simulation', 'executionModelHash'],
        executionHash,
        expectedExecutionHash,
      )
    }
    if (evaluation.simulation.costMultiplierMicros !== '1000000') {
      return yield* mismatch(
        'cost-multiplier',
        ['evaluation', 'simulation', 'costMultiplierMicros'],
        evaluation.simulation.costMultiplierMicros,
        '1000000',
      )
    }

    const protocolHash = yield* makeProtocolHash(input)
    if (protocolHash !== evaluation.protocolHash) {
      return yield* mismatch('protocol-hash', ['evaluation', 'protocolHash'], evaluation.protocolHash, protocolHash)
    }
    if (evaluation.codeRevision !== provenance.sourceRevision) {
      return yield* mismatch(
        'source-revision',
        ['evaluation', 'codeRevision'],
        evaluation.codeRevision,
        provenance.sourceRevision,
      )
    }
    if (reconciliation.runId !== evaluation.runId || reconciliation.exact !== true) {
      return yield* mismatch(
        'accounting-reconciliation',
        ['reconciliation', 'identity'],
        { runId: reconciliation.runId, exact: reconciliation.exact },
        { runId: evaluation.runId, exact: true },
      )
    }

    const { hash: inputManifestHash, ...manifestMaterial } = evaluation.inputManifest
    const expectedManifestHash = yield* canonicalHash('input-manifest', manifestMaterial)
    if (inputManifestHash !== expectedManifestHash) {
      return yield* mismatch(
        'input-manifest-hash',
        ['evaluation', 'inputManifest', 'hash'],
        inputManifestHash,
        expectedManifestHash,
      )
    }
    const snapshotId = evaluation.inputManifest.finalizedSnapshot.snapshotId
    const expectedRunId = yield* makeExpectedRunId(input)
    if (evaluation.runId !== expectedRunId) {
      return yield* mismatch('run-identity', ['evaluation', 'runId'], evaluation.runId, expectedRunId)
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
    const proofReconciliationHash = yield* canonicalHash(
      'marked-equity-reconciliation',
      equityProof.reconciliation,
      'reconstructed',
    )
    const evaluationReconciliationHash = yield* canonicalHash(
      'marked-equity-reconciliation',
      evaluation.markedEquityReconciliation,
      'evaluation',
    )
    if (proofReconciliationHash !== evaluationReconciliationHash) {
      return yield* mismatch(
        'marked-equity-proof',
        ['evaluation', 'markedEquityReconciliationHash'],
        evaluationReconciliationHash,
        proofReconciliationHash,
      )
    }
    const proofEquityHash = yield* canonicalHash('equity-series', equityProof.equitySeries, 'reconstructed')
    const evaluationEquityHash = yield* canonicalHash('equity-series', evaluation.equitySeries, 'evaluation')
    if (proofEquityHash !== evaluationEquityHash) {
      return yield* mismatch(
        'marked-equity-proof',
        ['evaluation', 'equitySeriesHash'],
        evaluationEquityHash,
        proofEquityHash,
      )
    }

    const decisionEvents = evaluation.events.filter((event) => event.kind === 'decision')
    if (evaluation.signalDecisions.length !== decisionEvents.length) {
      return yield* mismatch(
        'signal-decisions',
        ['evaluation', 'signalDecisions', 'length'],
        evaluation.signalDecisions.length,
        decisionEvents.length,
      )
    }
    for (const [index, decision] of evaluation.signalDecisions.entries()) {
      const event = decisionEvents[index]
      if (event === undefined) {
        return yield* mismatch('signal-decisions', ['evaluation', 'signalDecisions', index], decision, 'decision event')
      }
      const facts = [
        ['decisionId', decision.decisionId, event.id],
        ['signalDate', decision.signalDate, event.signalDate],
        ['executionDate', decision.executionDate, event.executionDate],
      ] as const
      for (const [path, observed, expected] of facts) {
        if (observed !== expected) {
          return yield* mismatch('signal-decisions', ['evaluation', 'signalDecisions', index, path], observed, expected)
        }
      }
      const decisionWeightsHash = yield* canonicalHash(
        'signal-target-weights',
        decision.targetWeights,
        `decision:${decision.decisionId}`,
      )
      const eventWeightsHash = yield* canonicalHash('signal-target-weights', event.targetWeights, `event:${event.id}`)
      if (decisionWeightsHash !== eventWeightsHash) {
        return yield* mismatch(
          'signal-decisions',
          ['evaluation', 'signalDecisions', index, 'targetWeightsHash'],
          decisionWeightsHash,
          eventWeightsHash,
        )
      }
    }

    const candidateDates = evaluation.simulation.dailyMarks.map((point) => point.sessionDate)
    if (candidateDates.length !== evaluation.strategy.observations) {
      return yield* mismatch(
        'daily-series',
        ['evaluation', 'simulation', 'dailyMarks', 'length'],
        candidateDates.length,
        evaluation.strategy.observations,
      )
    }
    for (const [seriesName, series] of Object.entries(evaluation.benchmarkSeries)) {
      if (series.length !== candidateDates.length) {
        return yield* mismatch(
          'daily-series',
          ['evaluation', 'benchmarkSeries', seriesName, 'length'],
          series.length,
          candidateDates.length,
        )
      }
      for (const [index, point] of series.entries()) {
        if (point.sessionDate !== candidateDates[index]) {
          return yield* mismatch(
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
        contentHash: yield* canonicalHash('event-payload', event, event.id),
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
        contentHash: yield* canonicalHash('gate-payload', gate, gate.name),
      })
    }
    if (events.length === 0) return yield* mismatch('events-empty', ['events', 'length'], 0, 'at least 1')
    if (gates.length === 0) return yield* mismatch('gates-empty', ['gates', 'length'], 0, 'at least 1')
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
      if (observed !== expected) return yield* mismatch('qualification-result', path, observed, expected)
    }
    const resultVerdictHash = yield* canonicalHash('qualification-verdict', result.evaluationVerdict, 'result')
    const evaluationVerdictHash = yield* canonicalHash('qualification-verdict', evaluation.verdict, 'evaluation')
    if (resultVerdictHash !== evaluationVerdictHash) {
      return yield* mismatch(
        'qualification-result',
        ['result', 'evaluationVerdictHash'],
        resultVerdictHash,
        evaluationVerdictHash,
      )
    }
    const resultTrialsHash = yield* canonicalHash(
      'qualification-prior-trials',
      result.analysis.priorTrialRunIds,
      'result',
    )
    const lockTrialsHash = yield* canonicalHash('qualification-prior-trials', lock.priorTrialRunIds, 'lock')
    if (resultTrialsHash !== lockTrialsHash) {
      return yield* mismatch(
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
    const eventsHash = yield* canonicalHash(
      'artifact-manifest-events',
      evidence.events.map(({ ordinal, id, kind, contentHash }) => ({ ordinal, id, kind, contentHash })),
    )
    const gatesHash = yield* canonicalHash(
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
    const validated = yield* validatePersistenceEvaluation(input)
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

export interface StoredProtocolReference {
  readonly protocol_hash: string
  readonly schema_version: string
  readonly strategy_name: string
  readonly behavior_hash: string
  readonly parameter_hash: string
  readonly parameters: Protocol
}

export interface StoredReceiptReference {
  readonly run_id: string
  readonly protocol_hash: string
  readonly snapshot_id: string
  readonly evaluation_schema_version: string
  readonly source_revision: string
  readonly image_repository: string
  readonly image_digest: string
  readonly strategy_name: string
  readonly initial_capital_micros: string
  readonly expected_artifact_count: number
  readonly expected_event_count: number
  readonly expected_gate_count: number
  readonly artifact_count: number
  readonly event_count: number
  readonly gate_count: number
}

export interface StoredArtifactReference {
  readonly artifact_name: string
  readonly schema_version: string
  readonly content_hash: string
  readonly payload: unknown
}

export interface StoredEventReference {
  readonly ordinal: number
  readonly event_id: string
  readonly event_kind: EvaluationEvent['kind']
  readonly content_hash: string
  readonly payload: EvaluationEvent
}

export interface StoredGateReference {
  readonly ordinal: number
  readonly gate_name: string
  readonly passed: boolean
  readonly actual: number | boolean | string
  readonly required: number | boolean | string
  readonly content_hash: string
}

export type StoredStatusReference =
  | {
      readonly status: 'WRITING'
      readonly detail: { readonly artifactCount: number; readonly eventCount: number; readonly gateCount: number }
    }
  | {
      readonly status: 'COMPLETE'
      readonly detail: { readonly reconciliationExact: true; readonly verdict: 'PASS' | 'FAIL_CLOSED' }
    }

export interface StoredPersistenceReferences {
  readonly receipts: readonly StoredReceiptReference[]
  readonly artifacts: readonly StoredArtifactReference[]
  readonly events: readonly StoredEventReference[]
  readonly gates: readonly StoredGateReference[]
  readonly statuses: readonly StoredStatusReference[]
}

export const validateProtocolReference = (
  input: {
    readonly protocolHash: string
    readonly provenance: RuntimeProvenance
    readonly parameters: Protocol
  },
  reference: StoredProtocolReference,
): Result.Result<void, PersistencePlanFailure> =>
  Result.gen(function* () {
    const storedParameterHash = yield* canonicalHash('protocol-parameters', reference.parameters, 'stored')
    const expectedParameterHash = yield* canonicalHash('protocol-parameters', input.parameters, 'input')
    const facts = [
      [['schemaVersion'], reference.schema_version, input.provenance.strategy.parameterSchemaVersion],
      [['strategyName'], reference.strategy_name, input.provenance.strategy.name],
      [['behaviorHash'], reference.behavior_hash, input.provenance.strategy.behaviorHash],
      [['parameterHash'], reference.parameter_hash, input.provenance.strategy.parameterHash],
      [['storedParametersHash'], storedParameterHash, input.provenance.strategy.parameterHash],
      [['inputParametersHash'], expectedParameterHash, input.provenance.strategy.parameterHash],
      [['protocolHash'], reference.protocol_hash, input.protocolHash],
    ] as const
    for (const [path, observed, expected] of facts) {
      if (observed !== expected) return yield* mismatch('protocol-reference', path, observed, expected)
    }
    const storedProtocolHash = yield* Result.mapError(
      makeStrategyProtocolHashResult({
        name: input.provenance.strategy.name,
        behaviorHash: reference.behavior_hash,
        parameterHash: reference.parameter_hash,
        parameterSchemaVersion: input.provenance.strategy.parameterSchemaVersion,
      }),
      (cause): PersistencePlanFailure => ({
        _tag: 'PersistenceContractConstructionFailed',
        operation: 'strategy-protocol',
        cause,
      }),
    )
    if (storedProtocolHash !== input.protocolHash) {
      return yield* mismatch('protocol-reference', ['derivedProtocolHash'], storedProtocolHash, input.protocolHash)
    }
  })

export const validatePersistenceReceipt = (
  plan: PersistencePlan,
  references: StoredPersistenceReferences,
  deduplicated: boolean,
): Result.Result<PersistenceReceipt, PersistencePlanFailure> =>
  Result.gen(function* () {
    if (references.receipts.length !== 1) {
      return yield* mismatch('receipt-cardinality', ['receipts', 'length'], references.receipts.length, 1)
    }
    const row = references.receipts[0]
    if (row === undefined) return yield* mismatch('receipt-cardinality', ['receipts', 'length'], 0, 1)
    const identityFacts = [
      [['runId'], row.run_id, plan.evaluation.runId],
      [['protocolHash'], row.protocol_hash, plan.protocolHash],
      [['snapshotId'], row.snapshot_id, plan.snapshotId],
      [['evaluationSchemaVersion'], row.evaluation_schema_version, plan.evaluation.schemaVersion],
      [['sourceRevision'], row.source_revision, plan.provenance.sourceRevision],
      [['imageRepository'], row.image_repository, plan.provenance.image.repository],
      [['imageDigest'], row.image_digest, plan.provenance.image.digest],
      [['strategyName'], row.strategy_name, plan.strategyName],
      [['initialCapitalMicros'], row.initial_capital_micros, plan.evaluation.initialCapitalMicros],
    ] as const
    for (const [path, observed, expected] of identityFacts) {
      if (observed !== expected) return yield* mismatch('receipt-identity', path, observed, expected)
    }
    const countFacts = [
      [
        'receipt-artifact-count',
        ['artifacts', 'count'],
        { expected: row.expected_artifact_count, actual: row.artifact_count, loaded: references.artifacts.length },
        plan.artifacts.length,
      ],
      [
        'receipt-event-count',
        ['events', 'count'],
        { expected: row.expected_event_count, actual: row.event_count, loaded: references.events.length },
        plan.events.length,
      ],
      [
        'receipt-gate-count',
        ['gates', 'count'],
        { expected: row.expected_gate_count, actual: row.gate_count, loaded: references.gates.length },
        plan.gates.length,
      ],
    ] as const
    for (const [invariant, path, observed, expected] of countFacts) {
      if (observed.expected !== expected || observed.actual !== expected || observed.loaded !== expected) {
        return yield* mismatch(invariant, path, observed, expected)
      }
    }

    const expectedArtifacts = [...plan.artifacts].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
    for (const [index, artifact] of references.artifacts.entries()) {
      const expected = expectedArtifacts[index]
      if (expected === undefined) {
        return yield* mismatch('receipt-artifact-content', ['artifacts', index], artifact.artifact_name, 'absent')
      }
      const payloadHash = yield* canonicalHash('stored-artifact', artifact.payload, artifact.artifact_name)
      const observed = {
        name: artifact.artifact_name,
        schemaVersion: artifact.schema_version,
        contentHash: artifact.content_hash,
        payloadHash,
      }
      const expectedFacts = {
        name: expected.name,
        schemaVersion: expected.schemaVersion,
        contentHash: expected.contentHash,
        payloadHash: expected.contentHash,
      }
      if (
        observed.name !== expectedFacts.name ||
        observed.schemaVersion !== expectedFacts.schemaVersion ||
        observed.contentHash !== expectedFacts.contentHash ||
        observed.payloadHash !== expectedFacts.payloadHash
      ) {
        return yield* mismatch('receipt-artifact-content', ['artifacts', index], observed, expectedFacts)
      }
    }

    for (const [index, event] of references.events.entries()) {
      const expected = plan.events[index]
      if (expected === undefined) {
        return yield* mismatch('receipt-event-content', ['events', index], event.event_id, 'absent')
      }
      const payloadHash = yield* canonicalHash('stored-event', event.payload, event.event_id)
      const observed = {
        ordinal: event.ordinal,
        id: event.event_id,
        kind: event.event_kind,
        contentHash: event.content_hash,
        payloadHash,
      }
      const expectedFacts = {
        ordinal: expected.ordinal,
        id: expected.id,
        kind: expected.kind,
        contentHash: expected.contentHash,
        payloadHash: expected.contentHash,
      }
      if (
        observed.ordinal !== expectedFacts.ordinal ||
        observed.id !== expectedFacts.id ||
        observed.kind !== expectedFacts.kind ||
        observed.contentHash !== expectedFacts.contentHash ||
        observed.payloadHash !== expectedFacts.payloadHash
      ) {
        return yield* mismatch('receipt-event-content', ['events', index], observed, expectedFacts)
      }
    }

    for (const [index, gate] of references.gates.entries()) {
      const expected = plan.gates[index]
      if (expected === undefined) {
        return yield* mismatch('receipt-gate-content', ['gates', index], gate.gate_name, 'absent')
      }
      const payloadHash = yield* canonicalHash(
        'stored-gate',
        { name: gate.gate_name, passed: gate.passed, actual: gate.actual, required: gate.required },
        gate.gate_name,
      )
      const observed = {
        ordinal: gate.ordinal,
        name: gate.gate_name,
        passed: gate.passed,
        contentHash: gate.content_hash,
        payloadHash,
      }
      const expectedFacts = {
        ordinal: expected.ordinal,
        name: expected.name,
        passed: expected.passed,
        contentHash: expected.contentHash,
        payloadHash: expected.contentHash,
      }
      if (
        observed.ordinal !== expectedFacts.ordinal ||
        observed.name !== expectedFacts.name ||
        observed.passed !== expectedFacts.passed ||
        observed.contentHash !== expectedFacts.contentHash ||
        observed.payloadHash !== expectedFacts.payloadHash
      ) {
        return yield* mismatch('receipt-gate-content', ['gates', index], observed, expectedFacts)
      }
    }

    if (references.statuses.length !== 2) {
      return yield* mismatch('receipt-status-history', ['statuses', 'length'], references.statuses.length, 2)
    }
    const writing = references.statuses[0]
    const complete = references.statuses[1]
    if (writing?.status !== 'WRITING' || complete?.status !== 'COMPLETE') {
      return yield* mismatch(
        'receipt-status-history',
        ['statuses', 'order'],
        references.statuses.map((status) => status.status),
        ['WRITING', 'COMPLETE'],
      )
    }
    const writingHash = yield* canonicalHash('stored-status', writing.detail, 'WRITING')
    const expectedWritingHash = yield* canonicalHash(
      'stored-status',
      { artifactCount: plan.artifacts.length, eventCount: plan.events.length, gateCount: plan.gates.length },
      'expected-WRITING',
    )
    const completeHash = yield* canonicalHash('stored-status', complete.detail, 'COMPLETE')
    const expectedCompleteHash = yield* canonicalHash(
      'stored-status',
      { reconciliationExact: true, verdict: plan.evaluation.verdict.status },
      'expected-COMPLETE',
    )
    if (writingHash !== expectedWritingHash || completeHash !== expectedCompleteHash) {
      return yield* mismatch(
        'receipt-status-history',
        ['statuses', 'contentHash'],
        { writingHash, completeHash },
        { writingHash: expectedWritingHash, completeHash: expectedCompleteHash },
      )
    }
    return {
      runId: row.run_id,
      deduplicated,
      artifactCount: row.artifact_count,
      eventCount: row.event_count,
      gateCount: row.gate_count,
    }
  })

const renderFact = (value: unknown): string => {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'undefined':
      return String(value)
    case 'symbol':
      return value.description === undefined ? 'symbol' : `symbol(${value.description})`
    case 'function':
      return 'function'
    case 'object':
      return Array.isArray(value) ? `array(length=${value.length})` : 'object'
  }
  return 'unknown'
}

const renderContractConstructionFailure = (failure: ContractConstructionFailure): string => {
  switch (failure._tag) {
    case 'ContractCanonicalizationFailed':
      return `${failure.operation}: ${renderCanonicalJsonFailure(failure.cause)}`
    case 'ContractSchemaInvalid':
      return `${failure.operation}: ${failure.cause.message}`
  }
}

export const renderPersistencePlanFailure = (failure: PersistencePlanFailure): string => {
  switch (failure._tag) {
    case 'PersistenceMismatch':
      return `${persistencePlanInvariantMessages[failure.invariant]} at ${failure.path.join('.')}: observed ${renderFact(failure.observed)}, expected ${renderFact(failure.expected)}`
    case 'PersistenceCanonicalizationFailed':
      return `persistence ${failure.operation}${failure.subject === undefined ? '' : ` (${failure.subject})`} failed: ${renderCanonicalJsonFailure(failure.cause)}`
    case 'PersistenceContractConstructionFailed':
      return `persistence ${failure.operation} construction failed: ${renderContractConstructionFailure(failure.cause)}`
    case 'PersistenceQualificationInvalid':
      return `qualification evidence is invalid: ${renderQualificationDecisionFailure(failure.cause)}`
    case 'PersistenceQualificationResultInvalid':
      return `qualification result failed schema validation: ${failure.cause.message}`
    case 'SimulationReconciliationFailed':
      return `marked-equity reconciliation failed: ${renderSimulationReconciliationIssues(failure.issues)}`
  }
}
