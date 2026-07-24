import { Result, Schema } from 'effect'

import { type FinalizedSnapshotProvenance, makeStrategyProtocolHash, type RuntimeProvenance } from '../contracts'
import {
  CashChangesArtifactSchema,
  DailyPerformanceSeriesArtifactSchema,
  DailyPositionMarksArtifactSchema,
  EquitySeriesArtifactSchema,
  EvaluationEventsSchema,
  EvaluationSummarySchema,
  InputManifestArtifactSchema,
  MarkedEquityReconciliationSchema,
  QualificationArtifactManifestSchema,
  ReconciliationResultSchema,
  RiskBalancedTrendSignalDecisionsArtifactSchema,
  SimulatedOrdersArtifactSchema,
} from '../evidence-contracts'
import { canonicalHashV1 } from '../hash'
import { buildLedgerPlan } from '../ledger-plan'
import { strictParseOptions } from '../schemas'
import {
  reconcileMarkedEquity,
  type MarkedEquityProof,
  type SimulationReconciliationIssue,
} from '../simulation-reconciliation'
import type {
  EconomicVerdict,
  EvaluationEvent,
  EvaluationSummary,
  InputManifest,
  Protocol,
  ReconciliationResult,
} from '../types'

export const evidenceRecoveryContract = {
  strategyName: 'risk-balanced-trend',
  evaluationSchemaVersion: 'bayn.evaluation.v6',
  summarySchemaVersion: 'bayn.evaluation-summary.v5',
  inputManifestSchemaVersion: 'bayn.input-manifest.v3',
  signalDecisionsArtifactName: 'risk-balanced-trend-decisions',
  signalDecisionsSchemaVersion: 'bayn.risk-balanced-trend-decisions.v1',
  artifacts: [
    { name: 'buy-and-hold', schemaVersion: 'bayn.performance-metrics.v2' },
    { name: 'buy-and-hold-series', schemaVersion: 'bayn.daily-performance-series.v1' },
    { name: 'cash-changes', schemaVersion: 'bayn.cash-changes.v2' },
    { name: 'daily-position-marks', schemaVersion: 'bayn.daily-position-marks.v3' },
    { name: 'direct-volatility-timing', schemaVersion: 'bayn.performance-metrics.v2' },
    { name: 'direct-volatility-timing-series', schemaVersion: 'bayn.daily-performance-series.v1' },
    { name: 'double-cost-strategy', schemaVersion: 'bayn.performance-metrics.v2' },
    { name: 'double-cost-strategy-series', schemaVersion: 'bayn.daily-performance-series.v1' },
    { name: 'equity-series', schemaVersion: 'bayn.equity-series.v1' },
    { name: 'evaluation-summary', schemaVersion: 'bayn.evaluation-summary.v5' },
    { name: 'input-manifest', schemaVersion: 'bayn.input-manifest.v3' },
    { name: 'marked-equity-reconciliation', schemaVersion: 'bayn.marked-equity-reconciliation.v2' },
    { name: 'qualification-artifact-manifest', schemaVersion: 'bayn.qualification-artifact-manifest.v1' },
    { name: 'reconciliation', schemaVersion: 'bayn.reconciliation.v1' },
    { name: 'risk-balanced-trend-decisions', schemaVersion: 'bayn.risk-balanced-trend-decisions.v1' },
    { name: 'simulated-orders', schemaVersion: 'bayn.simulated-orders.v2' },
    { name: 'strategy', schemaVersion: 'bayn.performance-metrics.v2' },
  ],
} as const

// Ledger identity changes record metadata, not the plan cardinality recovered here.
const cardinalityOnlyLedger = 1

export interface PersistenceReceipt {
  readonly runId: string
  readonly deduplicated: boolean
  readonly artifactCount: number
  readonly eventCount: number
  readonly gateCount: number
}

