import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Context, Data, Effect, FileSystem, Layer, Match, Option, Result, Schema } from 'effect'
import { SqlSchema } from 'effect/unstable/sql'
import { isSqlError, type SqlErrorReason } from 'effect/unstable/sql/SqlError'

import type { RuntimeConfig } from '../config'
import {
  FinalizedSnapshotProvenanceSchema,
  makeRunIdentity,
  makeStrategyProtocolHash,
  type RuntimeProvenance,
} from '../contracts'
import { EvaluationEventSchema, makeEquitySeriesArtifact } from '../evidence-contracts'
import { canonicalHashV1 } from '../hash'
import {
  QualificationLockSchema,
  QualificationResultSchema,
  type QualificationLock,
  type QualificationResult,
} from '../qualification'
import { ProtocolSchema } from '../protocol'
import { summarizeEvaluation } from '../risk-balanced-trend'
import {
  reconcileMarkedEquity,
  renderSimulationReconciliationIssues,
  type SimulationReconciliationIssue,
} from '../simulation-reconciliation'
import type { EvaluationEvent, EvaluationResult, InputManifest, Protocol, ReconciliationResult } from '../types'
import {
  completeEvidenceRecovery,
  evidenceRecoveryContract as evidenceContract,
  prepareEvidenceRecovery,
  validateStoredEvidence,
  type EvidenceRecoveryIssue,
  type PersistenceReceipt,
  type RecoveredEvaluationEvidence,
  type StoredEvidenceRows,
  type StoredEvaluationEvidence,
} from './evidence-recovery'
import { migrationLoader } from './migrations'
import { ensureSnapshotReference as ensureSnapshotReferenceRow } from './snapshot-reference'

export type { PersistenceReceipt, RecoveredEvaluationEvidence, StoredEvaluationEvidence } from './evidence-recovery'

export type DatabaseFailure = 'constraint' | 'decode' | 'invariant' | 'migration' | 'query' | 'unavailable'

export class DatabaseError extends Data.TaggedError('DatabaseError')<{
  readonly failure: DatabaseFailure
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

export interface PersistEvaluationInput {
  readonly provenance: RuntimeProvenance
  readonly parameters: Protocol
  readonly evaluation: EvaluationResult
  readonly reconciliation: ReconciliationResult
  readonly qualification?: {
    readonly lock: QualificationLock
    readonly result: QualificationResult
  }
}

export type QualificationRecord =
  | { readonly state: 'OPENED_INCOMPLETE'; readonly lock: QualificationLock }
  | { readonly state: 'TERMINAL'; readonly lock: QualificationLock; readonly result: QualificationResult }

export type QualificationOpen = { readonly state: 'ACQUIRED'; readonly lock: QualificationLock } | QualificationRecord

export interface OpenQualificationInput {
  readonly lock: QualificationLock
  readonly inputManifest: InputManifest
  readonly parameters: Protocol
  readonly provenance: RuntimeProvenance
}

export interface ArtifactItemPage {
  readonly runId: string
  readonly artifactName: string
  readonly schemaVersion: string
  readonly contentHash: string
  readonly itemCount: number
  readonly items: readonly { readonly ordinal: number; readonly payload: Schema.Json }[]
  readonly nextAfterOrdinal: number | null
}

export interface EvidenceStoreService {
  readonly check: Effect.Effect<void, DatabaseError>
  readonly persist: (input: PersistEvaluationInput) => Effect.Effect<PersistenceReceipt, DatabaseError>
  readonly read: (runId: string) => Effect.Effect<Option.Option<StoredEvaluationEvidence>, DatabaseError>
  readonly readArtifactItems: (input: {
    readonly runId: string
    readonly artifactName: string
    readonly afterOrdinal?: number
    readonly limit: number
  }) => Effect.Effect<Option.Option<ArtifactItemPage>, DatabaseError>
  readonly recover: (
    runId: string,
    provenance: RuntimeProvenance,
  ) => Effect.Effect<Option.Option<RecoveredEvaluationEvidence>, DatabaseError>
  readonly listPriorTrials: Effect.Effect<readonly string[], DatabaseError>
  readonly openQualification: (input: OpenQualificationInput) => Effect.Effect<QualificationOpen, DatabaseError>
  readonly readQualification: (
    candidateRunId: string,
  ) => Effect.Effect<Option.Option<QualificationRecord>, DatabaseError>
}

export class EvidenceStore extends Context.Service<EvidenceStore, EvidenceStoreService>()('bayn/EvidenceStore') {}

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const GitRevision = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))
const ImageDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const GateScalar = Schema.Union([Schema.Finite, Schema.Boolean, Schema.String])
const RunRequest = Schema.Struct({ runId: Sha256 })
const InsertedRun = Schema.Struct({ run_id: Sha256 })
const HealthRow = Schema.Struct({ value: Schema.Literal(1) })
const ProtocolRow = Schema.Struct({
  protocol_hash: Sha256,
  schema_version: Schema.String,
  strategy_name: Schema.String,
  behavior_hash: Sha256,
  parameter_hash: Sha256,
  parameters: ProtocolSchema,
})
const SnapshotRow = Schema.Struct({
  snapshot_id: Sha256,
  schema_version: Schema.Literal('bayn.finalized-snapshot.v3'),
  database_name: Schema.Literal('signal'),
  table_name: Schema.Literal('adjusted_daily_bars_v2'),
  dataset_version: Schema.Literal('signal.adjusted-daily-snapshot.v2'),
  source: Schema.Literal('alpaca'),
  source_feed: Schema.Literal('sip'),
  adjustment: Schema.Literal('all'),
  content_hash: Sha256,
  row_count: PositiveInteger,
  first_session: Schema.String,
  last_session: Schema.String,
  manifest: FinalizedSnapshotProvenanceSchema,
})
const ReceiptRow = Schema.Struct({
  run_id: Sha256,
  protocol_hash: Sha256,
  snapshot_id: Sha256,
  evaluation_schema_version: Schema.String,
  source_revision: GitRevision,
  image_repository: Schema.String,
  image_digest: ImageDigest,
  strategy_name: Schema.String,
  initial_capital_micros: Schema.String,
  status: Schema.Literal('COMPLETE'),
  expected_artifact_count: PositiveInteger,
  expected_event_count: NonNegativeInteger,
  expected_gate_count: PositiveInteger,
  artifact_count: NonNegativeInteger,
  event_count: NonNegativeInteger,
  gate_count: NonNegativeInteger,
})
const ArtifactReferenceRow = Schema.Struct({
  artifact_name: Schema.String,
  schema_version: Schema.String,
  content_hash: Sha256,
  payload: Schema.Json,
})
const ArtifactSeriesMetadataRow = Schema.Struct({
  schema_version: Schema.String,
  content_hash: Sha256,
  item_count: NonNegativeInteger,
})
const ArtifactItemRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  payload: Schema.Json,
})
const EventReferenceRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  event_id: Sha256,
  event_kind: Schema.Literals(['decision', 'fill', 'fee', 'cash-yield']),
  content_hash: Sha256,
  payload: EvaluationEventSchema,
})
const GateReferenceRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  gate_name: Schema.String,
  passed: Schema.Boolean,
  actual: GateScalar,
  required: GateScalar,
  content_hash: Sha256,
})
const StatusReferenceRow = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('WRITING'),
    detail: Schema.Struct({
      artifactCount: PositiveInteger,
      eventCount: NonNegativeInteger,
      gateCount: PositiveInteger,
    }),
  }),
  Schema.Struct({
    status: Schema.Literal('COMPLETE'),
    detail: Schema.Struct({
      reconciliationExact: Schema.Literal(true),
      verdict: Schema.Literals(['PASS', 'FAIL_CLOSED']),
    }),
  }),
])
const QualificationTrialRow = Schema.Struct({ run_id: Sha256 })
const QualificationRow = Schema.Struct({
  lock_payload: QualificationLockSchema,
  result_payload: Schema.NullOr(QualificationResultSchema),
})
const MigrationBoundaryRow = Schema.Struct({
  current_exists: Schema.Boolean,
  legacy_exists: Schema.Boolean,
})
const MigrationIdentityRow = Schema.Struct({ migration_id: PositiveInteger, name: Schema.String })
const CandidateRunCountRow = Schema.Struct({ count: NonNegativeInteger })
const InsertedLockRow = Schema.Struct({ lock_id: Sha256 })
const InsertedResultRow = Schema.Struct({ lock_id: Sha256 })
const StrictParseOptions = { onExcessProperty: 'error' } as const
const decodeQualificationLock = Schema.decodeUnknownSync(QualificationLockSchema, StrictParseOptions)
const decodeQualificationResult = Schema.decodeUnknownSync(QualificationResultSchema, StrictParseOptions)
const decodeMigrationBoundary = Schema.decodeUnknownEffect(Schema.Tuple([MigrationBoundaryRow]), StrictParseOptions)
const decodeMigrationIdentities = Schema.decodeUnknownEffect(Schema.Array(MigrationIdentityRow), StrictParseOptions)
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const unavailable = (): DatabaseFailure => 'unavailable'
const constraint = (): DatabaseFailure => 'constraint'
const query = (): DatabaseFailure => 'query'

