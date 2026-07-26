import { Result } from 'effect'

import type {
  EvidenceRecoveryIssue,
  StoredEvidenceRows,
  StoredEvaluationEvidence,
  StoredReceiptRow,
  ValidatedStoredGraph,
} from './model'
import { canonicalHash, mismatch } from './shared'

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

export const validateStoredGraph = (
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

export const toStoredEvidence = (graph: ValidatedStoredGraph): StoredEvaluationEvidence => {
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