export interface StoredEvaluationEvidence {
  readonly protocol: {
    readonly protocolHash: string
    readonly schemaVersion: string
    readonly strategyName: string
    readonly behaviorHash: string
    readonly parameterHash: string
    readonly parameters: Protocol
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
  readonly artifacts: readonly StoredArtifact[]
  readonly events: readonly StoredEvent[]
  readonly gates: readonly StoredGate[]
  readonly statuses: readonly StoredStatus[]
}

export interface RecoveredEvaluationEvidence {
  readonly evaluation: EvaluationSummary
  readonly reconciliation: ReconciliationResult
  readonly persistence: PersistenceReceipt
}

interface StoredReceiptRow {
  readonly run_id: string
  readonly protocol_hash: string
  readonly snapshot_id: string
  readonly evaluation_schema_version: string
  readonly source_revision: string
  readonly image_repository: string
  readonly image_digest: string
  readonly strategy_name: string
  readonly initial_capital_micros: string
  readonly status: 'COMPLETE'
  readonly expected_artifact_count: number
  readonly expected_event_count: number
  readonly expected_gate_count: number
  readonly artifact_count: number
  readonly event_count: number
  readonly gate_count: number
}

interface StoredProtocolRow {
  readonly protocol_hash: string
  readonly schema_version: string
  readonly strategy_name: string
  readonly behavior_hash: string
  readonly parameter_hash: string
  readonly parameters: Protocol
}

interface StoredArtifactRow {
  readonly artifact_name: string
  readonly schema_version: string
  readonly content_hash: string
  readonly payload: unknown
}

interface StoredEventRow {
  readonly ordinal: number
  readonly event_id: string
  readonly event_kind: EvaluationEvent['kind']
  readonly content_hash: string
  readonly payload: EvaluationEvent
}

interface StoredGateRow {
  readonly ordinal: number
  readonly gate_name: string
  readonly passed: boolean
  readonly actual: EconomicVerdict['gates'][number]['actual']
  readonly required: EconomicVerdict['gates'][number]['required']
  readonly content_hash: string
}

type StoredStatus =
  | {
      readonly status: 'WRITING'
      readonly detail: { readonly artifactCount: number; readonly eventCount: number; readonly gateCount: number }
    }
  | {
      readonly status: 'COMPLETE'
      readonly detail: { readonly reconciliationExact: true; readonly verdict: 'PASS' | 'FAIL_CLOSED' }
    }

export interface StoredEvidenceRows {
  readonly receipts: readonly StoredReceiptRow[]
  readonly protocol: StoredProtocolRow
  readonly artifacts: readonly StoredArtifactRow[]
  readonly events: readonly StoredEventRow[]
  readonly gates: readonly StoredGateRow[]
  readonly statuses: readonly StoredStatus[]
}

interface StoredSnapshotRow {
  readonly snapshot_id: string
  readonly schema_version: 'bayn.finalized-snapshot.v3'
  readonly database_name: 'signal'
  readonly table_name: 'adjusted_daily_bars_v2'
  readonly dataset_version: 'signal.adjusted-daily-snapshot.v2'
  readonly source: 'alpaca'
  readonly source_feed: 'sip'
  readonly adjustment: 'all'
  readonly content_hash: string
  readonly row_count: number
  readonly first_session: string
  readonly last_session: string
  readonly manifest: FinalizedSnapshotProvenance
}

interface StoredArtifact {
  readonly name: string
  readonly schemaVersion: string
  readonly contentHash: string
  readonly payload: unknown
}

interface StoredEvent {
  readonly ordinal: number
  readonly id: string
  readonly kind: EvaluationEvent['kind']
  readonly contentHash: string
  readonly payload: EvaluationEvent
}

interface StoredGate {
  readonly ordinal: number
  readonly name: string
  readonly passed: boolean
  readonly actual: EconomicVerdict['gates'][number]['actual']
  readonly required: EconomicVerdict['gates'][number]['required']
  readonly contentHash: string
}

type ArtifactSetProblem =
  | {
      readonly _tag: 'DuplicateArtifact'
      readonly name: string
      readonly observedCount: number
      readonly expectedCount: 1
    }
  | { readonly _tag: 'MissingArtifact'; readonly name: string; readonly expectedSchemaVersion: string }
  | { readonly _tag: 'ExtraArtifact'; readonly name: string; readonly observedSchemaVersion: string }
  | {
      readonly _tag: 'WrongArtifactSchema'
      readonly name: string
      readonly observedSchemaVersion: string
      readonly expectedSchemaVersion: string
    }

type RecoveryCanonicalizationOperation =
  | 'artifact-manifest-expected'
  | 'artifact-manifest-observed'
  | 'evaluation-bounds'
  | 'evaluation-input-symbols'
  | 'evaluation-marked-equity'
  | 'evaluation-metric'
  | 'gate-outcome'
  | 'marked-equity-proof'
  | 'protocol-execution-model'
  | 'protocol-parameters'
  | 'recovered-equity-series'
  | 'runtime-protocol-hash'
  | 'signal-target-weights'
  | 'snapshot-manifest'
  | 'stored-artifact-payload'
  | 'stored-event-payload'
  | 'stored-gate-payload'
  | 'stored-protocol-parameters'
  | 'stored-writing-status'

type RecoveryMismatchStage =
  | 'components'
  | 'contract'
  | 'manifest'
  | 'protocol'
  | 'reconciliation'
  | 'runtime'
  | 'snapshot'
  | 'status'
  | 'stored-graph'

type RecoveryPath = readonly [string, ...(number | string)[]]

export type EvidenceRecoveryIssue =
  | {
      readonly _tag: 'RecoveryMismatch'
      readonly stage: RecoveryMismatchStage
      readonly path: RecoveryPath
      readonly observed: unknown
      readonly expected: unknown
    }
  | { readonly _tag: 'ArtifactSetFailure'; readonly problem: ArtifactSetProblem }
  | {
      readonly _tag: 'DecodeFailure'
      readonly artifactName: string
      readonly schemaVersion: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CanonicalizationFailure'
      readonly operation: RecoveryCanonicalizationOperation
      readonly subject?: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'SimulationFailure'
      readonly issues: readonly SimulationReconciliationIssue[]
    }
  | {
      readonly _tag: 'ComputationFailure'
      readonly operation: 'build-ledger-plan'
      readonly cause: unknown
    }

interface ValidatedStoredGraph {
  readonly receipt: StoredReceiptRow
  readonly rows: StoredEvidenceRows
}

type ArtifactIndex = ReadonlyMap<string, StoredArtifact>

interface InitialDecodedArtifacts {
  readonly evaluation: typeof EvaluationSummarySchema.Type
  readonly reconciliation: typeof ReconciliationResultSchema.Type
  readonly markedEquity: typeof MarkedEquityReconciliationSchema.Type
  readonly equitySeries: typeof EquitySeriesArtifactSchema.Type
  readonly events: typeof EvaluationEventsSchema.Type
  readonly orders: typeof SimulatedOrdersArtifactSchema.Type
  readonly signalDecisions: typeof RiskBalancedTrendSignalDecisionsArtifactSchema.Type
  readonly buyAndHoldSeries: typeof DailyPerformanceSeriesArtifactSchema.Type
  readonly directVolatilitySeries: typeof DailyPerformanceSeriesArtifactSchema.Type
  readonly doubleCostSeries: typeof DailyPerformanceSeriesArtifactSchema.Type
  readonly artifactManifest: typeof QualificationArtifactManifestSchema.Type
}

interface RemainingDecodedArtifacts {
  readonly cashChanges: typeof CashChangesArtifactSchema.Type
  readonly dailyMarks: typeof DailyPositionMarksArtifactSchema.Type
  readonly inputManifest: typeof InputManifestArtifactSchema.Type
}

interface PreparedEvidenceRecovery {
  readonly runId: string
  readonly provenance: RuntimeProvenance
  readonly stored: StoredEvaluationEvidence
  readonly artifacts: ArtifactIndex
  readonly decoded: InitialDecodedArtifacts & RemainingDecodedArtifacts
}

const decodeEvaluationSummary = Schema.decodeUnknownResult(EvaluationSummarySchema, strictParseOptions)
const decodeReconciliationResult = Schema.decodeUnknownResult(ReconciliationResultSchema, strictParseOptions)
const decodeMarkedEquityReconciliation = Schema.decodeUnknownResult(
  MarkedEquityReconciliationSchema,
  strictParseOptions,
)
const decodeEquitySeriesArtifact = Schema.decodeUnknownResult(EquitySeriesArtifactSchema, strictParseOptions)
const decodeEvaluationEvents = Schema.decodeUnknownResult(EvaluationEventsSchema, strictParseOptions)
const decodeSimulatedOrdersArtifact = Schema.decodeUnknownResult(SimulatedOrdersArtifactSchema, strictParseOptions)
const decodeSignalDecisionsArtifact = Schema.decodeUnknownResult(
  RiskBalancedTrendSignalDecisionsArtifactSchema,
  strictParseOptions,
)
const decodeDailyPerformanceSeriesArtifact = Schema.decodeUnknownResult(
  DailyPerformanceSeriesArtifactSchema,
  strictParseOptions,
)
const decodeQualificationArtifactManifest = Schema.decodeUnknownResult(
  QualificationArtifactManifestSchema,
  strictParseOptions,
)
const decodeCashChangesArtifact = Schema.decodeUnknownResult(CashChangesArtifactSchema, strictParseOptions)
const decodeDailyPositionMarksArtifact = Schema.decodeUnknownResult(
  DailyPositionMarksArtifactSchema,
  strictParseOptions,
)
const decodeInputManifestArtifact = Schema.decodeUnknownResult(InputManifestArtifactSchema, strictParseOptions)

const recoveryFailure = (issue: EvidenceRecoveryIssue): Result.Result<never, EvidenceRecoveryIssue> =>
  Result.fail(issue)

const mismatch = (
  stage: RecoveryMismatchStage,
  path: RecoveryPath,
  observed: unknown,
  expected: unknown,
): Result.Result<never, EvidenceRecoveryIssue> =>
  recoveryFailure({ _tag: 'RecoveryMismatch', stage, path, observed, expected })

const canonicalize = <A>(
  operation: RecoveryCanonicalizationOperation,
  compute: () => A,
  subject?: string,
): Result.Result<A, EvidenceRecoveryIssue> =>
  Result.try({
    try: compute,
    catch: (cause): EvidenceRecoveryIssue => ({
      _tag: 'CanonicalizationFailure',
      operation,
      ...(subject === undefined ? {} : { subject }),
      cause,
    }),
  })

const canonicalHash = (
  operation: RecoveryCanonicalizationOperation,
  value: unknown,
  subject?: string,
): Result.Result<string, EvidenceRecoveryIssue> => canonicalize(operation, () => canonicalHashV1(value), subject)

const validateStoredReceipt = (
  runId: string,
  receipts: readonly StoredReceiptRow[],
): Result.Result<StoredReceiptRow, EvidenceRecoveryIssue> => {
  if (receipts.length !== 1) {
    return mismatch('stored-graph', ['runs', runId, 'receiptCount'], receipts.length, 1)
  }
  const receipt = receipts[0]
  if (receipt === undefined) return mismatch('stored-graph', ['runs', runId, 'receiptCount'], 0, 1)
  return Result.succeed(receipt)
}

const validateStoredProtocol = (
  rows: StoredEvidenceRows,
  receipt: StoredReceiptRow,
): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    if (rows.protocol.protocol_hash !== receipt.protocol_hash) {
      return yield* mismatch(
        'stored-graph',
        ['protocol', 'protocolHash'],
        rows.protocol.protocol_hash,
        receipt.protocol_hash,
      )
    }
    if (rows.protocol.strategy_name !== receipt.strategy_name) {
      return yield* mismatch(
        'stored-graph',
        ['protocol', 'strategyName'],
        rows.protocol.strategy_name,
        receipt.strategy_name,
      )
    }
    const parameterHash = yield* canonicalHash(
      'stored-protocol-parameters',
      rows.protocol.parameters,
      rows.protocol.protocol_hash,
    )
    if (rows.protocol.parameter_hash !== parameterHash) {
      return yield* mismatch('stored-graph', ['protocol', 'parameterHash'], rows.protocol.parameter_hash, parameterHash)
    }
  })