const classifySqlReason: (reason: SqlErrorReason) => DatabaseFailure = Match.type<SqlErrorReason>().pipe(
  Match.tagsExhaustive({
    AuthenticationError: unavailable,
    AuthorizationError: unavailable,
    ConnectionError: unavailable,
    ConstraintError: constraint,
    DeadlockError: unavailable,
    LockTimeoutError: unavailable,
    SerializationError: unavailable,
    SqlSyntaxError: query,
    StatementTimeoutError: unavailable,
    UniqueViolation: constraint,
    UnknownError: unavailable,
  }),
)

const databaseError = (failure: DatabaseFailure, operation: string, message: string, cause?: unknown): DatabaseError =>
  new DatabaseError({
    failure,
    operation,
    message: cause === undefined ? message : `${message}: ${messageOf(cause)}`,
    cause,
  })

const classifyDatabaseError = (operation: string, cause: unknown): DatabaseError => {
  if (cause instanceof DatabaseError) return cause
  if (Schema.isSchemaError(cause)) return databaseError('decode', operation, 'database row decoding failed', cause)
  if (isSqlError(cause)) {
    return databaseError(classifySqlReason(cause.reason), operation, 'PostgreSQL operation failed', cause)
  }
  return databaseError('invariant', operation, 'unexpected database result', cause)
}

const runDatabase = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, DatabaseError, R> =>
  effect.pipe(Effect.mapError((cause) => classifyDatabaseError(operation, cause)))

const ensure = (condition: boolean, operation: string, message: string): Effect.Effect<void, DatabaseError> =>
  condition ? Effect.void : Effect.fail(databaseError('invariant', operation, message))

const makeArtifact = (name: string, schemaVersion: string, payload: unknown, itemCount = 0) => ({
  name,
  schemaVersion,
  contentHash: canonicalHashV1(payload),
  payload,
  itemCount,
})

type PersistencePlan = Omit<PersistEvaluationInput, 'qualification'> & {
  readonly qualification: PersistEvaluationInput['qualification']
  readonly strategyName: string
  readonly protocolHash: string
  readonly snapshotId: string
  readonly artifacts: readonly ReturnType<typeof makeArtifact>[]
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
  'qualification-evidence': 'qualification evidence is malformed or diverges from its candidate runtime',
  'qualification-result': 'qualification result diverges from the locked evaluation',
} as const

type PersistencePlanInvariant = keyof typeof persistencePlanInvariantMessages

type PersistencePlanFailure =
  | {
      readonly _tag: 'InvalidPersistencePlan'
      readonly invariant: PersistencePlanInvariant
      readonly cause?: unknown
    }
  | {
      readonly _tag: 'SimulationReconciliationFailed'
      readonly issues: readonly SimulationReconciliationIssue[]
    }
  | {
      readonly _tag: 'PersistencePlanComputationFailed'
      readonly operation: 'construct-persistence-evidence'
      readonly cause: unknown
    }

const invalidPersistencePlan = (
  invariant: PersistencePlanInvariant,
  cause?: unknown,
): Result.Result<never, PersistencePlanFailure> =>
  Result.fail({
    _tag: 'InvalidPersistencePlan',
    invariant,
    ...(cause === undefined ? {} : { cause }),
  })

const validateQualificationOpenInput = (input: OpenQualificationInput) => {
  const lock = decodeQualificationLock(input.lock)
  const { inputManifest, parameters, provenance } = input
  if (canonicalHashV1(parameters) !== provenance.strategy.parameterHash) {
    throw new TypeError('qualification parameters and provenance disagree')
  }
  const protocolHash = makeStrategyProtocolHash(provenance.strategy)
  const { hash: manifestHash, ...manifestMaterial } = inputManifest
  if (manifestHash !== canonicalHashV1(manifestMaterial)) {
    throw new TypeError('qualification input manifest hash does not match its content')
  }
  const expectedRunId = makeRunIdentity({
    schemaVersion: 'bayn.run-identity.v1',
    sourceRevision: provenance.sourceRevision,
    image: provenance.image,
    strategy: {
      name: provenance.strategy.name,
      behaviorHash: provenance.strategy.behaviorHash,
      parameters,
    },
    finalizedSnapshot: inputManifest.finalizedSnapshot,
    calendarVersion: inputManifest.finalizedSnapshot.calendarVersion,
    bounds: inputManifest.bounds,
  }).runId
  const snapshot = inputManifest.finalizedSnapshot
  const contractMatches =
    lock.schemaVersion === 'bayn.qualification-lock.v3' &&
    inputManifest.schemaVersion === 'bayn.input-manifest.v3' &&
    provenance.strategy.name === 'risk-balanced-trend' &&
    lock.universeId === inputManifest.finalizedSnapshot.universeId &&
    lock.universeSymbolHash === inputManifest.finalizedSnapshot.universeSymbolHash &&
    lock.data.inputManifestHash === inputManifest.hash
  const dataMatches =
    lock.data.snapshotId === snapshot.snapshotId &&
    lock.data.publicationId === snapshot.publicationId &&
    lock.data.contentHash === snapshot.contentHash &&
    lock.data.sessionsContentHash === snapshot.sessionsContentHash &&
    lock.data.provider === snapshot.source &&
    lock.data.sourceFeed === snapshot.sourceFeed &&
    lock.data.adjustment === snapshot.adjustment &&
    lock.data.calendarVersion === snapshot.calendarVersion &&
    lock.data.firstSession === snapshot.firstSession &&
    lock.data.lastSession === snapshot.lastSession &&
    canonicalHashV1(lock.data.bounds) === canonicalHashV1(inputManifest.bounds)
  if (
    lock.candidateRunId !== expectedRunId ||
    lock.protocolHash !== protocolHash ||
    lock.sourceRevision !== provenance.sourceRevision ||
    canonicalHashV1(lock.image) !== canonicalHashV1(provenance.image) ||
    !contractMatches ||
    canonicalHashV1(lock.universe) !== canonicalHashV1(snapshot.symbols) ||
    !dataMatches ||
    canonicalHashV1(lock.policies.execution.content) !== canonicalHashV1(parameters.executionModel)
  ) {
    throw new TypeError('qualification lock diverges from the candidate runtime or finalized snapshot')
  }
  return { ...input, lock }
}

interface ValidatedPersistenceEvaluation {
  readonly protocolHash: string
  readonly snapshotId: string
}

interface PersistenceEvidenceMaterial {
  readonly baseArtifacts: readonly ReturnType<typeof makeArtifact>[]
  readonly events: PersistencePlan['events']
  readonly gates: PersistencePlan['gates']
}

