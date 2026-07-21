import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Context, Data, Effect, FileSystem, Layer, Option, Schema } from 'effect'
import { SqlSchema } from 'effect/unstable/sql'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import type { RuntimeConfig } from '../config'
import { makeRunIdentity, makeStrategyProtocolHash, type RuntimeProvenance } from '../contracts'
import {
  decodeCashChangesArtifact,
  decodeDailyPerformanceSeriesArtifact,
  decodeDailyPositionMarksArtifact,
  decodeEquitySeriesArtifact,
  decodeEvaluationEvents,
  decodeEvaluationSummary,
  decodeInputManifestArtifact,
  decodeMarkedEquityReconciliation,
  decodeQualificationArtifactManifest,
  decodeReconciliationResult,
  decodeSimulatedOrdersArtifact,
  decodeTsmomSignalDecisionsArtifact,
  makeEquitySeriesArtifact,
} from '../evidence-contracts'
import { canonicalHashV1 } from '../hash'
import {
  QualificationLockSchema,
  QualificationResultSchema,
  type QualificationLock,
  type QualificationResult,
} from '../qualification'
import { reconcileMarkedEquity } from '../simulation-reconciliation'
import { summarizeEvaluation } from '../strategy'
import type { EvaluationResult, EvaluationSummary, InputManifest, ReconciliationResult } from '../types'
import { migrationLoader } from './migrations'

export type DatabaseFailure = 'constraint' | 'decode' | 'invariant' | 'migration' | 'query' | 'unavailable'

export class DatabaseError extends Data.TaggedError('DatabaseError')<{
  readonly failure: DatabaseFailure
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

export interface PersistenceReceipt {
  readonly runId: string
  readonly deduplicated: boolean
  readonly artifactCount: number
  readonly eventCount: number
  readonly gateCount: number
}

export interface PersistEvaluationInput {
  readonly provenance: RuntimeProvenance
  readonly parameters: unknown
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
  readonly parameters: unknown
  readonly provenance: RuntimeProvenance
}

export interface ArtifactItemPage {
  readonly runId: string
  readonly artifactName: string
  readonly schemaVersion: string
  readonly contentHash: string
  readonly itemCount: number
  readonly items: readonly { readonly ordinal: number; readonly payload: unknown }[]
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

export interface StoredEvaluationEvidence {
  readonly protocol: {
    readonly protocolHash: string
    readonly schemaVersion: string
    readonly strategyName: string
    readonly behaviorHash: string
    readonly parameterHash: string
    readonly parameters: unknown
  }
  readonly run: {
    readonly runId: string
    readonly protocolHash: string
    readonly snapshotId: string
    readonly evaluationSchemaVersion: string
    readonly sourceRevision: string
    readonly imageRepository: string
    readonly imageDigest: string
    readonly strategyName: string
    readonly initialCapitalMicros: string
    readonly artifactCount: number
    readonly eventCount: number
    readonly gateCount: number
  }
  readonly artifacts: readonly {
    readonly name: string
    readonly schemaVersion: string
    readonly contentHash: string
    readonly payload: unknown
  }[]
  readonly events: readonly {
    readonly ordinal: number
    readonly id: string
    readonly kind: 'decision' | 'fill' | 'fee' | 'cash-yield'
    readonly contentHash: string
    readonly payload: unknown
  }[]
  readonly gates: readonly {
    readonly ordinal: number
    readonly name: string
    readonly passed: boolean
    readonly actual: unknown
    readonly required: unknown
    readonly contentHash: string
  }[]
  readonly statuses: readonly {
    readonly status: 'WRITING' | 'COMPLETE'
    readonly detail: unknown
  }[]
}

export interface RecoveredEvaluationEvidence {
  readonly evaluation: EvaluationSummary
  readonly reconciliation: ReconciliationResult
  readonly persistence: PersistenceReceipt
}

interface ArtifactPlan {
  readonly name: string
  readonly schemaVersion: string
  readonly contentHash: string
  readonly payload: unknown
}

interface EventPlan {
  readonly ordinal: number
  readonly id: string
  readonly kind: 'decision' | 'fill' | 'fee' | 'cash-yield'
  readonly contentHash: string
  readonly payload: unknown
}

interface GatePlan {
  readonly ordinal: number
  readonly name: string
  readonly passed: boolean
  readonly actual: number | boolean | string
  readonly required: number | boolean | string
  readonly contentHash: string
}

interface PersistencePlan extends PersistEvaluationInput {
  readonly strategyName: string
  readonly protocolHash: string
  readonly snapshotId: string
  readonly artifacts: readonly ArtifactPlan[]
  readonly events: readonly EventPlan[]
  readonly gates: readonly GatePlan[]
}

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const GitRevision = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))
const ImageDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const RunRequest = Schema.Struct({ runId: Sha256 })
const InsertedRun = Schema.Struct({ run_id: Sha256 })
const HealthRow = Schema.Struct({ value: Schema.Literal(1) })
const ProtocolRow = Schema.Struct({
  protocol_hash: Sha256,
  schema_version: Schema.String,
  strategy_name: Schema.String,
  behavior_hash: Sha256,
  parameter_hash: Sha256,
  parameters: Schema.Unknown,
})
const SnapshotRow = Schema.Struct({
  snapshot_id: Sha256,
  schema_version: Schema.String,
  database_name: Schema.String,
  table_name: Schema.String,
  dataset_version: Schema.String,
  source: Schema.String,
  source_feed: Schema.String,
  adjustment: Schema.String,
  content_hash: Sha256,
  row_count: PositiveInteger,
  first_session: Schema.String,
  last_session: Schema.String,
  manifest: Schema.Unknown,
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
  payload: Schema.Unknown,
})
const ArtifactSeriesMetadataRow = Schema.Struct({
  schema_version: Schema.String,
  content_hash: Sha256,
  item_count: NonNegativeInteger,
})
const ArtifactItemRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  payload: Schema.Unknown,
})
const EventReferenceRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  event_id: Sha256,
  event_kind: Schema.Literals(['decision', 'fill', 'fee', 'cash-yield']),
  content_hash: Sha256,
  payload: Schema.Unknown,
})
const GateReferenceRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  gate_name: Schema.String,
  passed: Schema.Boolean,
  actual: Schema.Unknown,
  required: Schema.Unknown,
  content_hash: Sha256,
})
const StatusReferenceRow = Schema.Struct({
  status: Schema.Literals(['WRITING', 'COMPLETE']),
  detail: Schema.Unknown,
})
const QualificationTrialRow = Schema.Struct({ run_id: Sha256 })
const QualificationRow = Schema.Struct({
  lock_payload: Schema.Unknown,
  result_payload: Schema.NullOr(Schema.Unknown),
})
const CandidateRunCountRow = Schema.Struct({ count: NonNegativeInteger })
const InsertedLockRow = Schema.Struct({ lock_id: Sha256 })
const InsertedResultRow = Schema.Struct({ lock_id: Sha256 })