const validateStoredCounts = (
  rows: StoredEvidenceRows,
  receipt: StoredReceiptRow,
): Result.Result<void, EvidenceRecoveryIssue> => {
  const collections = [
    ['artifacts', rows.artifacts.length, receipt.artifact_count, receipt.expected_artifact_count],
    ['events', rows.events.length, receipt.event_count, receipt.expected_event_count],
    ['gates', rows.gates.length, receipt.gate_count, receipt.expected_gate_count],
  ] as const
  for (const [name, loaded, recorded, expected] of collections) {
    if (loaded !== expected || loaded !== recorded) {
      return mismatch(
        'stored-graph',
        [name, 'count'],
        { loadedCount: loaded, receiptCount: recorded },
        { loadedCount: expected, receiptCount: expected },
      )
    }
  }
  return Result.void
}

const validateStoredArtifacts = (rows: StoredEvidenceRows): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    for (const artifact of rows.artifacts) {
      const expectedHash = yield* canonicalHash('stored-artifact-payload', artifact.payload, artifact.artifact_name)
      if (artifact.content_hash !== expectedHash) {
        return yield* mismatch(
          'stored-graph',
          ['artifacts', artifact.artifact_name, 'contentHash'],
          artifact.content_hash,
          expectedHash,
        )
      }
    }
  })

const validateStoredEvents = (rows: StoredEvidenceRows): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    for (const [index, event] of rows.events.entries()) {
      if (event.ordinal !== index) {
        return yield* mismatch('stored-graph', ['events', event.event_id, 'ordinal'], event.ordinal, index)
      }
      const expectedHash = yield* canonicalHash('stored-event-payload', event.payload, event.event_id)
      if (event.content_hash !== expectedHash) {
        return yield* mismatch(
          'stored-graph',
          ['events', event.event_id, 'contentHash'],
          event.content_hash,
          expectedHash,
        )
      }
    }
  })

const validateStoredGates = (rows: StoredEvidenceRows): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    for (const [index, gate] of rows.gates.entries()) {
      if (gate.ordinal !== index) {
        return yield* mismatch('stored-graph', ['gates', gate.gate_name, 'ordinal'], gate.ordinal, index)
      }
      const expectedHash = yield* canonicalHash(
        'stored-gate-payload',
        { name: gate.gate_name, passed: gate.passed, actual: gate.actual, required: gate.required },
        gate.gate_name,
      )
      if (gate.content_hash !== expectedHash) {
        return yield* mismatch(
          'stored-graph',
          ['gates', gate.gate_name, 'contentHash'],
          gate.content_hash,
          expectedHash,
        )
      }
    }
  })

const validateStoredStatuses = (
  runId: string,
  rows: StoredEvidenceRows,
  receipt: StoredReceiptRow,
): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    if (rows.statuses.length !== 2) {
      return yield* mismatch('stored-graph', ['statuses', 'count'], rows.statuses.length, 2)
    }
    const writing = rows.statuses[0]
    const complete = rows.statuses[1]
    if (writing?.status !== 'WRITING') {
      return yield* mismatch('stored-graph', ['statuses', 0, 'status'], writing?.status, 'WRITING')
    }
    const expectedDetail = {
      artifactCount: receipt.artifact_count,
      eventCount: receipt.event_count,
      gateCount: receipt.gate_count,
    }
    const writingHash = yield* canonicalHash('stored-writing-status', writing.detail, runId)
    const expectedHash = yield* canonicalHash('stored-writing-status', expectedDetail, runId)
    if (writingHash !== expectedHash) {
      return yield* mismatch('stored-graph', ['statuses', 0, 'detail'], writing.detail, expectedDetail)
    }
    if (complete?.status !== 'COMPLETE') {
      return yield* mismatch('stored-graph', ['statuses', 1, 'status'], complete?.status, 'COMPLETE')
    }
  })

const validateStoredGraph = (
  runId: string,
  rows: StoredEvidenceRows,
): Result.Result<ValidatedStoredGraph, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const receipt = yield* validateStoredReceipt(runId, rows.receipts)
    yield* validateStoredProtocol(rows, receipt)
    yield* validateStoredCounts(rows, receipt)
    yield* validateStoredArtifacts(rows)
    yield* validateStoredEvents(rows)
    yield* validateStoredGates(rows)
    yield* validateStoredStatuses(runId, rows, receipt)
    return { receipt, rows }
  })

const toStoredEvidence = (graph: ValidatedStoredGraph): StoredEvaluationEvidence => {
  const { receipt, rows } = graph
  return {
    protocol: {
      protocolHash: rows.protocol.protocol_hash,
      schemaVersion: rows.protocol.schema_version,
      strategyName: rows.protocol.strategy_name,
      behaviorHash: rows.protocol.behavior_hash,
      parameterHash: rows.protocol.parameter_hash,
      parameters: rows.protocol.parameters,
    },
    run: {
      runId: receipt.run_id,
      protocolHash: receipt.protocol_hash,
      snapshotId: receipt.snapshot_id,
      evaluationSchemaVersion: receipt.evaluation_schema_version,
      sourceRevision: receipt.source_revision,
      imageRepository: receipt.image_repository,
      imageDigest: receipt.image_digest,
      strategyName: receipt.strategy_name,
      initialCapitalMicros: receipt.initial_capital_micros,
      artifactCount: receipt.artifact_count,
      eventCount: receipt.event_count,
      gateCount: receipt.gate_count,
    },
    artifacts: rows.artifacts.map((artifact) => ({
      name: artifact.artifact_name,
      schemaVersion: artifact.schema_version,
      contentHash: artifact.content_hash,
      payload: artifact.payload,
    })),
    events: rows.events.map((event) => ({
      ordinal: event.ordinal,
      id: event.event_id,
      kind: event.event_kind,
      contentHash: event.content_hash,
      payload: event.payload,
    })),
    gates: rows.gates.map((gate) => ({
      ordinal: gate.ordinal,
      name: gate.gate_name,
      passed: gate.passed,
      actual: gate.actual,
      required: gate.required,
      contentHash: gate.content_hash,
    })),
    statuses: rows.statuses,
  }
}