const validatePersistenceEvaluation = (
  input: PersistEvaluationInput,
): Result.Result<ValidatedPersistenceEvaluation, PersistencePlanFailure> => {
  const { evaluation, parameters, provenance, reconciliation } = input
  if (evaluation.schemaVersion !== provenance.contractVersions.evaluation) {
    return invalidPersistencePlan('evaluation-schema-version')
  }
  if (
    evaluation.inputManifest.schemaVersion !== evidenceContract.inputManifestSchemaVersion ||
    provenance.contractVersions.inputManifest !== evidenceContract.inputManifestSchemaVersion
  ) {
    return invalidPersistencePlan('input-manifest-schema-version')
  }
  const parameterHash = canonicalHashV1(parameters)
  if (parameterHash !== provenance.strategy.parameterHash) {
    return invalidPersistencePlan('parameter-hash')
  }
  if (canonicalHashV1(evaluation.simulation.executionModel) !== canonicalHashV1(parameters.executionModel)) {
    return invalidPersistencePlan('execution-model')
  }
  if (evaluation.simulation.costMultiplierMicros !== '1000000') {
    return invalidPersistencePlan('cost-multiplier')
  }
  const protocolHash = makeStrategyProtocolHash(provenance.strategy)
  if (protocolHash !== evaluation.protocolHash) return invalidPersistencePlan('protocol-hash')
  if (evaluation.codeRevision !== provenance.sourceRevision) {
    return invalidPersistencePlan('source-revision')
  }
  if (reconciliation.runId !== evaluation.runId || reconciliation.exact !== true) {
    return invalidPersistencePlan('accounting-reconciliation')
  }
  const { hash: inputManifestHash, ...manifestMaterial } = evaluation.inputManifest
  if (canonicalHashV1(manifestMaterial) !== inputManifestHash) {
    return invalidPersistencePlan('input-manifest-hash')
  }
  const snapshotId = evaluation.inputManifest.finalizedSnapshot.snapshotId
  const expectedRunId = makeRunIdentity({
    schemaVersion: 'bayn.run-identity.v1',
    sourceRevision: provenance.sourceRevision,
    image: provenance.image,
    strategy: {
      name: provenance.strategy.name,
      behaviorHash: provenance.strategy.behaviorHash,
      parameters,
    },
    finalizedSnapshot: evaluation.inputManifest.finalizedSnapshot,
    calendarVersion: evaluation.inputManifest.finalizedSnapshot.calendarVersion,
    bounds: evaluation.inputManifest.bounds,
  }).runId
  if (evaluation.runId !== expectedRunId) return invalidPersistencePlan('run-identity')

  const equityProofResult = reconcileMarkedEquity({
    runId: evaluation.runId,
    initialCapitalMicros: evaluation.initialCapitalMicros,
    evaluatorTotalFeesMicros: evaluation.strategy.totalFeesMicros,
    evaluatorEndingEquityMicros: evaluation.strategy.endingEquityMicros,
    events: evaluation.events,
    simulation: evaluation.simulation,
  })
  if (Result.isFailure(equityProofResult)) {
    return Result.fail({ _tag: 'SimulationReconciliationFailed', issues: equityProofResult.failure })
  }
  const equityProof = equityProofResult.success
  if (
    canonicalHashV1(equityProof.reconciliation) !== canonicalHashV1(evaluation.markedEquityReconciliation) ||
    canonicalHashV1(equityProof.equitySeries) !== canonicalHashV1(evaluation.equitySeries)
  ) {
    return invalidPersistencePlan('marked-equity-proof')
  }

  const decisionEvents = evaluation.events.filter((event) => event.kind === 'decision')
  if (
    evaluation.signalDecisions.length !== decisionEvents.length ||
    evaluation.signalDecisions.some(
      (decision, index) =>
        decision.decisionId !== decisionEvents[index]?.id ||
        decision.signalDate !== decisionEvents[index]?.signalDate ||
        decision.executionDate !== decisionEvents[index]?.executionDate ||
        canonicalHashV1(decision.targetWeights) !== canonicalHashV1(decisionEvents[index]?.targetWeights),
    )
  ) {
    return invalidPersistencePlan('signal-decisions')
  }
  const candidateDates = evaluation.simulation.dailyMarks.map((point) => point.sessionDate)
  const benchmarkSeries = Object.values(evaluation.benchmarkSeries)
  if (
    candidateDates.length !== evaluation.strategy.observations ||
    benchmarkSeries.some(
      (series) =>
        series.length !== candidateDates.length ||
        series.some((point, index) => point.sessionDate !== candidateDates[index]),
    )
  ) {
    return invalidPersistencePlan('daily-series')
  }

  return Result.succeed({ protocolHash, snapshotId })
}

const makePersistenceEvidence = (
  input: PersistEvaluationInput,
): Result.Result<PersistenceEvidenceMaterial, PersistencePlanFailure> => {
  const { evaluation, reconciliation } = input
  const baseArtifacts = [
    makeArtifact('evaluation-summary', evidenceContract.summarySchemaVersion, summarizeEvaluation(evaluation)),
    makeArtifact('input-manifest', evaluation.inputManifest.schemaVersion, evaluation.inputManifest),
    makeArtifact('strategy', 'bayn.performance-metrics.v2', evaluation.strategy),
    makeArtifact('buy-and-hold', 'bayn.performance-metrics.v2', evaluation.buyAndHold),
    makeArtifact('direct-volatility-timing', 'bayn.performance-metrics.v2', evaluation.directVolTiming),
    makeArtifact('double-cost-strategy', 'bayn.performance-metrics.v2', evaluation.doubleCostStrategy),
    makeArtifact(
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
    makeArtifact(
      'cash-changes',
      'bayn.cash-changes.v2',
      { schemaVersion: 'bayn.cash-changes.v2', items: evaluation.simulation.cashChanges },
      evaluation.simulation.cashChanges.length,
    ),
    makeArtifact(
      'daily-position-marks',
      'bayn.daily-position-marks.v3',
      { schemaVersion: 'bayn.daily-position-marks.v3', items: evaluation.simulation.dailyMarks },
      evaluation.simulation.dailyMarks.length,
    ),
    makeArtifact(
      evidenceContract.signalDecisionsArtifactName,
      evidenceContract.signalDecisionsSchemaVersion,
      { schemaVersion: evidenceContract.signalDecisionsSchemaVersion, items: evaluation.signalDecisions },
      evaluation.signalDecisions.length,
    ),
    makeArtifact(
      'buy-and-hold-series',
      'bayn.daily-performance-series.v1',
      {
        schemaVersion: 'bayn.daily-performance-series.v1',
        series: 'buy-and-hold',
        items: evaluation.benchmarkSeries.buyAndHold,
      },
      evaluation.benchmarkSeries.buyAndHold.length,
    ),
    makeArtifact(
      'direct-volatility-timing-series',
      'bayn.daily-performance-series.v1',
      {
        schemaVersion: 'bayn.daily-performance-series.v1',
        series: 'direct-volatility-timing',
        items: evaluation.benchmarkSeries.directVolTiming,
      },
      evaluation.benchmarkSeries.directVolTiming.length,
    ),
    makeArtifact(
      'double-cost-strategy-series',
      'bayn.daily-performance-series.v1',
      {
        schemaVersion: 'bayn.daily-performance-series.v1',
        series: 'double-cost-strategy',
        items: evaluation.benchmarkSeries.doubleCostStrategy,
      },
      evaluation.benchmarkSeries.doubleCostStrategy.length,
    ),
    makeArtifact(
      'equity-series',
      'bayn.equity-series.v1',
      makeEquitySeriesArtifact(evaluation.equitySeries),
      evaluation.equitySeries.length,
    ),
    makeArtifact(
      'marked-equity-reconciliation',
      evaluation.markedEquityReconciliation.schemaVersion,
      evaluation.markedEquityReconciliation,
    ),
    makeArtifact('reconciliation', 'bayn.reconciliation.v1', reconciliation),
  ]
  const events = evaluation.events.map((event, ordinal) => ({
    ordinal,
    id: event.id,
    kind: event.kind,
    contentHash: canonicalHashV1(event),
    payload: event,
  }))
  const gates = evaluation.verdict.gates.map((gate, ordinal) => ({
    ordinal,
    name: gate.name,
    passed: gate.passed,
    actual: gate.actual,
    required: gate.required,
    contentHash: canonicalHashV1(gate),
  }))
  if (events.length === 0) return invalidPersistencePlan('events-empty')
  if (gates.length === 0) return invalidPersistencePlan('gates-empty')
  return Result.succeed({ baseArtifacts, events, gates })
}

const validatePersistenceQualification = (
  input: PersistEvaluationInput,
): Result.Result<PersistEvaluationInput['qualification'], PersistencePlanFailure> => {
  const suppliedQualification = input.qualification
  if (suppliedQualification === undefined) return Result.succeed(undefined)
  const { evaluation, parameters, provenance } = input
  const decodedQualification = Result.try({
    try: () => ({
      lock: validateQualificationOpenInput({
        lock: suppliedQualification.lock,
        inputManifest: evaluation.inputManifest,
        parameters,
        provenance,
      }).lock,
      result: decodeQualificationResult(suppliedQualification.result),
    }),
    catch: (cause): PersistencePlanFailure => ({
      _tag: 'InvalidPersistencePlan',
      invariant: 'qualification-evidence',
      cause,
    }),
  })
  if (Result.isFailure(decodedQualification)) return Result.fail(decodedQualification.failure)
  const { lock, result } = decodedQualification.success
  if (
    lock.candidateRunId !== evaluation.runId ||
    lock.data.selectedSessionCount !== evaluation.strategy.observations ||
    lock.data.selectedSessionCount !== evaluation.simulation.dailyMarks.length ||
    lock.data.selectedRebalanceCount !== evaluation.signalDecisions.length ||
    result.lockId !== lock.lockId ||
    result.runId !== evaluation.runId ||
    canonicalHashV1(result.evaluationVerdict) !== canonicalHashV1(evaluation.verdict) ||
    canonicalHashV1(result.analysis.priorTrialRunIds) !== canonicalHashV1(lock.priorTrialRunIds)
  ) {
    return invalidPersistencePlan('qualification-result')
  }
  return Result.succeed({ lock, result })
}

const makePersistenceArtifactManifest = (
  input: PersistEvaluationInput,
  validated: ValidatedPersistenceEvaluation,
  evidence: PersistenceEvidenceMaterial,
) => {
  const { evaluation, provenance } = input
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
    events: {
      count: evidence.events.length,
      contentHash: canonicalHashV1(
        evidence.events.map(({ ordinal, id, kind, contentHash }) => ({ ordinal, id, kind, contentHash })),
      ),
    },
    gates: {
      count: evidence.gates.length,
      contentHash: canonicalHashV1(
        evidence.gates.map(({ ordinal, name, passed, contentHash }) => ({ ordinal, name, passed, contentHash })),
      ),
    },
  }
}