const StrictParseOptions = { onExcessProperty: 'error' } as const
const decodeQualificationLock = Schema.decodeUnknownSync(QualificationLockSchema, StrictParseOptions)
const decodeQualificationResult = Schema.decodeUnknownSync(QualificationResultSchema, StrictParseOptions)

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const errorCodeOf = (cause: unknown, depth = 0): string | undefined => {
  if (depth > 4 || typeof cause !== 'object' || cause === null) return undefined
  if ('code' in cause && typeof cause.code === 'string') return cause.code
  return 'cause' in cause ? errorCodeOf(cause.cause, depth + 1) : undefined
}

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
    const code = errorCodeOf(cause.reason)
    const failure: DatabaseFailure =
      cause.reason._tag === 'UniqueViolation' || cause.reason._tag === 'ConstraintError'
        ? 'constraint'
        : cause.reason._tag === 'SqlSyntaxError' ||
            (cause.reason._tag === 'UnknownError' &&
              code !== undefined &&
              !code.startsWith('E') &&
              !code.startsWith('08'))
          ? 'query'
          : 'unavailable'
    return databaseError(failure, operation, 'PostgreSQL operation failed', cause)
  }
  return databaseError('invariant', operation, 'unexpected database result', cause)
}

const runDatabase = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, DatabaseError, R> =>
  effect.pipe(Effect.mapError((cause) => classifyDatabaseError(operation, cause)))

const ensure = (condition: boolean, operation: string, message: string): Effect.Effect<void, DatabaseError> =>
  condition ? Effect.void : Effect.fail(databaseError('invariant', operation, message))

const snapshotReferenceMatches = (row: typeof SnapshotRow.Type, inputManifest: InputManifest): boolean => {
  const snapshot = inputManifest.finalizedSnapshot
  return (
    row.snapshot_id === snapshot.snapshotId &&
    row.schema_version === snapshot.schemaVersion &&
    row.database_name === inputManifest.database &&
    row.table_name === inputManifest.tables.bars &&
    row.dataset_version === snapshot.publicationSchemaVersion &&
    row.source === snapshot.source &&
    row.source_feed === snapshot.sourceFeed &&
    row.adjustment === snapshot.adjustment &&
    row.content_hash === snapshot.contentHash &&
    row.row_count === snapshot.rowCount &&
    row.first_session === snapshot.firstSession &&
    row.last_session === snapshot.lastSession &&
    canonicalHashV1(row.manifest) === canonicalHashV1(snapshot)
  )
}

const protocolExecutionModel = (parameters: unknown): unknown => {
  if (
    typeof parameters !== 'object' ||
    parameters === null ||
    !('executionModel' in parameters) ||
    typeof parameters.executionModel !== 'object' ||
    parameters.executionModel === null
  ) {
    throw new TypeError('strategy parameters do not declare an execution model')
  }
  return parameters.executionModel
}

const artifactItemCount = (payload: unknown): number => {
  if (typeof payload !== 'object' || payload === null || !('items' in payload)) return 0
  return Array.isArray(payload.items) ? payload.items.length : 0
}

const validateQualificationOpenInput = (input: OpenQualificationInput): OpenQualificationInput => {
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
    canonicalHashV1(lock.universe) !== canonicalHashV1(snapshot.symbols) ||
    !dataMatches ||
    canonicalHashV1(lock.policies.execution.content) !== canonicalHashV1(protocolExecutionModel(parameters))
  ) {
    throw new TypeError('qualification lock diverges from the candidate runtime or finalized snapshot')
  }
  return { ...input, lock }
}