export const validateStoredEvidence = (
  runId: string,
  rows: StoredEvidenceRows,
): Result.Result<StoredEvaluationEvidence, EvidenceRecoveryIssue> =>
  Result.andThen(validateStoredGraph(runId, rows), toStoredEvidence)

const validateEvidenceContract = (stored: StoredEvaluationEvidence): Result.Result<void, EvidenceRecoveryIssue> => {
  if (stored.run.strategyName !== evidenceRecoveryContract.strategyName) {
    return mismatch('contract', ['strategyName'], stored.run.strategyName, evidenceRecoveryContract.strategyName)
  }
  if (stored.run.evaluationSchemaVersion !== evidenceRecoveryContract.evaluationSchemaVersion) {
    return mismatch(
      'contract',
      ['evaluationSchemaVersion'],
      stored.run.evaluationSchemaVersion,
      evidenceRecoveryContract.evaluationSchemaVersion,
    )
  }
  return Result.void
}

const validateArtifactSet = (
  artifacts: readonly StoredArtifact[],
): Result.Result<ArtifactIndex, EvidenceRecoveryIssue> => {
  const artifactIndex = new Map<string, StoredArtifact>()
  const artifactCounts = new Map<string, number>()
  for (const artifact of artifacts) {
    const observedCount = (artifactCounts.get(artifact.name) ?? 0) + 1
    artifactCounts.set(artifact.name, observedCount)
    if (observedCount > 1) {
      return recoveryFailure({
        _tag: 'ArtifactSetFailure',
        problem: { _tag: 'DuplicateArtifact', name: artifact.name, observedCount, expectedCount: 1 },
      })
    }
    artifactIndex.set(artifact.name, artifact)
  }

  for (const required of evidenceRecoveryContract.artifacts) {
    if (!artifactIndex.has(required.name)) {
      return recoveryFailure({
        _tag: 'ArtifactSetFailure',
        problem: {
          _tag: 'MissingArtifact',
          name: required.name,
          expectedSchemaVersion: required.schemaVersion,
        },
      })
    }
  }
  for (const artifact of artifacts) {
    if (!evidenceRecoveryContract.artifacts.some((required) => required.name === artifact.name)) {
      return recoveryFailure({
        _tag: 'ArtifactSetFailure',
        problem: {
          _tag: 'ExtraArtifact',
          name: artifact.name,
          observedSchemaVersion: artifact.schemaVersion,
        },
      })
    }
  }
  for (const required of evidenceRecoveryContract.artifacts) {
    const artifact = artifactIndex.get(required.name)
    if (artifact !== undefined && artifact.schemaVersion !== required.schemaVersion) {
      return recoveryFailure({
        _tag: 'ArtifactSetFailure',
        problem: {
          _tag: 'WrongArtifactSchema',
          name: required.name,
          observedSchemaVersion: artifact.schemaVersion,
          expectedSchemaVersion: required.schemaVersion,
        },
      })
    }
  }
  return Result.succeed(artifactIndex)
}

const validateRuntimeIdentity = (
  runId: string,
  provenance: RuntimeProvenance,
  stored: StoredEvaluationEvidence,
): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const facts = [
      ['runId', stored.run.runId, runId],
      ['evaluationSchemaVersion', stored.run.evaluationSchemaVersion, provenance.contractVersions.evaluation],
      ['sourceRevision', stored.run.sourceRevision, provenance.sourceRevision],
      ['imageRepository', stored.run.imageRepository, provenance.image.repository],
      ['imageDigest', stored.run.imageDigest, provenance.image.digest],
      ['strategyName', stored.run.strategyName, provenance.strategy.name],
    ] as const
    for (const [path, observed, expected] of facts) {
      if (observed !== expected) return yield* mismatch('runtime', [path], observed, expected)
    }
    const protocolHash = yield* canonicalize(
      'runtime-protocol-hash',
      () => makeStrategyProtocolHash(provenance.strategy),
      runId,
    )
    if (stored.run.protocolHash !== protocolHash) {
      return yield* mismatch('runtime', ['protocolHash'], stored.run.protocolHash, protocolHash)
    }
  })

const requiredArtifact = (
  artifacts: ArtifactIndex,
  name: string,
): Result.Result<StoredArtifact, EvidenceRecoveryIssue> => {
  const artifact = artifacts.get(name)
  if (artifact !== undefined) return Result.succeed(artifact)
  const required = evidenceRecoveryContract.artifacts.find((candidate) => candidate.name === name)
  return recoveryFailure({
    _tag: 'ArtifactSetFailure',
    problem: {
      _tag: 'MissingArtifact',
      name,
      expectedSchemaVersion: required?.schemaVersion ?? 'unknown',
    },
  })
}

const decodePayload = <A>(
  artifactName: string,
  schemaVersion: string,
  payload: unknown,
  decoder: (input: unknown) => Result.Result<A, unknown>,
): Result.Result<A, EvidenceRecoveryIssue> => {
  const attempted = Result.try({
    try: () => decoder(payload),
    catch: (cause): EvidenceRecoveryIssue => ({
      _tag: 'DecodeFailure',
      artifactName,
      schemaVersion,
      cause,
    }),
  })
  return Result.andThen(attempted, (decoded) =>
    Result.mapError(
      decoded,
      (cause): EvidenceRecoveryIssue => ({
        _tag: 'DecodeFailure',
        artifactName,
        schemaVersion,
        cause,
      }),
    ),
  )
}

const decodeArtifact = <A>(
  artifacts: ArtifactIndex,
  name: string,
  decoder: (input: unknown) => Result.Result<A, unknown>,
): Result.Result<A, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const artifact = yield* requiredArtifact(artifacts, name)
    return yield* decodePayload(artifact.name, artifact.schemaVersion, artifact.payload, decoder)
  })

const decodeCoreArtifacts = (stored: StoredEvaluationEvidence, artifacts: ArtifactIndex) =>
  Result.gen(function* () {
    const evaluation = yield* decodeArtifact(artifacts, 'evaluation-summary', decodeEvaluationSummary)
    const reconciliation = yield* decodeArtifact(artifacts, 'reconciliation', decodeReconciliationResult)
    const markedEquity = yield* decodeArtifact(
      artifacts,
      'marked-equity-reconciliation',
      decodeMarkedEquityReconciliation,
    )
    const equitySeries = yield* decodeArtifact(artifacts, 'equity-series', decodeEquitySeriesArtifact)
    const events = yield* decodePayload(
      'evaluation-events',
      'bayn.evaluation-event.v1[]',
      stored.events.map((event) => event.payload),
      decodeEvaluationEvents,
    )
    return { evaluation, reconciliation, markedEquity, equitySeries, events }
  })

const decodeExecutionArtifacts = (artifacts: ArtifactIndex) =>
  Result.gen(function* () {
    const orders = yield* decodeArtifact(artifacts, 'simulated-orders', decodeSimulatedOrdersArtifact)
    const signalDecisions = yield* decodeArtifact(
      artifacts,
      evidenceRecoveryContract.signalDecisionsArtifactName,
      decodeSignalDecisionsArtifact,
    )
    return { orders, signalDecisions }
  })