const buildPersistencePlan = (
  input: PersistEvaluationInput,
): Result.Result<PersistencePlan, PersistencePlanFailure> => {
  const validated = validatePersistenceEvaluation(input)
  if (Result.isFailure(validated)) return Result.fail(validated.failure)
  const evidence = makePersistenceEvidence(input)
  if (Result.isFailure(evidence)) return Result.fail(evidence.failure)
  const qualification = validatePersistenceQualification(input)
  if (Result.isFailure(qualification)) return Result.fail(qualification.failure)
  const artifactManifest = makePersistenceArtifactManifest(input, validated.success, evidence.success)
  const artifacts = [
    ...evidence.success.baseArtifacts,
    makeArtifact('qualification-artifact-manifest', artifactManifest.schemaVersion, artifactManifest),
  ]

  return Result.succeed({
    ...input,
    qualification: qualification.success,
    strategyName: input.provenance.strategy.name,
    protocolHash: validated.success.protocolHash,
    snapshotId: validated.success.snapshotId,
    artifacts,
    events: evidence.success.events,
    gates: evidence.success.gates,
  })
}

const makePersistencePlan = (input: PersistEvaluationInput): Result.Result<PersistencePlan, PersistencePlanFailure> => {
  const attempted = Result.try({
    try: () => buildPersistencePlan(input),
    catch: (cause): PersistencePlanFailure => ({
      _tag: 'PersistencePlanComputationFailed',
      operation: 'construct-persistence-evidence',
      cause,
    }),
  })
  return Result.isFailure(attempted) ? Result.fail(attempted.failure) : attempted.success
}

const reconciliationDatabaseError = (
  operation: string,
  issues: readonly SimulationReconciliationIssue[],
): DatabaseError =>
  databaseError(
    'invariant',
    operation,
    `marked-equity reconciliation failed: ${renderSimulationReconciliationIssues(issues)}`,
    issues,
  )

const persistencePlanDatabaseError = (operation: string, failure: PersistencePlanFailure): DatabaseError => {
  switch (failure._tag) {
    case 'InvalidPersistencePlan':
      return databaseError(
        'invariant',
        operation,
        persistencePlanInvariantMessages[failure.invariant],
        failure.cause ?? failure,
      )
    case 'SimulationReconciliationFailed':
      return reconciliationDatabaseError(operation, failure.issues)
    case 'PersistencePlanComputationFailed':
      return databaseError(
        'invariant',
        operation,
        `persistence plan computation failed during ${failure.operation}`,
        failure.cause,
      )
  }
}

const recoveryIssueDatabaseError = (operation: string, issue: EvidenceRecoveryIssue): DatabaseError => {
  switch (issue._tag) {
    case 'RecoveryMismatch':
      return databaseError(
        'invariant',
        operation,
        `evidence recovery ${issue.stage} mismatch at ${issue.path.join('.')}`,
        issue,
      )
    case 'ArtifactSetFailure':
      return databaseError(
        'invariant',
        operation,
        `stored artifact set failed with ${issue.problem._tag} for ${issue.problem.name}`,
        issue,
      )
    case 'DecodeFailure':
      return databaseError('decode', operation, `stored artifact ${issue.artifactName} failed decoding`, issue)
    case 'CanonicalizationFailure':
      return databaseError('invariant', operation, `evidence canonicalization failed during ${issue.operation}`, issue)
    case 'SimulationFailure':
      return reconciliationDatabaseError(operation, issue.issues)
    case 'ComputationFailure':
      return databaseError('invariant', operation, `evidence computation failed during ${issue.operation}`, issue)
  }
}

const liftRecoveryResult = <A>(
  operation: string,
  result: Result.Result<A, EvidenceRecoveryIssue>,
): Effect.Effect<A, DatabaseError> =>
  Effect.fromResult(result).pipe(Effect.mapError((issue) => recoveryIssueDatabaseError(operation, issue)))

const makeEvidenceStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const jsonScalar = (value: number | boolean | string) => sql.json(encodeJson(value))

  const health = SqlSchema.findOne({
    Request: Schema.Void,
    Result: HealthRow,
    execute: () => sql`SELECT 1::integer AS value`,
  })
  const getProtocol = SqlSchema.findOne({
    Request: Schema.Struct({ protocolHash: Sha256 }),
    Result: ProtocolRow,
    execute: ({ protocolHash }) => sql`SELECT * FROM protocol_locks WHERE protocol_hash = ${protocolHash}`,
  })
  const getSnapshot = SqlSchema.findOne({
    Request: Schema.Struct({ snapshotId: Sha256 }),
    Result: SnapshotRow,
    execute: ({ snapshotId }) => sql`
      SELECT
        snapshot_id,
        schema_version,
        database_name,
        table_name,
        dataset_version,
        source,
        source_feed,
        adjustment,
        content_hash,
        row_count::integer AS row_count,
        first_session::text,
        last_session::text,
        manifest
      FROM snapshot_references
      WHERE snapshot_id = ${snapshotId}
    `,
  })
  const insertRun = SqlSchema.findAll({
    Request: Schema.Struct({
      runId: Sha256,
      protocolHash: Sha256,
      snapshotId: Sha256,
      evaluationSchemaVersion: Schema.String,
      sourceRevision: Schema.String,
      imageRepository: Schema.String,
      imageDigest: Schema.String,
      strategyName: Schema.String,
      initialCapitalMicros: Schema.String,
      artifactCount: PositiveInteger,
      eventCount: NonNegativeInteger,
      gateCount: PositiveInteger,
    }),
    Result: InsertedRun,
    execute: (request) => sql`
      INSERT INTO evaluation_runs (
        run_id,
        protocol_hash,
        snapshot_id,
        evaluation_schema_version,
        source_revision,
        image_repository,
        image_digest,
        strategy_name,
        initial_capital_micros,
        expected_artifact_count,
        expected_event_count,
        expected_gate_count,
        status
      ) VALUES (
        ${request.runId},
        ${request.protocolHash},
        ${request.snapshotId},
        ${request.evaluationSchemaVersion},
        ${request.sourceRevision},
        ${request.imageRepository},
        ${request.imageDigest},
        ${request.strategyName},
        ${request.initialCapitalMicros},
        ${request.artifactCount},
        ${request.eventCount},
        ${request.gateCount},
        'WRITING'
      )
      ON CONFLICT (run_id) DO NOTHING
      RETURNING run_id
    `,
  })
  const completeRun = SqlSchema.findAll({
    Request: RunRequest,
    Result: InsertedRun,
    execute: ({ runId }) => sql`
      UPDATE evaluation_runs AS run
      SET status = 'COMPLETE', completed_at = transaction_timestamp()
      WHERE run.run_id = ${runId}
        AND run.status = 'WRITING'
        AND run.expected_artifact_count = (
          SELECT count(*)::integer FROM evaluation_artifacts WHERE run_id = ${runId}
        )
        AND run.expected_event_count = (
          SELECT count(*)::integer FROM evaluation_events WHERE run_id = ${runId}
        )
        AND run.expected_gate_count = (
          SELECT count(*)::integer FROM gate_outcomes WHERE run_id = ${runId}
        )
      RETURNING run.run_id
    `,
  })
  const getReceipt = SqlSchema.findAll({
    Request: RunRequest,
    Result: ReceiptRow,
    execute: ({ runId }) => sql`
      SELECT
        run.run_id,
        run.protocol_hash,
        run.snapshot_id,
        run.evaluation_schema_version,
        run.source_revision,
        run.image_repository,
        run.image_digest,
        run.strategy_name,
        run.initial_capital_micros::text AS initial_capital_micros,
        run.status,
        run.expected_artifact_count,
        run.expected_event_count,
        run.expected_gate_count,
        (SELECT count(*)::integer FROM evaluation_artifacts WHERE run_id = run.run_id) AS artifact_count,
        (SELECT count(*)::integer FROM evaluation_events WHERE run_id = run.run_id) AS event_count,
        (SELECT count(*)::integer FROM gate_outcomes WHERE run_id = run.run_id) AS gate_count
      FROM evaluation_runs AS run
      WHERE run.run_id = ${runId}
    `,
  })
  const getArtifactReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: ArtifactReferenceRow,
    execute: ({ runId }) => sql`
      SELECT artifact_name, schema_version, content_hash, payload
      FROM evaluation_artifacts
      WHERE run_id = ${runId}
      ORDER BY artifact_name
    `,
  })
  const getArtifactSeriesMetadata = SqlSchema.findAll({
    Request: Schema.Struct({ runId: Sha256, artifactName: Schema.String }),
    Result: ArtifactSeriesMetadataRow,
    execute: ({ runId, artifactName }) => sql`
      SELECT
        artifact.schema_version,
        artifact.content_hash,
        jsonb_array_length(artifact.payload -> 'items')::integer AS item_count
      FROM evaluation_artifacts AS artifact
      JOIN evaluation_runs AS run USING (run_id)
      WHERE artifact.run_id = ${runId}
        AND artifact.artifact_name = ${artifactName}
        AND run.status = 'COMPLETE'
        AND jsonb_typeof(artifact.payload -> 'items') = 'array'
    `,
  })
  const getArtifactItems = SqlSchema.findAll({
    Request: Schema.Struct({
      runId: Sha256,
      artifactName: Schema.String,
      afterOrdinal: Schema.Int,
      limit: PositiveInteger,
    }),
    Result: ArtifactItemRow,
    execute: ({ runId, artifactName, afterOrdinal, limit }) => sql`
      SELECT (item.ordinality - 1)::integer AS ordinal, item.payload
      FROM evaluation_artifacts AS artifact
      CROSS JOIN LATERAL jsonb_array_elements(artifact.payload -> 'items')
        WITH ORDINALITY AS item(payload, ordinality)
      WHERE artifact.run_id = ${runId}
        AND artifact.artifact_name = ${artifactName}
        AND (item.ordinality - 1) > ${afterOrdinal}
      ORDER BY item.ordinality
      LIMIT ${limit}
    `,
  })
  const getEventReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: EventReferenceRow,
    execute: ({ runId }) => sql`
      SELECT ordinal, event_id, event_kind, content_hash, payload
      FROM evaluation_events
      WHERE run_id = ${runId}
      ORDER BY ordinal
    `,
  })
  const getGateReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: GateReferenceRow,
    execute: ({ runId }) => sql`
      SELECT ordinal, gate_name, passed, actual, required, content_hash
      FROM gate_outcomes
      WHERE run_id = ${runId}
      ORDER BY ordinal
    `,
  })
  const getStatusReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: StatusReferenceRow,
    execute: ({ runId }) => sql`
      SELECT status, detail FROM status_history WHERE run_id = ${runId} ORDER BY sequence
    `,
  })
  const getPriorTrials = SqlSchema.findAll({
    Request: Schema.Void,
    Result: QualificationTrialRow,
    execute: () => sql`
      SELECT run_id
      FROM (
        SELECT run_id FROM qualification_trials
        UNION
        SELECT run_id FROM qualification_results
      ) AS trials
      ORDER BY run_id
    `,
  })
  const getQualificationByCandidate = SqlSchema.findAll({
    Request: Schema.Struct({ candidateRunId: Sha256 }),
    Result: QualificationRow,
    execute: ({ candidateRunId }) => sql`
      SELECT lock.payload AS lock_payload, result.payload AS result_payload
      FROM qualification_locks AS lock
      LEFT JOIN qualification_results AS result USING (lock_id)
      WHERE lock.candidate_run_id = ${candidateRunId}
    `,
  })
  const getQualificationByIdentity = SqlSchema.findAll({
    Request: Schema.Struct({ candidateRunId: Sha256, snapshotId: Sha256 }),
    Result: QualificationRow,
    execute: ({ candidateRunId, snapshotId }) => sql`
      SELECT lock.payload AS lock_payload, result.payload AS result_payload
      FROM qualification_locks AS lock
      LEFT JOIN qualification_results AS result USING (lock_id)
      WHERE lock.candidate_run_id = ${candidateRunId} OR lock.snapshot_id = ${snapshotId}
      ORDER BY lock.lock_id
    `,
  })
  const insertQualificationLock = SqlSchema.findAll({
    Request: Schema.Struct({
      lockId: Sha256,
      schemaVersion: Schema.Literal('bayn.qualification-lock.v3'),
      candidateRunId: Sha256,
      protocolHash: Sha256,
      snapshotId: Sha256,
      sourceRevision: GitRevision,
      imageRepository: Schema.String,
      imageDigest: ImageDigest,
      payload: QualificationLockSchema,
    }),
    Result: InsertedLockRow,
    execute: (request) => sql`
      INSERT INTO qualification_locks (
        lock_id,
        schema_version,
        candidate_run_id,
        protocol_hash,
        snapshot_id,
        source_revision,
        image_repository,
        image_digest,
        payload
      ) VALUES (
        ${request.lockId},
        ${request.schemaVersion},
        ${request.candidateRunId},
        ${request.protocolHash},
        ${request.snapshotId},
        ${request.sourceRevision},
        ${request.imageRepository},
        ${request.imageDigest},
        ${sql.json(request.payload)}
      )
      ON CONFLICT DO NOTHING
      RETURNING lock_id
    `,
  })
  const insertQualificationResult = SqlSchema.findAll({
    Request: Schema.Struct({
      lockId: Sha256,
      schemaVersion: Schema.Literal('bayn.qualification-result.v2'),
      runId: Sha256,
      verdict: Schema.Literals(['QUALIFIED', 'REJECTED']),
      analysisHash: Sha256,
      resultHash: Sha256,
      payload: QualificationResultSchema,
    }),
    Result: InsertedResultRow,
    execute: (request) => sql`
      INSERT INTO qualification_results (
        lock_id,
        schema_version,
        run_id,
        verdict,
        analysis_hash,
        result_hash,
        payload
      ) VALUES (
        ${request.lockId},
        ${request.schemaVersion},
        ${request.runId},
        ${request.verdict},
        ${request.analysisHash},
        ${request.resultHash},
        ${sql.json(request.payload)}
      )
      ON CONFLICT DO NOTHING
      RETURNING lock_id
    `,
  })
  const getCandidateRunCount = SqlSchema.findOne({
    Request: Schema.Struct({ candidateRunId: Sha256 }),
    Result: CandidateRunCountRow,
    execute: ({ candidateRunId }) => sql`
      SELECT count(*)::integer AS count FROM evaluation_runs WHERE run_id = ${candidateRunId}
    `,
  })
  const getIncompleteQualificationCount = SqlSchema.findOne({
    Request: Schema.Void,
    Result: CandidateRunCountRow,
    execute: () => sql`
      SELECT count(*)::integer AS count
      FROM qualification_locks AS lock
      LEFT JOIN qualification_results AS result USING (lock_id)
      WHERE result.lock_id IS NULL
    `,
  })

  const decodeQualificationRecord = (row: typeof QualificationRow.Type): QualificationRecord => {
    const lock = row.lock_payload
    if (row.result_payload === null) return { state: 'OPENED_INCOMPLETE', lock }
    const result = row.result_payload
    if (result.lockId !== lock.lockId || result.runId !== lock.candidateRunId) {
      throw new TypeError('stored qualification result diverges from its lock')
    }
    return { state: 'TERMINAL', lock, result }
  }

  const decodeSingleQualification = (
    rows: readonly (typeof QualificationRow.Type)[],
    operation: string,
  ): Effect.Effect<Option.Option<QualificationRecord>, DatabaseError> =>
    Effect.gen(function* () {
      if (rows.length === 0) return Option.none<QualificationRecord>()
      yield* ensure(rows.length === 1, operation, 'qualification identity is duplicated or divergent')
      return yield* Effect.try({
        try: () => Option.some(decodeQualificationRecord(rows[0])),
        catch: (cause) => databaseError('invariant', operation, 'stored qualification evidence is invalid', cause),
      })
    })

  const ensureProtocolReference = (input: {
    readonly protocolHash: string
    readonly provenance: RuntimeProvenance
    readonly parameters: Protocol
  }) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO protocol_locks (
          protocol_hash,
          schema_version,
          strategy_name,
          behavior_hash,
          parameter_hash,
          parameters
        ) VALUES (
          ${input.protocolHash},
          ${input.provenance.strategy.parameterSchemaVersion},
          ${input.provenance.strategy.name},
          ${input.provenance.strategy.behaviorHash},
          ${input.provenance.strategy.parameterHash},
          ${sql.json(input.parameters)}
        )
        ON CONFLICT (protocol_hash) DO NOTHING
      `
      const protocol = yield* getProtocol({ protocolHash: input.protocolHash })
      yield* ensure(
        protocol.schema_version === input.provenance.strategy.parameterSchemaVersion &&
          protocol.strategy_name === input.provenance.strategy.name &&
          protocol.behavior_hash === input.provenance.strategy.behaviorHash &&
          protocol.parameter_hash === input.provenance.strategy.parameterHash &&
          canonicalHashV1(protocol.parameters) === input.provenance.strategy.parameterHash &&
          makeStrategyProtocolHash({
            name: protocol.strategy_name,
            behaviorHash: protocol.behavior_hash,
            parameterHash: protocol.parameter_hash,
            parameterSchemaVersion: protocol.schema_version,
          }) === input.protocolHash,
        'protocol-lock',
        'stored protocol lock diverged from the evaluated protocol',
      )
    })

  const ensureSnapshotReference = (inputManifest: InputManifest) =>
    Effect.gen(function* () {
      const matches = yield* ensureSnapshotReferenceRow(sql, inputManifest)
      yield* ensure(
        matches,
        'snapshot-reference',
        'stored snapshot reference diverged from the evaluated input manifest',
      )
    })

  const readReceipt = (plan: PersistencePlan, deduplicated: boolean) =>
    Effect.gen(function* () {
      const rows = yield* getReceipt({ runId: plan.evaluation.runId })
      yield* ensure(rows.length === 1, 'read-receipt', 'stored run receipt is missing or duplicated')
      const row = rows[0]
      yield* ensure(row.protocol_hash === plan.protocolHash, 'read-receipt', 'stored protocol reference diverged')
      yield* ensure(row.snapshot_id === plan.snapshotId, 'read-receipt', 'stored snapshot reference diverged')
      yield* ensure(
        row.evaluation_schema_version === plan.evaluation.schemaVersion &&
          row.source_revision === plan.provenance.sourceRevision &&
          row.image_repository === plan.provenance.image.repository &&
          row.image_digest === plan.provenance.image.digest &&
          row.strategy_name === plan.strategyName &&
          row.initial_capital_micros === plan.evaluation.initialCapitalMicros,
        'read-receipt',
        'stored run identity diverged from the evaluated runtime',
      )
      yield* ensure(
        row.expected_artifact_count === plan.artifacts.length && row.artifact_count === plan.artifacts.length,
        'read-receipt',
        'stored artifact count is incomplete',
      )
      yield* ensure(
        row.expected_event_count === plan.events.length && row.event_count === plan.events.length,
        'read-receipt',
        'stored event count is incomplete',
      )
      yield* ensure(
        row.expected_gate_count === plan.gates.length && row.gate_count === plan.gates.length,
        'read-receipt',
        'stored gate count is incomplete',
      )
      const artifacts = yield* getArtifactReferences({ runId: plan.evaluation.runId })
      const events = yield* getEventReferences({ runId: plan.evaluation.runId })
      const gates = yield* getGateReferences({ runId: plan.evaluation.runId })
      const statuses = yield* getStatusReferences({ runId: plan.evaluation.runId })
      const expectedArtifacts = [...plan.artifacts].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      )
      yield* ensure(
        artifacts.every((artifact, index) => {
          const expected = expectedArtifacts[index]
          return (
            expected !== undefined &&
            artifact.artifact_name === expected.name &&
            artifact.schema_version === expected.schemaVersion &&
            artifact.content_hash === expected.contentHash &&
            canonicalHashV1(artifact.payload) === expected.contentHash
          )
        }),
        'read-receipt',
        'stored artifact content diverged',
      )
      yield* ensure(
        events.every((event, index) => {
          const expected = plan.events[index]
          return (
            expected !== undefined &&
            event.ordinal === expected.ordinal &&
            event.event_id === expected.id &&
            event.event_kind === expected.kind &&
            event.content_hash === expected.contentHash &&
            canonicalHashV1(event.payload) === expected.contentHash
          )
        }),
        'read-receipt',
        'stored event content diverged',
      )
      yield* ensure(
        gates.every((gate, index) => {
          const expected = plan.gates[index]
          return (
            expected !== undefined &&
            gate.ordinal === expected.ordinal &&
            gate.gate_name === expected.name &&
            gate.passed === expected.passed &&
            gate.content_hash === expected.contentHash &&
            canonicalHashV1({
              name: gate.gate_name,
              passed: gate.passed,
              actual: gate.actual,
              required: gate.required,
            }) === expected.contentHash
          )
        }),
        'read-receipt',
        'stored gate content diverged',
      )
      yield* ensure(
        statuses.length === 2 &&
          statuses[0].status === 'WRITING' &&
          canonicalHashV1(statuses[0].detail) ===
            canonicalHashV1({
              artifactCount: plan.artifacts.length,
              eventCount: plan.events.length,
              gateCount: plan.gates.length,
            }) &&
          statuses[1].status === 'COMPLETE' &&
          canonicalHashV1(statuses[1].detail) ===
            canonicalHashV1({ reconciliationExact: true, verdict: plan.evaluation.verdict.status }),
        'read-receipt',
        'stored status history diverged',
      )
      return {
        runId: row.run_id,
        deduplicated,
        artifactCount: row.artifact_count,
        eventCount: row.event_count,
        gateCount: row.gate_count,
      }
    })

  const loadStoredRows = (runId: string) =>
    Effect.gen(function* () {
      const receipts = yield* getReceipt({ runId })
      if (receipts.length === 0) return Option.none<StoredEvidenceRows>()
      const receipt = receipts[0]
      if (receipt === undefined) return Option.none<StoredEvidenceRows>()
      const protocol = yield* getProtocol({ protocolHash: receipt.protocol_hash })
      const artifacts = yield* getArtifactReferences({ runId })
      const events = yield* getEventReferences({ runId })
      const gates = yield* getGateReferences({ runId })
      const statuses = yield* getStatusReferences({ runId })
      return Option.some({ receipts, protocol, artifacts, events, gates, statuses } satisfies StoredEvidenceRows)
    })

  const readStored = (operation: string, runId: string) =>
    Effect.gen(function* () {
      const rows = yield* loadStoredRows(runId)
      if (Option.isNone(rows)) return Option.none<StoredEvaluationEvidence>()
      const stored = yield* liftRecoveryResult(operation, validateStoredEvidence(runId, rows.value))
      return Option.some(stored)
    })

  const read = (runId: string) => runDatabase('read-evidence', readStored('read-evidence', runId))

  const listPriorTrials = runDatabase(
    'list-prior-trials',
    getPriorTrials(undefined).pipe(Effect.map((rows) => rows.map((row) => row.run_id))),
  )

  const readQualification: EvidenceStoreService['readQualification'] = (candidateRunId) =>
    runDatabase(
      'read-qualification',
      Effect.gen(function* () {
        const rows = yield* getQualificationByCandidate({ candidateRunId })
        return yield* decodeSingleQualification(rows, 'read-qualification')
      }),
    )

  const openQualification: EvidenceStoreService['openQualification'] = (input) =>
    runDatabase(
      'open-qualification',
      Effect.gen(function* () {
        const plan = yield* Effect.try({
          try: () => validateQualificationOpenInput(input),
          catch: (cause) => databaseError('invariant', 'open-qualification', 'invalid qualification lock input', cause),
        })
        const lock = plan.lock
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* ensureProtocolReference({
              protocolHash: lock.protocolHash,
              provenance: plan.provenance,
              parameters: plan.parameters,
            })
            yield* ensureSnapshotReference(plan.inputManifest)
            yield* sql`LOCK TABLE qualification_trials IN SHARE MODE`
            yield* sql`LOCK TABLE qualification_locks IN SHARE ROW EXCLUSIVE MODE`

            const existingRows = yield* getQualificationByIdentity({
              candidateRunId: lock.candidateRunId,
              snapshotId: lock.data.snapshotId,
            })
            const existing = yield* decodeSingleQualification(existingRows, 'open-qualification')
            if (Option.isSome(existing)) {
              yield* ensure(
                existing.value.lock.lockId === lock.lockId &&
                  canonicalHashV1(existing.value.lock) === canonicalHashV1(lock),
                'open-qualification',
                'candidate or snapshot is already bound to a different qualification lock',
              )
              return existing.value
            }

            const incompleteCount = yield* getIncompleteQualificationCount(undefined)
            yield* ensure(
              incompleteCount.count === 0,
              'open-qualification',
              'another qualification lock is opened without a terminal result',
            )

            const priorTrialRunIds = (yield* getPriorTrials(undefined)).map((row) => row.run_id)
            yield* ensure(
              canonicalHashV1(priorTrialRunIds) === canonicalHashV1(lock.priorTrialRunIds),
              'open-qualification',
              'qualification prior-trial lineage changed before lock acquisition',
            )
            const candidateRunCount = yield* getCandidateRunCount({ candidateRunId: lock.candidateRunId })
            yield* ensure(
              candidateRunCount.count === 0,
              'open-qualification',
              'candidate evaluation was observed before qualification lock acquisition',
            )

            const inserted = yield* insertQualificationLock({
              lockId: lock.lockId,
              schemaVersion: lock.schemaVersion,
              candidateRunId: lock.candidateRunId,
              protocolHash: lock.protocolHash,
              snapshotId: lock.data.snapshotId,
              sourceRevision: lock.sourceRevision,
              imageRepository: lock.image.repository,
              imageDigest: lock.image.digest,
              payload: lock,
            })
            if (inserted.length === 1) return { state: 'ACQUIRED', lock } as const
            yield* ensure(inserted.length === 0, 'open-qualification', 'qualification lock insert was duplicated')

            const rows = yield* getQualificationByIdentity({
              candidateRunId: lock.candidateRunId,
              snapshotId: lock.data.snapshotId,
            })
            const stored = yield* decodeSingleQualification(rows, 'open-qualification')
            if (Option.isNone(stored)) {
              return yield* Effect.fail(
                databaseError('invariant', 'open-qualification', 'conflicting qualification lock is missing'),
              )
            }
            yield* ensure(
              stored.value.lock.lockId === lock.lockId && canonicalHashV1(stored.value.lock) === canonicalHashV1(lock),
              'open-qualification',
              'qualification lock conflict diverges from the requested identity',
            )
            return stored.value
          }),
        )
      }),
    )

  const readArtifactItems: EvidenceStoreService['readArtifactItems'] = ({
    runId,
    artifactName,
    afterOrdinal = -1,
    limit,
  }) =>
    runDatabase(
      'read-artifact-items',
      Effect.gen(function* () {
        yield* ensure(/^[0-9a-f]{64}$/.test(runId), 'read-artifact-items', 'run ID is invalid')
        yield* ensure(
          artifactName.length > 0 && artifactName.trim() === artifactName,
          'read-artifact-items',
          'artifact name is invalid',
        )
        yield* ensure(
          Number.isInteger(afterOrdinal) && afterOrdinal >= -1,
          'read-artifact-items',
          'after ordinal must be an integer greater than or equal to -1',
        )
        yield* ensure(
          Number.isInteger(limit) && limit > 0 && limit <= 256,
          'read-artifact-items',
          'page limit must be between 1 and 256',
        )
        const metadata = yield* getArtifactSeriesMetadata({ runId, artifactName })
        if (metadata.length === 0) return Option.none<ArtifactItemPage>()
        yield* ensure(metadata.length === 1, 'read-artifact-items', 'artifact series metadata is duplicated')
        const rows = yield* getArtifactItems({ runId, artifactName, afterOrdinal, limit })
        yield* ensure(
          rows.every((row, index) => row.ordinal === afterOrdinal + index + 1),
          'read-artifact-items',
          'artifact page is not contiguous',
        )
        const last = rows.at(-1)?.ordinal
        return Option.some({
          runId,
          artifactName,
          schemaVersion: metadata[0].schema_version,
          contentHash: metadata[0].content_hash,
          itemCount: metadata[0].item_count,
          items: rows,
          nextAfterOrdinal: last !== undefined && last < metadata[0].item_count - 1 ? last : null,
        } satisfies ArtifactItemPage)
      }),
    )

  const recover = (runId: string, provenance: RuntimeProvenance) =>
    runDatabase(
      'recover-evidence',
      Effect.gen(function* () {
        const rows = yield* loadStoredRows(runId)
        if (Option.isNone(rows)) return Option.none<RecoveredEvaluationEvidence>()
        const prepared = yield* liftRecoveryResult(
          'recover-evidence',
          prepareEvidenceRecovery({ runId, provenance, rows: rows.value }),
        )
        const snapshot = yield* getSnapshot({ snapshotId: prepared.stored.run.snapshotId })
        const recovered = yield* liftRecoveryResult('recover-evidence', completeEvidenceRecovery(prepared, snapshot))
        return Option.some(recovered)
      }),
    )

  const persist = (input: PersistEvaluationInput) =>
    runDatabase(
      'persist',
      Effect.gen(function* () {
        const plan = yield* Effect.fromResult(makePersistencePlan(input)).pipe(
          Effect.mapError((failure) => persistencePlanDatabaseError('plan', failure)),
        )

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const qualificationRows = yield* getQualificationByCandidate({
              candidateRunId: plan.evaluation.runId,
            })
            const storedQualification = yield* decodeSingleQualification(qualificationRows, 'persist-qualification')
            if (plan.qualification !== undefined) {
              if (Option.isNone(storedQualification)) {
                return yield* Effect.fail(
                  databaseError('invariant', 'persist-qualification', 'qualification lock was not opened'),
                )
              }
              yield* ensure(
                storedQualification.value.state === 'OPENED_INCOMPLETE' &&
                  storedQualification.value.lock.lockId === plan.qualification.lock.lockId &&
                  canonicalHashV1(storedQualification.value.lock) === canonicalHashV1(plan.qualification.lock),
                'persist-qualification',
                'qualification lock is terminal or diverges from the evaluation',
              )
            } else {
              yield* ensure(
                Option.isNone(storedQualification),
                'persist-qualification',
                'locked qualification candidate requires its terminal result in the same transaction',
              )
            }
            yield* ensureProtocolReference({
              protocolHash: plan.protocolHash,
              provenance: plan.provenance,
              parameters: plan.parameters,
            })
            yield* ensureSnapshotReference(plan.evaluation.inputManifest)

            const inserted = yield* insertRun({
              runId: plan.evaluation.runId,
              protocolHash: plan.protocolHash,
              snapshotId: plan.snapshotId,
              evaluationSchemaVersion: plan.evaluation.schemaVersion,
              sourceRevision: plan.provenance.sourceRevision,
              imageRepository: plan.provenance.image.repository,
              imageDigest: plan.provenance.image.digest,
              strategyName: plan.strategyName,
              initialCapitalMicros: plan.evaluation.initialCapitalMicros,
              artifactCount: plan.artifacts.length,
              eventCount: plan.events.length,
              gateCount: plan.gates.length,
            })
            if (inserted.length === 0) {
              if (plan.qualification !== undefined) {
                return yield* Effect.fail(
                  databaseError(
                    'invariant',
                    'persist-qualification',
                    'locked qualification candidate was already evaluated without a terminal result',
                  ),
                )
              }
              return yield* readReceipt(plan, true)
            }

            yield* sql`
            INSERT INTO status_history (run_id, status, detail)
            VALUES (
              ${plan.evaluation.runId},
              'WRITING',
              ${sql.json({
                artifactCount: plan.artifacts.length,
                eventCount: plan.events.length,
                gateCount: plan.gates.length,
              })}
            )
          `
            yield* Effect.forEach(
              plan.artifacts,
              (artifact) => sql`
              INSERT INTO evaluation_artifacts (
                run_id,
                artifact_name,
                schema_version,
                content_hash,
                payload
              ) VALUES (
                ${plan.evaluation.runId},
                ${artifact.name},
                ${artifact.schemaVersion},
                ${artifact.contentHash},
                ${sql.json(artifact.payload)}
              )
            `,
              { discard: true },
            )
            yield* Effect.forEach(
              plan.events,
              (event) => sql`
              INSERT INTO evaluation_events (
                run_id,
                ordinal,
                event_id,
                event_kind,
                content_hash,
                payload
              ) VALUES (
                ${plan.evaluation.runId},
                ${event.ordinal},
                ${event.id},
                ${event.kind},
                ${event.contentHash},
                ${sql.json(event.payload)}
              )
            `,
              { discard: true },
            )
            yield* Effect.forEach(
              plan.gates,
              (gate) => sql`
              INSERT INTO gate_outcomes (
                run_id,
                ordinal,
                gate_name,
                passed,
                actual,
                required,
                content_hash
              ) VALUES (
                ${plan.evaluation.runId},
                ${gate.ordinal},
                ${gate.name},
                ${gate.passed},
                ${jsonScalar(gate.actual)},
                ${jsonScalar(gate.required)},
                ${gate.contentHash}
              )
            `,
              { discard: true },
            )
            const completed = yield* completeRun({ runId: plan.evaluation.runId })
            yield* ensure(
              completed.length === 1,
              'complete-run',
              'run could not be completed with exact evidence counts',
            )
            yield* sql`
            INSERT INTO status_history (run_id, status, detail)
            VALUES (
              ${plan.evaluation.runId},
              'COMPLETE',
              ${sql.json({ reconciliationExact: true, verdict: plan.evaluation.verdict.status })}
            )
          `
            if (plan.qualification !== undefined) {
              const result = plan.qualification.result
              const resultRows = yield* insertQualificationResult({
                lockId: result.lockId,
                schemaVersion: result.schemaVersion,
                runId: result.runId,
                verdict: result.verdict,
                analysisHash: result.analysis.analysisHash,
                resultHash: result.resultHash,
                payload: result,
              })
              yield* ensure(
                resultRows.length === 1 && resultRows[0].lock_id === result.lockId,
                'persist-qualification',
                'terminal qualification result was not inserted exactly once',
              )
            }
            return yield* readReceipt(plan, false)
          }),
        )
      }),
    )

  return {
    check: runDatabase('health', health(undefined).pipe(Effect.asVoid)),
    persist,
    read,
    readArtifactItems,
    recover,
    listPriorTrials,
    openQualification,
    readQualification,
  } satisfies EvidenceStoreService
})

export const PostgresClientLive = (config: Pick<RuntimeConfig, 'operationTimeoutMs' | 'postgres'>) => {
  const readCertificate = Effect.gen(function* () {
    if (!config.postgres.tls) return undefined
    const fileSystem = yield* FileSystem.FileSystem
    return yield* fileSystem.readFileString(config.postgres.caPath)
  })
  return Layer.unwrap(
    readCertificate.pipe(
      Effect.mapError((cause) =>
        databaseError('unavailable', 'tls', 'failed to read PostgreSQL CA certificate', cause),
      ),
      Effect.map((ca) =>
        PgClient.layerFrom(
          PgClient.make({
            url: config.postgres.url,
            ssl: ca === undefined ? undefined : { ca, rejectUnauthorized: true },
            applicationName: 'bayn',
            connectTimeout: config.operationTimeoutMs,
            idleTimeout: '30 seconds',
            maxConnections: 2,
            minConnections: 0,
            transformJson: false,
          }).pipe(Effect.mapError((cause) => classifyDatabaseError('connect', cause))),
        ),
      ),
    ),
  )
}

const migrate = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const [boundary] = yield* decodeMigrationBoundary(
    yield* sql`
      SELECT
        to_regclass('public.schema_migrations') IS NOT NULL AS current_exists,
        to_regclass('public.bayn_schema_migrations') IS NOT NULL AS legacy_exists
    `,
  )
  if (boundary.legacy_exists) {
    return yield* Effect.fail(
      databaseError('migration', 'migrate', 'legacy migration tracker is unsupported after the hard cut'),
    )
  }
  if (boundary.current_exists) {
    const identities = yield* decodeMigrationIdentities(
      yield* sql`SELECT migration_id, name FROM schema_migrations WHERE migration_id = 1`,
    )
    const [initial] = identities
    if (identities.length !== 1 || initial?.name !== 'initial_schema') {
      return yield* Effect.fail(
        databaseError('migration', 'migrate', 'legacy migration history is unsupported after the hard cut'),
      )
    }
  }
  yield* PgMigrator.run({ loader: migrationLoader, table: 'schema_migrations' })
})

const migrations = migrate.pipe(
  Effect.mapError((cause) =>
    cause instanceof DatabaseError
      ? cause
      : isSqlError(cause)
        ? classifyDatabaseError('migrate', cause)
        : databaseError('migration', 'migrate', 'PostgreSQL migration failed', cause),
  ),
  Effect.asVoid,
)

const withMigrationDeadline = <R>(
  migration: Effect.Effect<void, DatabaseError, R>,
  operationTimeoutMs: number,
): Effect.Effect<void, DatabaseError, R> =>
  migration.pipe(
    Effect.timeoutOrElse({
      duration: operationTimeoutMs,
      orElse: () =>
        Effect.fail(
          databaseError('migration', 'migrate', `PostgreSQL migration timed out after ${operationTimeoutMs}ms`),
        ),
    }),
  )

export const makeEvidenceStoreLayer = <RMigration, RStore>(
  config: Pick<RuntimeConfig, 'operationTimeoutMs'>,
  migration: Effect.Effect<void, DatabaseError, RMigration>,
  store: Effect.Effect<EvidenceStoreService, DatabaseError, RStore>,
) =>
  Layer.effect(
    EvidenceStore,
    Effect.gen(function* () {
      yield* withMigrationDeadline(migration, config.operationTimeoutMs)
      return yield* store
    }),
  )

export const EvidenceStoreLive = (config: RuntimeConfig) =>
  makeEvidenceStoreLayer(config, migrations, makeEvidenceStore).pipe(Layer.provideMerge(PostgresClientLive(config)))
