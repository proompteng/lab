import { Result } from 'effect'

import { makeStrategyProtocolHashResult, type RuntimeProvenance } from '../../contracts'
import type { Protocol } from '../../types'
import type { PersistenceReceipt } from '../evidence-recovery'
import { persistenceCanonicalHash, persistenceMismatch } from './persistence-failures'
import type {
  PersistencePlan,
  PersistencePlanFailure,
  StoredPersistenceReferences,
  StoredProtocolReference,
} from './persistence-model'
import { Pipeable } from '../../pipeable'

const validateProtocolReferenceDataFirst = (
  input: {
    readonly protocolHash: string
    readonly provenance: RuntimeProvenance
    readonly parameters: Protocol
  },
  reference: StoredProtocolReference,
): Result.Result<void, PersistencePlanFailure> =>
  Result.gen(function* () {
    const storedParameterHash = yield* persistenceCanonicalHash({
      operation: 'protocol-parameters',
      value: reference.parameters,
      subject: 'stored',
    })
    const expectedParameterHash = yield* persistenceCanonicalHash({
      operation: 'protocol-parameters',
      value: input.parameters,
      subject: 'input',
    })
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
      if (observed !== expected) return yield* persistenceMismatch('protocol-reference', path, observed, expected)
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
      return yield* persistenceMismatch(
        'protocol-reference',
        ['derivedProtocolHash'],
        storedProtocolHash,
        input.protocolHash,
      )
    }
  })

export const validateProtocolReference = Pipeable.dual(2, validateProtocolReferenceDataFirst)

const validatePersistenceReceiptDataFirst = (
  plan: PersistencePlan,
  references: StoredPersistenceReferences,
  deduplicated: boolean,
): Result.Result<PersistenceReceipt, PersistencePlanFailure> =>
  Result.gen(function* () {
    if (references.receipts.length !== 1) {
      return yield* persistenceMismatch('receipt-cardinality', ['receipts', 'length'], references.receipts.length, 1)
    }
    const row = references.receipts[0]
    if (row === undefined) return yield* persistenceMismatch('receipt-cardinality', ['receipts', 'length'], 0, 1)
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
      if (observed !== expected) return yield* persistenceMismatch('receipt-identity', path, observed, expected)
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
        return yield* persistenceMismatch(invariant, path, observed, expected)
      }
    }

    const expectedArtifacts = [...plan.artifacts].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
    for (const [index, artifact] of references.artifacts.entries()) {
      const expected = expectedArtifacts[index]
      if (expected === undefined) {
        return yield* persistenceMismatch(
          'receipt-artifact-content',
          ['artifacts', index],
          artifact.artifact_name,
          'absent',
        )
      }
      const payloadHash = yield* persistenceCanonicalHash({
        operation: 'stored-artifact',
        value: artifact.payload,
        subject: artifact.artifact_name,
      })
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
        return yield* persistenceMismatch('receipt-artifact-content', ['artifacts', index], observed, expectedFacts)
      }
    }

    for (const [index, event] of references.events.entries()) {
      const expected = plan.events[index]
      if (expected === undefined) {
        return yield* persistenceMismatch('receipt-event-content', ['events', index], event.event_id, 'absent')
      }
      const payloadHash = yield* persistenceCanonicalHash({
        operation: 'stored-event',
        value: event.payload,
        subject: event.event_id,
      })
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
        return yield* persistenceMismatch('receipt-event-content', ['events', index], observed, expectedFacts)
      }
    }

    for (const [index, gate] of references.gates.entries()) {
      const expected = plan.gates[index]
      if (expected === undefined) {
        return yield* persistenceMismatch('receipt-gate-content', ['gates', index], gate.gate_name, 'absent')
      }
      const payloadHash = yield* persistenceCanonicalHash({
        operation: 'stored-gate',
        value: { name: gate.gate_name, passed: gate.passed, actual: gate.actual, required: gate.required },
        subject: gate.gate_name,
      })
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
        return yield* persistenceMismatch('receipt-gate-content', ['gates', index], observed, expectedFacts)
      }
    }

    if (references.statuses.length !== 2) {
      return yield* persistenceMismatch('receipt-status-history', ['statuses', 'length'], references.statuses.length, 2)
    }
    const writing = references.statuses[0]
    const complete = references.statuses[1]
    if (writing?.status !== 'WRITING' || complete?.status !== 'COMPLETE') {
      return yield* persistenceMismatch(
        'receipt-status-history',
        ['statuses', 'order'],
        references.statuses.map((status) => status.status),
        ['WRITING', 'COMPLETE'],
      )
    }
    const writingHash = yield* persistenceCanonicalHash({
      operation: 'stored-status',
      value: writing.detail,
      subject: 'WRITING',
    })
    const expectedWritingHash = yield* persistenceCanonicalHash({
      operation: 'stored-status',
      value: { artifactCount: plan.artifacts.length, eventCount: plan.events.length, gateCount: plan.gates.length },
      subject: 'expected-WRITING',
    })
    const completeHash = yield* persistenceCanonicalHash({
      operation: 'stored-status',
      value: complete.detail,
      subject: 'COMPLETE',
    })
    const expectedCompleteHash = yield* persistenceCanonicalHash({
      operation: 'stored-status',
      value: { reconciliationExact: true, verdict: plan.evaluation.verdict.status },
      subject: 'expected-COMPLETE',
    })
    if (writingHash !== expectedWritingHash || completeHash !== expectedCompleteHash) {
      return yield* persistenceMismatch(
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

export const validatePersistenceReceipt = Pipeable.dual(3, validatePersistenceReceiptDataFirst)