const decodeSeriesArtifacts = (artifacts: ArtifactIndex) =>
  Result.gen(function* () {
    const buyAndHoldSeries = yield* decodeArtifact(
      artifacts,
      'buy-and-hold-series',
      decodeDailyPerformanceSeriesArtifact,
    )
    const directVolatilitySeries = yield* decodeArtifact(
      artifacts,
      'direct-volatility-timing-series',
      decodeDailyPerformanceSeriesArtifact,
    )
    const doubleCostSeries = yield* decodeArtifact(
      artifacts,
      'double-cost-strategy-series',
      decodeDailyPerformanceSeriesArtifact,
    )
    return { buyAndHoldSeries, directVolatilitySeries, doubleCostSeries }
  })

const decodeInitialArtifacts = (
  stored: StoredEvaluationEvidence,
  artifacts: ArtifactIndex,
): Result.Result<InitialDecodedArtifacts, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const core = yield* decodeCoreArtifacts(stored, artifacts)
    const execution = yield* decodeExecutionArtifacts(artifacts)
    const series = yield* decodeSeriesArtifacts(artifacts)
    const artifactManifest = yield* decodeArtifact(
      artifacts,
      'qualification-artifact-manifest',
      decodeQualificationArtifactManifest,
    )
    return { ...core, ...execution, ...series, artifactManifest }
  })

const validateProtocolExecutionLock = (
  provenance: RuntimeProvenance,
  stored: StoredEvaluationEvidence,
  orders: typeof SimulatedOrdersArtifactSchema.Type,
): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const facts = [
      ['parameterSchemaVersion', stored.protocol.schemaVersion, provenance.strategy.parameterSchemaVersion],
      ['strategyName', stored.protocol.strategyName, provenance.strategy.name],
      ['behaviorHash', stored.protocol.behaviorHash, provenance.strategy.behaviorHash],
      ['parameterHash', stored.protocol.parameterHash, provenance.strategy.parameterHash],
    ] as const
    for (const [path, observed, expected] of facts) {
      if (observed !== expected) return yield* mismatch('protocol', [path], observed, expected)
    }
    const parameterHash = yield* canonicalHash('protocol-parameters', stored.protocol.parameters, stored.run.runId)
    if (parameterHash !== provenance.strategy.parameterHash) {
      return yield* mismatch('protocol', ['parameterHash'], parameterHash, provenance.strategy.parameterHash)
    }
    const protocolExecutionHash = yield* canonicalHash(
      'protocol-execution-model',
      stored.protocol.parameters.executionModel,
      stored.run.runId,
    )
    const ordersExecutionHash = yield* canonicalHash(
      'protocol-execution-model',
      orders.executionModel,
      'simulated-orders',
    )
    if (protocolExecutionHash !== ordersExecutionHash) {
      return yield* mismatch('protocol', ['executionModelHash'], ordersExecutionHash, protocolExecutionHash)
    }
    if (orders.costMultiplierMicros !== '1000000') {
      return yield* mismatch('protocol', ['costMultiplierMicros'], orders.costMultiplierMicros, '1000000')
    }
  })

const decodeRemainingArtifacts = (
  artifacts: ArtifactIndex,
): Result.Result<RemainingDecodedArtifacts, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const cashChanges = yield* decodeArtifact(artifacts, 'cash-changes', decodeCashChangesArtifact)
    const dailyMarks = yield* decodeArtifact(artifacts, 'daily-position-marks', decodeDailyPositionMarksArtifact)
    const inputManifest = yield* decodeArtifact(artifacts, 'input-manifest', decodeInputManifestArtifact)
    return { cashChanges, dailyMarks, inputManifest }
  })

type ManifestArtifactName = Exclude<
  (typeof evidenceRecoveryContract.artifacts)[number]['name'],
  'qualification-artifact-manifest'
>

const collectManifestArtifacts = (
  artifacts: ArtifactIndex,
  decoded: InitialDecodedArtifacts & RemainingDecodedArtifacts,
): Result.Result<
  readonly {
    readonly name: string
    readonly schemaVersion: string
    readonly itemCount: number
    readonly contentHash: string
  }[],
  EvidenceRecoveryIssue
> =>
  Result.gen(function* () {
    const itemCounts: Readonly<Record<ManifestArtifactName, number>> = {
      'buy-and-hold': 0,
      'buy-and-hold-series': decoded.buyAndHoldSeries.items.length,
      'cash-changes': decoded.cashChanges.items.length,
      'daily-position-marks': decoded.dailyMarks.items.length,
      'direct-volatility-timing': 0,
      'direct-volatility-timing-series': decoded.directVolatilitySeries.items.length,
      'double-cost-strategy': 0,
      'double-cost-strategy-series': decoded.doubleCostSeries.items.length,
      'equity-series': decoded.equitySeries.items.length,
      'evaluation-summary': 0,
      'input-manifest': 0,
      'marked-equity-reconciliation': 0,
      reconciliation: 0,
      'risk-balanced-trend-decisions': decoded.signalDecisions.items.length,
      'simulated-orders': decoded.orders.items.length,
      strategy: 0,
    }
    const references = []
    for (const required of evidenceRecoveryContract.artifacts) {
      if (required.name === 'qualification-artifact-manifest') continue
      const artifact = yield* requiredArtifact(artifacts, required.name)
      references.push({
        name: artifact.name,
        schemaVersion: artifact.schemaVersion,
        itemCount: itemCounts[required.name],
        contentHash: artifact.contentHash,
      })
    }
    return references
  })

const validateArtifactManifest = (
  runId: string,
  stored: StoredEvaluationEvidence,
  artifacts: ArtifactIndex,
  decoded: InitialDecodedArtifacts & RemainingDecodedArtifacts,
): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const manifestArtifacts = yield* collectManifestArtifacts(artifacts, decoded)
    const eventReferencesHash = yield* canonicalHash(
      'artifact-manifest-expected',
      stored.events.map(({ ordinal, id, kind, contentHash }) => ({ ordinal, id, kind, contentHash })),
      'events',
    )
    const gateReferencesHash = yield* canonicalHash(
      'artifact-manifest-expected',
      stored.gates.map(({ ordinal, name, passed, contentHash }) => ({ ordinal, name, passed, contentHash })),
      'gates',
    )
    const expected = {
      schemaVersion: 'bayn.qualification-artifact-manifest.v1',
      identity: {
        runId,
        evaluationSchemaVersion: decoded.evaluation.evaluationSchemaVersion,
        protocolHash: stored.run.protocolHash,
        sourceRevision: stored.run.sourceRevision,
        image: { repository: stored.run.imageRepository, digest: stored.run.imageDigest },
        snapshotId: stored.run.snapshotId,
        publicationId: decoded.inputManifest.finalizedSnapshot.publicationId,
        inputManifestHash: decoded.inputManifest.hash,
        bounds: decoded.inputManifest.bounds,
        calendarVersion: decoded.inputManifest.finalizedSnapshot.calendarVersion,
      },
      execution: {
        parameterSchemaVersion: stored.protocol.schemaVersion,
        parameterHash: stored.protocol.parameterHash,
        simulationSchemaVersion: 'bayn.simulation-trace.v3',
        executionModel: decoded.orders.executionModel,
        costMultiplierMicros: decoded.orders.costMultiplierMicros,
      },
      artifacts: manifestArtifacts,
      events: { count: stored.events.length, contentHash: eventReferencesHash },
      gates: { count: stored.gates.length, contentHash: gateReferencesHash },
    }
    const observedHash = yield* canonicalHash(
      'artifact-manifest-observed',
      decoded.artifactManifest,
      'qualification-artifact-manifest',
    )
    const expectedHash = yield* canonicalHash('artifact-manifest-expected', expected, 'qualification-artifact-manifest')
    if (observedHash !== expectedHash) {
      return yield* mismatch('manifest', ['qualificationArtifactManifest'], observedHash, expectedHash)
    }
  })