const makePersistencePlan = (input: PersistEvaluationInput): PersistencePlan => {
  const { evaluation, parameters, provenance, reconciliation } = input
  const strategyName = provenance.strategy.name
  const parameterHash = canonicalHashV1(parameters)
  if (parameterHash !== provenance.strategy.parameterHash) {
    throw new TypeError('strategy parameters and provenance disagree on parameter hash')
  }
  if (canonicalHashV1(evaluation.simulation.executionModel) !== canonicalHashV1(protocolExecutionModel(parameters))) {
    throw new TypeError('simulation execution model does not match strategy parameters')
  }
  if (evaluation.simulation.costMultiplierMicros !== '1000000') {
    throw new TypeError('candidate simulation must use the base execution-cost multiplier')
  }
  const protocolHash = makeStrategyProtocolHash(provenance.strategy)
  if (protocolHash !== evaluation.protocolHash)
    throw new TypeError('evaluation and provenance disagree on protocol hash')
  if (evaluation.codeRevision !== provenance.sourceRevision) {
    throw new TypeError('evaluation code revision does not match runtime provenance')
  }
  if (reconciliation.runId !== evaluation.runId || reconciliation.exact !== true) {
    throw new TypeError('reconciliation does not exactly match the evaluation run')
  }
  const { hash: inputManifestHash, ...manifestMaterial } = evaluation.inputManifest
  if (canonicalHashV1(manifestMaterial) !== inputManifestHash) {
    throw new TypeError('input manifest hash does not match its content')
  }
  const snapshotId = evaluation.inputManifest.finalizedSnapshot.snapshotId
  const expectedRunId = makeRunIdentity({
    schemaVersion: 'bayn.run-identity.v1',
    sourceRevision: provenance.sourceRevision,
    image: provenance.image,
    strategy: {
      name: strategyName,
      behaviorHash: provenance.strategy.behaviorHash,
      parameters,
    },
    finalizedSnapshot: evaluation.inputManifest.finalizedSnapshot,
    calendarVersion: evaluation.inputManifest.finalizedSnapshot.calendarVersion,
    bounds: evaluation.inputManifest.bounds,
  }).runId
  if (evaluation.runId !== expectedRunId) throw new TypeError('run ID does not match runtime and input provenance')

  const equityProof = reconcileMarkedEquity({
    runId: evaluation.runId,
    initialCapitalMicros: evaluation.initialCapitalMicros,
    evaluatorTotalFeesMicros: evaluation.strategy.totalFeesMicros,
    evaluatorEndingEquityMicros: evaluation.strategy.endingEquityMicros,
    events: evaluation.events,
    simulation: evaluation.simulation,
  })
  if (
    canonicalHashV1(equityProof.reconciliation) !== canonicalHashV1(evaluation.markedEquityReconciliation) ||
    canonicalHashV1(equityProof.equitySeries) !== canonicalHashV1(evaluation.equitySeries)
  ) {
    throw new TypeError('independent marked-equity proof diverges from the evaluation evidence')
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
    throw new TypeError('TSMOM signal decisions diverge from durable decision events')
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
    throw new TypeError('candidate and benchmark daily series are not exactly aligned')
  }

  const baseArtifacts = [
    ['evaluation-summary', 'bayn.evaluation-summary.v3', summarizeEvaluation(evaluation)],
    ['input-manifest', evaluation.inputManifest.schemaVersion, evaluation.inputManifest],
    ['strategy', 'bayn.performance-metrics.v2', evaluation.strategy],
    ['buy-and-hold', 'bayn.performance-metrics.v2', evaluation.buyAndHold],
    ['direct-volatility-timing', 'bayn.performance-metrics.v2', evaluation.directVolTiming],
    ['double-cost-strategy', 'bayn.performance-metrics.v2', evaluation.doubleCostStrategy],
    [
      'simulated-orders',
      'bayn.simulated-orders.v2',
      {
        schemaVersion: 'bayn.simulated-orders.v2',
        executionModel: evaluation.simulation.executionModel,
        costMultiplierMicros: evaluation.simulation.costMultiplierMicros,
        items: evaluation.simulation.orders,
      },
    ],
    [
      'cash-changes',
      'bayn.cash-changes.v2',
      { schemaVersion: 'bayn.cash-changes.v2', items: evaluation.simulation.cashChanges },
    ],
    [
      'daily-position-marks',
      'bayn.daily-position-marks.v3',
      { schemaVersion: 'bayn.daily-position-marks.v3', items: evaluation.simulation.dailyMarks },
    ],
    [
      'tsmom-signal-decisions',
      'bayn.tsmom-signal-decisions.v1',
      { schemaVersion: 'bayn.tsmom-signal-decisions.v1', items: evaluation.signalDecisions },
    ],
    [
      'buy-and-hold-series',
      'bayn.daily-performance-series.v1',
      {
        schemaVersion: 'bayn.daily-performance-series.v1',
        series: 'buy-and-hold',
        items: evaluation.benchmarkSeries.buyAndHold,
      },
    ],
    [
      'direct-volatility-timing-series',
      'bayn.daily-performance-series.v1',
      {
        schemaVersion: 'bayn.daily-performance-series.v1',
        series: 'direct-volatility-timing',
        items: evaluation.benchmarkSeries.directVolTiming,
      },
    ],
    [
      'double-cost-strategy-series',
      'bayn.daily-performance-series.v1',
      {
        schemaVersion: 'bayn.daily-performance-series.v1',
        series: 'double-cost-strategy',
        items: evaluation.benchmarkSeries.doubleCostStrategy,
      },
    ],
    ['equity-series', 'bayn.equity-series.v1', makeEquitySeriesArtifact(evaluation.equitySeries)],
    [
      'marked-equity-reconciliation',
      evaluation.markedEquityReconciliation.schemaVersion,
      evaluation.markedEquityReconciliation,
    ],
    ['reconciliation', 'bayn.reconciliation.v1', reconciliation],
  ].map(([name, schemaVersion, payload]) => ({
    name: name as string,
    schemaVersion: schemaVersion as string,
    contentHash: canonicalHashV1(payload),
    payload,
  })) satisfies ArtifactPlan[]
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
  if (events.length === 0) throw new TypeError('evaluation produced no durable events')
  if (gates.length === 0) throw new TypeError('evaluation produced no economic gate outcomes')

  let qualification = input.qualification
  if (qualification !== undefined) {
    const lock = validateQualificationOpenInput({
      lock: qualification.lock,
      inputManifest: evaluation.inputManifest,
      parameters,
      provenance,
    }).lock
    const result = decodeQualificationResult(qualification.result)
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
      throw new TypeError('qualification result diverges from the locked evaluation')
    }
    qualification = { lock, result }
  }

  const artifactManifest = {
    schemaVersion: 'bayn.qualification-artifact-manifest.v1',
    identity: {
      runId: evaluation.runId,
      evaluationSchemaVersion: evaluation.schemaVersion,
      protocolHash,
      sourceRevision: provenance.sourceRevision,
      image: provenance.image,
      snapshotId,
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
    artifacts: [...baseArtifacts]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((artifact) => ({
        name: artifact.name,
        schemaVersion: artifact.schemaVersion,
        itemCount: artifactItemCount(artifact.payload),
        contentHash: artifact.contentHash,
      })),
    events: {
      count: events.length,
      contentHash: canonicalHashV1(
        events.map(({ ordinal, id, kind, contentHash }) => ({ ordinal, id, kind, contentHash })),
      ),
    },
    gates: {
      count: gates.length,
      contentHash: canonicalHashV1(
        gates.map(({ ordinal, name, passed, contentHash }) => ({ ordinal, name, passed, contentHash })),
      ),
    },
  }
  const artifacts = [
    ...baseArtifacts,
    {
      name: 'qualification-artifact-manifest',
      schemaVersion: artifactManifest.schemaVersion,
      contentHash: canonicalHashV1(artifactManifest),
      payload: artifactManifest,
    },
  ]

  return { ...input, qualification, strategyName, protocolHash, snapshotId, artifacts, events, gates }
}

const makeEvidenceStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const jsonScalar = (value: number | boolean | string) =>
    sql.json(typeof value === 'string' ? JSON.stringify(value) : value)

  const health = SqlSchema.findOne({
    Request: Schema.Void,
    Result: HealthRow,
    execute: () => sql`SELECT 1::integer AS value`,
  })
  const getProtocol = SqlSchema.findOne({
    Request: Schema.Struct({ protocolHash: Sha256 }),
    Result: ProtocolRow,
    execute: ({ protocolHash }) => sql`SELECT * FROM bayn_protocol_locks WHERE protocol_hash = ${protocolHash}`,
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
      FROM bayn_snapshot_references
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
      INSERT INTO bayn_evaluation_runs (
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
      UPDATE bayn_evaluation_runs AS run
      SET status = 'COMPLETE', completed_at = transaction_timestamp()
      WHERE run.run_id = ${runId}
        AND run.status = 'WRITING'
        AND run.expected_artifact_count = (
          SELECT count(*)::integer FROM bayn_evaluation_artifacts WHERE run_id = ${runId}
        )
        AND run.expected_event_count = (
          SELECT count(*)::integer FROM bayn_evaluation_events WHERE run_id = ${runId}
        )
        AND run.expected_gate_count = (
          SELECT count(*)::integer FROM bayn_gate_outcomes WHERE run_id = ${runId}
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
        (SELECT count(*)::integer FROM bayn_evaluation_artifacts WHERE run_id = run.run_id) AS artifact_count,
        (SELECT count(*)::integer FROM bayn_evaluation_events WHERE run_id = run.run_id) AS event_count,
        (SELECT count(*)::integer FROM bayn_gate_outcomes WHERE run_id = run.run_id) AS gate_count
      FROM bayn_evaluation_runs AS run
      WHERE run.run_id = ${runId}
    `,
  })
  const getArtifactReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: ArtifactReferenceRow,
    execute: ({ runId }) => sql`
      SELECT artifact_name, schema_version, content_hash, payload
      FROM bayn_evaluation_artifacts
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
      FROM bayn_evaluation_artifacts AS artifact
      JOIN bayn_evaluation_runs AS run USING (run_id)
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
      FROM bayn_evaluation_artifacts AS artifact
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
      FROM bayn_evaluation_events
      WHERE run_id = ${runId}
      ORDER BY ordinal
    `,
  })
  const getGateReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: GateReferenceRow,
    execute: ({ runId }) => sql`
      SELECT ordinal, gate_name, passed, actual, required, content_hash
      FROM bayn_gate_outcomes
      WHERE run_id = ${runId}
      ORDER BY ordinal
    `,
  })
  const getStatusReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: StatusReferenceRow,
    execute: ({ runId }) => sql`
      SELECT status, detail FROM bayn_status_history WHERE run_id = ${runId} ORDER BY sequence
    `,
  })
  const getPriorTrials = SqlSchema.findAll({
    Request: Schema.Void,
    Result: QualificationTrialRow,
    execute: () => sql`
      SELECT run_id
      FROM (
        SELECT run_id FROM bayn_qualification_trials
        UNION
        SELECT run_id FROM bayn_qualification_results
      ) AS trials
      ORDER BY run_id
    `,
  })
  const getQualificationByCandidate = SqlSchema.findAll({
    Request: Schema.Struct({ candidateRunId: Sha256 }),
    Result: QualificationRow,
    execute: ({ candidateRunId }) => sql`
      SELECT lock.payload AS lock_payload, result.payload AS result_payload
      FROM bayn_qualification_locks AS lock
      LEFT JOIN bayn_qualification_results AS result USING (lock_id)
      WHERE lock.candidate_run_id = ${candidateRunId}
    `,
  })
  const getQualificationByIdentity = SqlSchema.findAll({
    Request: Schema.Struct({ candidateRunId: Sha256, snapshotId: Sha256 }),
    Result: QualificationRow,
    execute: ({ candidateRunId, snapshotId }) => sql`
      SELECT lock.payload AS lock_payload, result.payload AS result_payload
      FROM bayn_qualification_locks AS lock
      LEFT JOIN bayn_qualification_results AS result USING (lock_id)
      WHERE lock.candidate_run_id = ${candidateRunId} OR lock.snapshot_id = ${snapshotId}
      ORDER BY lock.lock_id
    `,
  })
  const insertQualificationLock = SqlSchema.findAll({
    Request: Schema.Struct({
      lockId: Sha256,
      schemaVersion: Schema.Literal('bayn.qualification-lock.v2'),
      candidateRunId: Sha256,
      protocolHash: Sha256,
      snapshotId: Sha256,
      sourceRevision: GitRevision,
      imageRepository: Schema.String,
      imageDigest: ImageDigest,
      payload: Schema.Unknown,
    }),
    Result: InsertedLockRow,
    execute: (request) => sql`
      INSERT INTO bayn_qualification_locks (
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
      payload: Schema.Unknown,
    }),
    Result: InsertedResultRow,
    execute: (request) => sql`
      INSERT INTO bayn_qualification_results (
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
      SELECT count(*)::integer AS count FROM bayn_evaluation_runs WHERE run_id = ${candidateRunId}
    `,
  })
  const getIncompleteQualificationCount = SqlSchema.findOne({
    Request: Schema.Void,
    Result: CandidateRunCountRow,
    execute: () => sql`
      SELECT count(*)::integer AS count
      FROM bayn_qualification_locks AS lock
      LEFT JOIN bayn_qualification_results AS result USING (lock_id)
      WHERE result.lock_id IS NULL
    `,
  })

  const decodeQualificationRecord = (row: typeof QualificationRow.Type): QualificationRecord => {
    const lock = decodeQualificationLock(row.lock_payload)
    if (row.result_payload === null) return { state: 'OPENED_INCOMPLETE', lock }
    const result = decodeQualificationResult(row.result_payload)
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
    readonly parameters: unknown
  }) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO bayn_protocol_locks (
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
      const snapshot = inputManifest.finalizedSnapshot
      yield* sql`
        INSERT INTO bayn_snapshot_references (
          snapshot_id,
          schema_version,
          database_name,
          table_name,
          dataset_version,
          source,
          source_feed,
          adjustment,
          content_hash,
          row_count,
          first_session,
          last_session,
          manifest
        ) VALUES (
          ${snapshot.snapshotId},
          ${snapshot.schemaVersion},
          ${inputManifest.database},
          ${inputManifest.tables.bars},
          ${snapshot.publicationSchemaVersion},
          ${snapshot.source},
          ${snapshot.sourceFeed},
          ${snapshot.adjustment},
          ${snapshot.contentHash},
          ${snapshot.rowCount},
          ${snapshot.firstSession},
          ${snapshot.lastSession},
          ${sql.json(snapshot)}
        )
        ON CONFLICT (snapshot_id) DO NOTHING
      `
      const storedSnapshot = yield* getSnapshot({ snapshotId: snapshot.snapshotId })
      yield* ensure(
        snapshotReferenceMatches(storedSnapshot, inputManifest),
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
      const expectedArtifacts = [...plan.artifacts].sort((left, right) => left.name.localeCompare(right.name))
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

  const readStored = (runId: string) =>
    Effect.gen(function* () {
      const rows = yield* getReceipt({ runId })
      if (rows.length === 0) return Option.none<StoredEvaluationEvidence>()
      yield* ensure(rows.length === 1, 'read-evidence', 'stored run receipt is duplicated')
      const row = rows[0]
      const protocol = yield* getProtocol({ protocolHash: row.protocol_hash })
      const artifacts = yield* getArtifactReferences({ runId })
      const events = yield* getEventReferences({ runId })
      const gates = yield* getGateReferences({ runId })
      const statuses = yield* getStatusReferences({ runId })

      yield* ensure(
        row.strategy_name === protocol.strategy_name &&
          canonicalHashV1(protocol.parameters) === protocol.parameter_hash,
        'read-evidence',
        'stored protocol lock diverged',
      )

      yield* ensure(
        artifacts.length === row.expected_artifact_count && artifacts.length === row.artifact_count,
        'read-evidence',
        'stored artifact count is incomplete',
      )
      yield* ensure(
        events.length === row.expected_event_count && events.length === row.event_count,
        'read-evidence',
        'stored event count is incomplete',
      )
      yield* ensure(
        gates.length === row.expected_gate_count && gates.length === row.gate_count,
        'read-evidence',
        'stored gate count is incomplete',
      )
      yield* ensure(
        artifacts.every((artifact) => canonicalHashV1(artifact.payload) === artifact.content_hash),
        'read-evidence',
        'stored artifact content hash diverged',
      )
      yield* ensure(
        events.every(
          (event, index) => event.ordinal === index && canonicalHashV1(event.payload) === event.content_hash,
        ),
        'read-evidence',
        'stored event content hash or ordering diverged',
      )
      yield* ensure(
        gates.every(
          (gate, index) =>
            gate.ordinal === index &&
            canonicalHashV1({
              name: gate.gate_name,
              passed: gate.passed,
              actual: gate.actual,
              required: gate.required,
            }) === gate.content_hash,
        ),
        'read-evidence',
        'stored gate content hash or ordering diverged',
      )
      const completeDetail = statuses[1]?.detail
      const completeDetailValid =
        typeof completeDetail === 'object' &&
        completeDetail !== null &&
        'reconciliationExact' in completeDetail &&
        completeDetail.reconciliationExact === true &&
        'verdict' in completeDetail &&
        (completeDetail.verdict === 'PASS' || completeDetail.verdict === 'FAIL_CLOSED')
      yield* ensure(
        statuses.length === 2 &&
          statuses[0].status === 'WRITING' &&
          canonicalHashV1(statuses[0].detail) ===
            canonicalHashV1({
              artifactCount: row.artifact_count,
              eventCount: row.event_count,
              gateCount: row.gate_count,
            }) &&
          statuses[1].status === 'COMPLETE' &&
          completeDetailValid,
        'read-evidence',
        'stored status history is incomplete or divergent',
      )

      return Option.some({
        protocol: {
          protocolHash: protocol.protocol_hash,
          schemaVersion: protocol.schema_version,
          strategyName: protocol.strategy_name,
          behaviorHash: protocol.behavior_hash,
          parameterHash: protocol.parameter_hash,
          parameters: protocol.parameters,
        },
        run: {
          runId: row.run_id,
          protocolHash: row.protocol_hash,
          snapshotId: row.snapshot_id,
          evaluationSchemaVersion: row.evaluation_schema_version,
          sourceRevision: row.source_revision,
          imageRepository: row.image_repository,
          imageDigest: row.image_digest,
          strategyName: row.strategy_name,
          initialCapitalMicros: row.initial_capital_micros,
          artifactCount: row.artifact_count,
          eventCount: row.event_count,
          gateCount: row.gate_count,
        },
        artifacts: artifacts.map((artifact) => ({
          name: artifact.artifact_name,
          schemaVersion: artifact.schema_version,
          contentHash: artifact.content_hash,
          payload: artifact.payload,
        })),
        events: events.map((event) => ({
          ordinal: event.ordinal,
          id: event.event_id,
          kind: event.event_kind,
          contentHash: event.content_hash,
          payload: event.payload,
        })),
        gates: gates.map((gate) => ({
          ordinal: gate.ordinal,
          name: gate.gate_name,
          passed: gate.passed,
          actual: gate.actual,
          required: gate.required,
          contentHash: gate.content_hash,
        })),
        statuses,
      } satisfies StoredEvaluationEvidence)
    })

  const read = (runId: string) => runDatabase('read-evidence', readStored(runId))

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
            yield* sql`LOCK TABLE bayn_qualification_trials IN SHARE MODE`
            yield* sql`LOCK TABLE bayn_qualification_locks IN SHARE ROW EXCLUSIVE MODE`

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
        const storedOption = yield* readStored(runId)
        if (Option.isNone(storedOption)) return Option.none<RecoveredEvaluationEvidence>()
        const stored = storedOption.value
        const requiredArtifacts = new Map([
          ['buy-and-hold', 'bayn.performance-metrics.v2'],
          ['buy-and-hold-series', 'bayn.daily-performance-series.v1'],
          ['cash-changes', 'bayn.cash-changes.v2'],
          ['daily-position-marks', 'bayn.daily-position-marks.v3'],
          ['direct-volatility-timing', 'bayn.performance-metrics.v2'],
          ['direct-volatility-timing-series', 'bayn.daily-performance-series.v1'],
          ['double-cost-strategy', 'bayn.performance-metrics.v2'],
          ['double-cost-strategy-series', 'bayn.daily-performance-series.v1'],
          ['equity-series', 'bayn.equity-series.v1'],
          ['evaluation-summary', 'bayn.evaluation-summary.v3'],
          ['input-manifest', 'bayn.input-manifest.v2'],
          ['marked-equity-reconciliation', 'bayn.marked-equity-reconciliation.v2'],
          ['qualification-artifact-manifest', 'bayn.qualification-artifact-manifest.v1'],
          ['reconciliation', 'bayn.reconciliation.v1'],
          ['simulated-orders', 'bayn.simulated-orders.v2'],
          ['strategy', 'bayn.performance-metrics.v2'],
          ['tsmom-signal-decisions', 'bayn.tsmom-signal-decisions.v1'],
        ])
        const artifacts = new Map(stored.artifacts.map((artifact) => [artifact.name, artifact]))
        yield* ensure(
          artifacts.size === requiredArtifacts.size &&
            [...requiredArtifacts].every(
              ([name, schemaVersion]) => artifacts.get(name)?.schemaVersion === schemaVersion,
            ),
          'recover-evidence',
          'stored run does not have the exact v4 artifact contract',
        )
        yield* ensure(
          stored.run.runId === runId &&
            stored.run.evaluationSchemaVersion === 'bayn.evaluation.v4' &&
            stored.run.sourceRevision === provenance.sourceRevision &&
            stored.run.imageRepository === provenance.image.repository &&
            stored.run.imageDigest === provenance.image.digest &&
            stored.run.strategyName === provenance.strategy.name &&
            stored.run.protocolHash === makeStrategyProtocolHash(provenance.strategy),
          'recover-evidence',
          'stored run does not match the current runtime identity',
        )
        const evaluation = yield* decodeEvaluationSummary(artifacts.get('evaluation-summary')!.payload)
        const reconciliation = yield* decodeReconciliationResult(artifacts.get('reconciliation')!.payload)
        const markedEquity = yield* decodeMarkedEquityReconciliation(
          artifacts.get('marked-equity-reconciliation')!.payload,
        )
        const equitySeries = yield* decodeEquitySeriesArtifact(artifacts.get('equity-series')!.payload)
        const events = yield* decodeEvaluationEvents(stored.events.map((event) => event.payload))
        const orders = yield* decodeSimulatedOrdersArtifact(artifacts.get('simulated-orders')!.payload)
        const signalDecisions = yield* decodeTsmomSignalDecisionsArtifact(
          artifacts.get('tsmom-signal-decisions')!.payload,
        )
        const buyAndHoldSeries = yield* decodeDailyPerformanceSeriesArtifact(
          artifacts.get('buy-and-hold-series')!.payload,
        )
        const directVolatilitySeries = yield* decodeDailyPerformanceSeriesArtifact(
          artifacts.get('direct-volatility-timing-series')!.payload,
        )
        const doubleCostSeries = yield* decodeDailyPerformanceSeriesArtifact(
          artifacts.get('double-cost-strategy-series')!.payload,
        )
        const artifactManifest = yield* decodeQualificationArtifactManifest(
          artifacts.get('qualification-artifact-manifest')!.payload,
        )
        const storedExecutionModel = yield* Effect.try({
          try: () => protocolExecutionModel(stored.protocol.parameters),
          catch: (cause) => databaseError('invariant', 'recover-evidence', 'stored execution model is invalid', cause),
        })
        yield* ensure(
          stored.protocol.schemaVersion === provenance.strategy.parameterSchemaVersion &&
            stored.protocol.strategyName === provenance.strategy.name &&
            stored.protocol.behaviorHash === provenance.strategy.behaviorHash &&
            stored.protocol.parameterHash === provenance.strategy.parameterHash &&
            canonicalHashV1(stored.protocol.parameters) === provenance.strategy.parameterHash &&
            canonicalHashV1(storedExecutionModel) === canonicalHashV1(orders.executionModel) &&
            orders.costMultiplierMicros === '1000000',
          'recover-evidence',
          'stored protocol lock or execution model diverged',
        )
        const cashChanges = yield* decodeCashChangesArtifact(artifacts.get('cash-changes')!.payload)
        const dailyMarks = yield* decodeDailyPositionMarksArtifact(artifacts.get('daily-position-marks')!.payload)
        const inputManifest = yield* decodeInputManifestArtifact(artifacts.get('input-manifest')!.payload)
        const expectedArtifactManifest = {
          schemaVersion: 'bayn.qualification-artifact-manifest.v1',
          identity: {
            runId,
            evaluationSchemaVersion: evaluation.evaluationSchemaVersion,
            protocolHash: stored.run.protocolHash,
            sourceRevision: stored.run.sourceRevision,
            image: { repository: stored.run.imageRepository, digest: stored.run.imageDigest },
            snapshotId: stored.run.snapshotId,
            publicationId: inputManifest.finalizedSnapshot.publicationId,
            inputManifestHash: inputManifest.hash,
            bounds: inputManifest.bounds,
            calendarVersion: inputManifest.finalizedSnapshot.calendarVersion,
          },
          execution: {
            parameterSchemaVersion: stored.protocol.schemaVersion,
            parameterHash: stored.protocol.parameterHash,
            simulationSchemaVersion: 'bayn.simulation-trace.v3',
            executionModel: orders.executionModel,
            costMultiplierMicros: orders.costMultiplierMicros,
          },
          artifacts: stored.artifacts
            .filter((artifact) => artifact.name !== 'qualification-artifact-manifest')
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((artifact) => ({
              name: artifact.name,
              schemaVersion: artifact.schemaVersion,
              itemCount: artifactItemCount(artifact.payload),
              contentHash: artifact.contentHash,
            })),
          events: {
            count: stored.events.length,
            contentHash: canonicalHashV1(
              stored.events.map(({ ordinal, id, kind, contentHash }) => ({ ordinal, id, kind, contentHash })),
            ),
          },
          gates: {
            count: stored.gates.length,
            contentHash: canonicalHashV1(
              stored.gates.map(({ ordinal, name, passed, contentHash }) => ({ ordinal, name, passed, contentHash })),
            ),
          },
        }
        const storedSnapshot = yield* getSnapshot({ snapshotId: stored.run.snapshotId })
        yield* ensure(
          snapshotReferenceMatches(storedSnapshot, inputManifest),
          'recover-evidence',
          'stored snapshot reference diverged from the recovered input manifest',
        )
        const equityProof = yield* Effect.try({
          try: () =>
            reconcileMarkedEquity({
              runId,
              initialCapitalMicros: evaluation.initialCapitalMicros,
              evaluatorTotalFeesMicros: evaluation.strategy.totalFeesMicros,
              evaluatorEndingEquityMicros: evaluation.strategy.endingEquityMicros,
              events,
              simulation: {
                schemaVersion: 'bayn.simulation-trace.v3',
                executionModel: orders.executionModel,
                costMultiplierMicros: orders.costMultiplierMicros,
                orders: orders.items,
                cashChanges: cashChanges.items,
                dailyMarks: dailyMarks.items,
              },
            }),
          catch: (cause) =>
            databaseError('invariant', 'recover-evidence', 'stored marked-equity reconstruction failed', cause),
        })
        const finalPoint = equitySeries.items.at(-1)!
        const decisionEvents = events.filter((event) => event.kind === 'decision')
        const candidateDates = dailyMarks.items.map((point) => point.sessionDate)
        yield* ensure(
          evaluation.runId === runId &&
            evaluation.codeRevision === provenance.sourceRevision &&
            evaluation.protocolHash === stored.run.protocolHash &&
            evaluation.initialCapitalMicros === stored.run.initialCapitalMicros &&
            evaluation.input.snapshotId === stored.run.snapshotId &&
            evaluation.input.snapshotId === inputManifest.finalizedSnapshot.snapshotId &&
            evaluation.input.publicationId === inputManifest.finalizedSnapshot.publicationId &&
            evaluation.input.manifestHash === inputManifest.hash &&
            canonicalHashV1(evaluation.input.bounds) === canonicalHashV1(inputManifest.bounds) &&
            evaluation.input.rowCount === inputManifest.rowCount &&
            evaluation.input.sessionCount === inputManifest.sessionCount &&
            canonicalHashV1(evaluation.input.symbols) ===
              canonicalHashV1(inputManifest.symbols.map((coverage) => coverage.symbol)) &&
            evaluation.eventCount === stored.run.eventCount &&
            evaluation.eventCount === events.length &&
            evaluation.signalDecisionCount === signalDecisions.items.length &&
            signalDecisions.items.length === decisionEvents.length &&
            signalDecisions.items.every(
              (decision, index) =>
                decision.decisionId === decisionEvents[index]?.id &&
                decision.signalDate === decisionEvents[index]?.signalDate &&
                decision.executionDate === decisionEvents[index]?.executionDate &&
                canonicalHashV1(decision.targetWeights) === canonicalHashV1(decisionEvents[index]?.targetWeights),
            ) &&
            evaluation.orderCount === orders.items.length &&
            evaluation.cashChangeCount === cashChanges.items.length &&
            evaluation.dailyMarkCount === dailyMarks.items.length &&
            evaluation.dailyMarkCount === evaluation.strategy.observations &&
            evaluation.benchmarkSeriesCounts.buyAndHold === buyAndHoldSeries.items.length &&
            evaluation.benchmarkSeriesCounts.directVolTiming === directVolatilitySeries.items.length &&
            evaluation.benchmarkSeriesCounts.doubleCostStrategy === doubleCostSeries.items.length &&
            [buyAndHoldSeries.items, directVolatilitySeries.items, doubleCostSeries.items].every(
              (series) =>
                series.length === candidateDates.length &&
                series.every((point, index) => point.sessionDate === candidateDates[index]),
            ) &&
            evaluation.markedEquityReconciliation.runId === runId &&
            canonicalHashV1(evaluation.markedEquityReconciliation) === canonicalHashV1(markedEquity) &&
            canonicalHashV1(evaluation.strategy) === artifacts.get('strategy')!.contentHash &&
            canonicalHashV1(evaluation.buyAndHold) === artifacts.get('buy-and-hold')!.contentHash &&
            canonicalHashV1(evaluation.directVolTiming) === artifacts.get('direct-volatility-timing')!.contentHash &&
            canonicalHashV1(evaluation.doubleCostStrategy) === artifacts.get('double-cost-strategy')!.contentHash &&
            stored.gates.length === evaluation.verdict.gates.length &&
            stored.gates.every(
              (gate, index) =>
                canonicalHashV1({
                  name: gate.name,
                  passed: gate.passed,
                  actual: gate.actual,
                  required: gate.required,
                }) === canonicalHashV1(evaluation.verdict.gates[index]),
            ) &&
            stored.events.every((event, index) => event.id === events[index].id && event.kind === events[index].kind) &&
            reconciliation.runId === runId &&
            markedEquity.runId === runId &&
            equitySeries.items.length === evaluation.dailyMarkCount &&
            canonicalHashV1(equityProof.reconciliation) === canonicalHashV1(markedEquity) &&
            canonicalHashV1(equityProof.equitySeries) === canonicalHashV1(equitySeries.items) &&
            finalPoint.evaluatorEquityMicros === markedEquity.evaluatorEndingEquityMicros &&
            finalPoint.reconstructedEquityMicros === markedEquity.reconstructedEndingEquityMicros &&
            finalPoint.differenceMicros === markedEquity.differenceMicros &&
            canonicalHashV1(artifactManifest) === canonicalHashV1(expectedArtifactManifest) &&
            canonicalHashV1(stored.statuses[1]?.detail) ===
              canonicalHashV1({ reconciliationExact: true, verdict: evaluation.verdict.status }),
          'recover-evidence',
          'stored v4 evidence components diverge',
        )

        return Option.some({
          evaluation,
          reconciliation,
          persistence: {
            runId,
            deduplicated: true,
            artifactCount: stored.run.artifactCount,
            eventCount: stored.run.eventCount,
            gateCount: stored.run.gateCount,
          },
        } satisfies RecoveredEvaluationEvidence)
      }),
    )

  const persist = (input: PersistEvaluationInput) =>
    runDatabase(
      'persist',
      Effect.gen(function* () {
        const plan = yield* Effect.try({
          try: () => makePersistencePlan(input),
          catch: (cause) => databaseError('invariant', 'plan', 'invalid evaluation persistence input', cause),
        })

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
            INSERT INTO bayn_status_history (run_id, status, detail)
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
              INSERT INTO bayn_evaluation_artifacts (
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
              INSERT INTO bayn_evaluation_events (
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
              INSERT INTO bayn_gate_outcomes (
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
            INSERT INTO bayn_status_history (run_id, status, detail)
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

export const PostgresClientLive = (config: RuntimeConfig) => {
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

const migrations = PgMigrator.run({ loader: migrationLoader, table: 'bayn_schema_migrations' }).pipe(
  Effect.mapError((cause) =>
    isSqlError(cause)
      ? classifyDatabaseError('migrate', cause)
      : databaseError('migration', 'migrate', 'PostgreSQL migration failed', cause),
  ),
  Effect.asVoid,
)

const MigrationLive = Layer.effectDiscard(migrations)
const EvidenceStoreLayer = Layer.effect(EvidenceStore, makeEvidenceStore)
const EvidenceStoreDatabaseLayer = Layer.merge(MigrationLive, EvidenceStoreLayer)

export const EvidenceStoreLive = (config: RuntimeConfig) =>
  EvidenceStoreDatabaseLayer.pipe(Layer.provideMerge(PostgresClientLive(config)))

export const EvidenceStoreRuntimeLive = (config: RuntimeConfig) =>
  EvidenceStoreDatabaseLayer.pipe(
    Layer.provide(PostgresClientLive(config)),
    Layer.catch((error) =>
      Layer.succeed(EvidenceStore, {
        check: Effect.fail(error),
        persist: () => Effect.fail(error),
        read: () => Effect.fail(error),
        readArtifactItems: () => Effect.fail(error),
        recover: () => Effect.fail(error),
        listPriorTrials: Effect.fail(error),
        openQualification: () => Effect.fail(error),
        readQualification: () => Effect.fail(error),
      }),
    ),
  )