export const prepareEvidenceRecovery = (input: {
  readonly runId: string
  readonly provenance: RuntimeProvenance
  readonly rows: StoredEvidenceRows
}): Result.Result<PreparedEvidenceRecovery, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const graph = yield* validateStoredGraph(input.runId, input.rows)
    const stored = toStoredEvidence(graph)
    yield* validateEvidenceContract(stored)
    const artifacts = yield* validateArtifactSet(stored.artifacts)
    yield* validateRuntimeIdentity(input.runId, input.provenance, stored)
    const initialDecoded = yield* decodeInitialArtifacts(stored, artifacts)
    yield* validateProtocolExecutionLock(input.provenance, stored, initialDecoded.orders)
    const remainingDecoded = yield* decodeRemainingArtifacts(artifacts)
    const decoded = { ...initialDecoded, ...remainingDecoded }
    yield* validateArtifactManifest(input.runId, stored, artifacts, decoded)
    return { runId: input.runId, provenance: input.provenance, stored, artifacts, decoded }
  })

const validateSnapshotReference = (
  row: StoredSnapshotRow,
  inputManifest: InputManifest,
): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const snapshot = inputManifest.finalizedSnapshot
    const facts = [
      ['snapshotId', row.snapshot_id, snapshot.snapshotId],
      ['schemaVersion', row.schema_version, snapshot.schemaVersion],
      ['databaseName', row.database_name, inputManifest.database],
      ['tableName', row.table_name, inputManifest.tables.bars],
      ['datasetVersion', row.dataset_version, snapshot.publicationSchemaVersion],
      ['source', row.source, snapshot.source],
      ['sourceFeed', row.source_feed, snapshot.sourceFeed],
      ['adjustment', row.adjustment, snapshot.adjustment],
      ['contentHash', row.content_hash, snapshot.contentHash],
      ['rowCount', row.row_count, snapshot.rowCount],
      ['firstSession', row.first_session, snapshot.firstSession],
      ['lastSession', row.last_session, snapshot.lastSession],
    ] as const
    for (const [path, observed, expected] of facts) {
      if (observed !== expected) return yield* mismatch('snapshot', [path], observed, expected)
    }
    const observedManifestHash = yield* canonicalHash('snapshot-manifest', row.manifest, 'stored')
    const expectedManifestHash = yield* canonicalHash('snapshot-manifest', snapshot, 'input-manifest')
    if (observedManifestHash !== expectedManifestHash) {
      return yield* mismatch('snapshot', ['manifestHash'], observedManifestHash, expectedManifestHash)
    }
  })

const reconcileRecoveredEvidence = (
  prepared: PreparedEvidenceRecovery,
): Result.Result<MarkedEquityProof, EvidenceRecoveryIssue> => {
  const { decoded } = prepared
  return Result.mapError(
    reconcileMarkedEquity({
      runId: prepared.runId,
      initialCapitalMicros: decoded.evaluation.initialCapitalMicros,
      evaluatorTotalFeesMicros: decoded.evaluation.strategy.totalFeesMicros,
      evaluatorEndingEquityMicros: decoded.evaluation.strategy.endingEquityMicros,
      events: decoded.events,
      simulation: {
        schemaVersion: 'bayn.simulation-trace.v3',
        executionModel: decoded.orders.executionModel,
        costMultiplierMicros: decoded.orders.costMultiplierMicros,
        orders: decoded.orders.items,
        cashChanges: decoded.cashChanges.items,
        dailyMarks: decoded.dailyMarks.items,
      },
    }),
    (issues): EvidenceRecoveryIssue => ({ _tag: 'SimulationFailure', issues }),
  )
}

const componentMismatch = (
  path: RecoveryPath,
  observed: unknown,
  expected: unknown,
): Result.Result<never, EvidenceRecoveryIssue> => mismatch('components', path, observed, expected)

const validateReconciliationShape = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const { reconciliation } = prepared.decoded
    if (reconciliation.runId !== prepared.runId) {
      return yield* mismatch('reconciliation', ['runId'], reconciliation.runId, prepared.runId)
    }
    const ledgerPlan = yield* Result.try({
      try: () =>
        buildLedgerPlan(
          {
            runId: prepared.runId,
            initialCapitalMicros: prepared.decoded.evaluation.initialCapitalMicros,
            inputManifest: prepared.decoded.inputManifest,
            events: prepared.decoded.events,
          },
          cardinalityOnlyLedger,
        ),
      catch: (cause): EvidenceRecoveryIssue => ({
        _tag: 'ComputationFailure',
        operation: 'build-ledger-plan',
        cause,
      }),
    })
    if (reconciliation.accountCount !== ledgerPlan.accounts.length) {
      return yield* mismatch(
        'reconciliation',
        ['accountCount'],
        reconciliation.accountCount,
        ledgerPlan.accounts.length,
      )
    }
    if (reconciliation.transferCount !== ledgerPlan.transfers.length) {
      return yield* mismatch(
        'reconciliation',
        ['transferCount'],
        reconciliation.transferCount,
        ledgerPlan.transfers.length,
      )
    }
  })

const validateEvaluationIdentity = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const { evaluation, inputManifest } = prepared.decoded
    const facts = [
      [['evaluation', 'runId'], evaluation.runId, prepared.runId],
      [['evaluation', 'codeRevision'], evaluation.codeRevision, prepared.provenance.sourceRevision],
      [['evaluation', 'protocolHash'], evaluation.protocolHash, prepared.stored.run.protocolHash],
      [
        ['evaluation', 'initialCapitalMicros'],
        evaluation.initialCapitalMicros,
        prepared.stored.run.initialCapitalMicros,
      ],
      [['evaluation', 'input', 'snapshotId'], evaluation.input.snapshotId, prepared.stored.run.snapshotId],
      [['evaluation', 'input', 'snapshotId'], evaluation.input.snapshotId, inputManifest.finalizedSnapshot.snapshotId],
      [
        ['evaluation', 'input', 'publicationId'],
        evaluation.input.publicationId,
        inputManifest.finalizedSnapshot.publicationId,
      ],
      [['evaluation', 'input', 'manifestHash'], evaluation.input.manifestHash, inputManifest.hash],
    ] as const
    for (const [path, observed, expected] of facts) {
      if (observed !== expected) return yield* componentMismatch(path, observed, expected)
    }
  })

const validateEvaluationInput = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const { evaluation, inputManifest } = prepared.decoded
    const evaluationBoundsHash = yield* canonicalHash('evaluation-bounds', evaluation.input.bounds, 'evaluation')
    const manifestBoundsHash = yield* canonicalHash('evaluation-bounds', inputManifest.bounds, 'input-manifest')
    if (evaluationBoundsHash !== manifestBoundsHash) {
      return yield* componentMismatch(['evaluation', 'input', 'boundsHash'], evaluationBoundsHash, manifestBoundsHash)
    }
    const facts = [
      [['evaluation', 'input', 'rowCount'], evaluation.input.rowCount, inputManifest.rowCount],
      [['evaluation', 'input', 'sessionCount'], evaluation.input.sessionCount, inputManifest.sessionCount],
    ] as const
    for (const [path, observed, expected] of facts) {
      if (observed !== expected) return yield* componentMismatch(path, observed, expected)
    }
    const evaluationSymbolsHash = yield* canonicalHash(
      'evaluation-input-symbols',
      evaluation.input.symbols,
      'evaluation',
    )
    const manifestSymbolsHash = yield* canonicalHash(
      'evaluation-input-symbols',
      inputManifest.symbols.map((coverage) => coverage.symbol),
      'input-manifest',
    )
    if (evaluationSymbolsHash !== manifestSymbolsHash) {
      return yield* componentMismatch(
        ['evaluation', 'input', 'symbolsHash'],
        evaluationSymbolsHash,
        manifestSymbolsHash,
      )
    }
  })

const validateEvaluationEvents = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> => {
  const { evaluation } = prepared.decoded
  if (evaluation.eventCount !== prepared.stored.run.eventCount) {
    return componentMismatch(['evaluation', 'eventCount'], evaluation.eventCount, prepared.stored.run.eventCount)
  }
  if (evaluation.eventCount !== prepared.decoded.events.length) {
    return componentMismatch(['evaluation', 'eventCount'], evaluation.eventCount, prepared.decoded.events.length)
  }
  return Result.void
}

const validateEvaluationFacts = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    yield* validateEvaluationIdentity(prepared)
    yield* validateEvaluationInput(prepared)
    yield* validateEvaluationEvents(prepared)
  })

const validateSignalDecisions = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const { decoded } = prepared
    const decisions = decoded.signalDecisions.items
    const events = decoded.events.filter((event) => event.kind === 'decision')
    if (decoded.evaluation.signalDecisionCount !== decisions.length) {
      return yield* componentMismatch(
        ['evaluation', 'signalDecisionCount'],
        decoded.evaluation.signalDecisionCount,
        decisions.length,
      )
    }
    if (decisions.length !== events.length) {
      return yield* componentMismatch(['signalDecisions', 'length'], decisions.length, events.length)
    }
    for (const [index, decision] of decisions.entries()) {
      const event = events[index]
      if (event === undefined) {
        return yield* componentMismatch(['signalDecisions', index], decision, 'decision event')
      }
      const facts = [
        ['decisionId', decision.decisionId, event.id],
        ['signalDate', decision.signalDate, event.signalDate],
        ['executionDate', decision.executionDate, event.executionDate],
      ] as const
      for (const [path, observed, expected] of facts) {
        if (observed !== expected) {
          return yield* componentMismatch(['signalDecisions', index, path], observed, expected)
        }
      }
      const decisionWeightsHash = yield* canonicalHash(
        'signal-target-weights',
        decision.targetWeights,
        `decision:${decision.decisionId}`,
      )
      const eventWeightsHash = yield* canonicalHash('signal-target-weights', event.targetWeights, `event:${event.id}`)
      if (decisionWeightsHash !== eventWeightsHash) {
        return yield* componentMismatch(
          ['signalDecisions', index, 'targetWeightsHash'],
          decisionWeightsHash,
          eventWeightsHash,
        )
      }
    }
  })

const validateSimulationCardinality = (
  prepared: PreparedEvidenceRecovery,
): Result.Result<void, EvidenceRecoveryIssue> => {
  const { decoded } = prepared
  const facts = [
    [['evaluation', 'orderCount'], decoded.evaluation.orderCount, decoded.orders.items.length],
    [['evaluation', 'cashChangeCount'], decoded.evaluation.cashChangeCount, decoded.cashChanges.items.length],
    [['evaluation', 'dailyMarkCount'], decoded.evaluation.dailyMarkCount, decoded.dailyMarks.items.length],
    [['evaluation', 'dailyMarkCount'], decoded.evaluation.dailyMarkCount, decoded.evaluation.strategy.observations],
  ] as const
  for (const [path, observed, expected] of facts) {
    if (observed !== expected) return componentMismatch(path, observed, expected)
  }
  return Result.void
}

const validateBenchmarkCardinality = (
  prepared: PreparedEvidenceRecovery,
): Result.Result<void, EvidenceRecoveryIssue> => {
  const { decoded } = prepared
  const facts = [
    [
      ['evaluation', 'benchmarkSeriesCounts', 'buyAndHold'],
      decoded.evaluation.benchmarkSeriesCounts.buyAndHold,
      decoded.buyAndHoldSeries.items.length,
    ],
    [
      ['evaluation', 'benchmarkSeriesCounts', 'directVolTiming'],
      decoded.evaluation.benchmarkSeriesCounts.directVolTiming,
      decoded.directVolatilitySeries.items.length,
    ],
    [
      ['evaluation', 'benchmarkSeriesCounts', 'doubleCostStrategy'],
      decoded.evaluation.benchmarkSeriesCounts.doubleCostStrategy,
      decoded.doubleCostSeries.items.length,
    ],
  ] as const
  for (const [path, observed, expected] of facts) {
    if (observed !== expected) return componentMismatch(path, observed, expected)
  }
  return Result.void
}

const validateBenchmarkDates = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> => {
  const { decoded } = prepared
  const candidateDates = decoded.dailyMarks.items.map((point) => point.sessionDate)
  const series = [
    ['buyAndHold', decoded.buyAndHoldSeries.items],
    ['directVolTiming', decoded.directVolatilitySeries.items],
    ['doubleCostStrategy', decoded.doubleCostSeries.items],
  ] as const
  for (const [name, points] of series) {
    if (points.length !== candidateDates.length) {
      return componentMismatch(['benchmarkSeries', name, 'length'], points.length, candidateDates.length)
    }
    for (const [index, point] of points.entries()) {
      if (point.sessionDate !== candidateDates[index]) {
        return componentMismatch(
          ['benchmarkSeries', name, index, 'sessionDate'],
          point.sessionDate,
          candidateDates[index],
        )
      }
    }
  }
  return Result.void
}

const validateSignalAndSeriesFacts = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    yield* validateSignalDecisions(prepared)
    yield* validateSimulationCardinality(prepared)
    yield* validateBenchmarkCardinality(prepared)
    yield* validateBenchmarkDates(prepared)
  })

const validateMetricArtifact = (
  prepared: PreparedEvidenceRecovery,
  artifactName: 'buy-and-hold' | 'direct-volatility-timing' | 'double-cost-strategy' | 'strategy',
  value: unknown,
): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const artifact = yield* requiredArtifact(prepared.artifacts, artifactName)
    const expectedHash = yield* canonicalHash('evaluation-metric', value, artifactName)
    if (artifact.contentHash !== expectedHash) {
      return yield* componentMismatch(['artifacts', artifactName, 'contentHash'], artifact.contentHash, expectedHash)
    }
  })

const validateMarkedEquityBinding = (
  prepared: PreparedEvidenceRecovery,
): Result.Result<string, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const { evaluation, markedEquity } = prepared.decoded
    if (evaluation.markedEquityReconciliation.runId !== prepared.runId) {
      return yield* componentMismatch(
        ['evaluation', 'markedEquityReconciliation', 'runId'],
        evaluation.markedEquityReconciliation.runId,
        prepared.runId,
      )
    }
    const evaluationHash = yield* canonicalHash(
      'evaluation-marked-equity',
      evaluation.markedEquityReconciliation,
      'evaluation',
    )
    const artifactHash = yield* canonicalHash('evaluation-marked-equity', markedEquity, 'artifact')
    if (evaluationHash !== artifactHash) {
      return yield* componentMismatch(['evaluation', 'markedEquityReconciliation'], evaluationHash, artifactHash)
    }
    return artifactHash
  })

const validateMetricArtifacts = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const { evaluation } = prepared.decoded
    yield* validateMetricArtifact(prepared, 'strategy', evaluation.strategy)
    yield* validateMetricArtifact(prepared, 'buy-and-hold', evaluation.buyAndHold)
    yield* validateMetricArtifact(prepared, 'direct-volatility-timing', evaluation.directVolTiming)
    yield* validateMetricArtifact(prepared, 'double-cost-strategy', evaluation.doubleCostStrategy)
  })

const validateRecoveredGates = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const { gates } = prepared.stored
    const expectedGates = prepared.decoded.evaluation.verdict.gates
    if (gates.length !== expectedGates.length) {
      return yield* componentMismatch(['gates', 'length'], gates.length, expectedGates.length)
    }
    for (const [index, gate] of gates.entries()) {
      const expectedGate = expectedGates[index]
      if (expectedGate === undefined) return yield* componentMismatch(['gates', index], gate, 'evaluation gate')
      const observedHash = yield* canonicalHash(
        'gate-outcome',
        { name: gate.name, passed: gate.passed, actual: gate.actual, required: gate.required },
        `stored:${index}`,
      )
      const expectedHash = yield* canonicalHash('gate-outcome', expectedGate, `evaluation:${index}`)
      if (observedHash !== expectedHash) {
        return yield* componentMismatch(['gates', index], observedHash, expectedHash)
      }
    }
  })

const validateRecoveredEvents = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> => {
  for (const [index, event] of prepared.stored.events.entries()) {
    const decodedEvent = prepared.decoded.events[index]
    if (decodedEvent === undefined) return componentMismatch(['events', index], event, 'decoded event')
    if (event.id !== decodedEvent.id) return componentMismatch(['events', index, 'id'], event.id, decodedEvent.id)
    if (event.kind !== decodedEvent.kind) {
      return componentMismatch(['events', index, 'kind'], event.kind, decodedEvent.kind)
    }
  }
  return Result.void
}

const validateRecoveredIdentity = (prepared: PreparedEvidenceRecovery): Result.Result<void, EvidenceRecoveryIssue> => {
  const { evaluation, markedEquity, equitySeries } = prepared.decoded
  if (markedEquity.runId !== prepared.runId) {
    return componentMismatch(['markedEquity', 'runId'], markedEquity.runId, prepared.runId)
  }
  if (equitySeries.items.length !== evaluation.dailyMarkCount) {
    return componentMismatch(['equitySeries', 'length'], equitySeries.items.length, evaluation.dailyMarkCount)
  }
  return Result.void
}

const validateReconstructedProof = (
  prepared: PreparedEvidenceRecovery,
  proof: MarkedEquityProof,
  storedMarkedHash: string,
): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const proofMarkedHash = yield* canonicalHash('marked-equity-proof', proof.reconciliation, 'reconstructed')
    if (proofMarkedHash !== storedMarkedHash) {
      return yield* componentMismatch(['markedEquity', 'proofHash'], proofMarkedHash, storedMarkedHash)
    }
    const proofEquityHash = yield* canonicalHash('recovered-equity-series', proof.equitySeries, 'reconstructed')
    const storedEquityHash = yield* canonicalHash(
      'recovered-equity-series',
      prepared.decoded.equitySeries.items,
      'artifact',
    )
    if (proofEquityHash !== storedEquityHash) {
      return yield* componentMismatch(['equitySeries', 'proofHash'], proofEquityHash, storedEquityHash)
    }
  })

const validateRecoveredComponents = (
  prepared: PreparedEvidenceRecovery,
  proof: MarkedEquityProof,
): Result.Result<void, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    const storedMarkedHash = yield* validateMarkedEquityBinding(prepared)
    yield* validateMetricArtifacts(prepared)
    yield* validateRecoveredGates(prepared)
    yield* validateRecoveredEvents(prepared)
    yield* validateRecoveredIdentity(prepared)
    yield* validateReconstructedProof(prepared, proof, storedMarkedHash)
  })

const validateFinalPoint = (
  finalPoint: (typeof EquitySeriesArtifactSchema.Type)['items'][number],
  markedEquity: typeof MarkedEquityReconciliationSchema.Type,
): Result.Result<void, EvidenceRecoveryIssue> => {
  const facts = [
    ['evaluatorEquityMicros', finalPoint.evaluatorEquityMicros, markedEquity.evaluatorEndingEquityMicros],
    ['reconstructedEquityMicros', finalPoint.reconstructedEquityMicros, markedEquity.reconstructedEndingEquityMicros],
    ['differenceMicros', finalPoint.differenceMicros, markedEquity.differenceMicros],
  ] as const
  for (const [path, observed, expected] of facts) {
    if (observed !== expected) {
      return componentMismatch(['equitySeries', 'final', path], observed, expected)
    }
  }
  return Result.void
}

const validateTerminalStatus = (
  stored: StoredEvaluationEvidence,
  evaluation: typeof EvaluationSummarySchema.Type,
): Result.Result<void, EvidenceRecoveryIssue> => {
  const complete = stored.statuses[1]
  if (complete?.status !== 'COMPLETE') {
    return mismatch('status', ['complete'], complete?.status, 'COMPLETE')
  }
  if (complete.detail.verdict !== evaluation.verdict.status) {
    return mismatch('status', ['complete', 'verdict'], complete.detail.verdict, evaluation.verdict.status)
  }
  return Result.void
}

export const completeEvidenceRecovery = (
  prepared: PreparedEvidenceRecovery,
  snapshot: StoredSnapshotRow,
): Result.Result<RecoveredEvaluationEvidence, EvidenceRecoveryIssue> =>
  Result.gen(function* () {
    yield* validateSnapshotReference(snapshot, prepared.decoded.inputManifest)
    const reconciliation = yield* reconcileRecoveredEvidence(prepared)
    yield* validateReconciliationShape(prepared)
    const finalPoint = prepared.decoded.equitySeries.items.at(-1)
    if (finalPoint === undefined) {
      return yield* componentMismatch(['equitySeries', 'final'], undefined, 'present')
    }
    yield* validateEvaluationFacts(prepared)
    yield* validateSignalAndSeriesFacts(prepared)
    yield* validateRecoveredComponents(prepared, reconciliation)
    yield* validateFinalPoint(finalPoint, prepared.decoded.markedEquity)
    yield* validateTerminalStatus(prepared.stored, prepared.decoded.evaluation)
    return {
      evaluation: prepared.decoded.evaluation,
      reconciliation: prepared.decoded.reconciliation,
      persistence: {
        runId: prepared.runId,
        deduplicated: true,
        artifactCount: prepared.stored.run.artifactCount,
        eventCount: prepared.stored.run.eventCount,
        gateCount: prepared.stored.run.gateCount,
      },
    }
  })
