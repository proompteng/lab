import { Result } from 'effect'

import type { AuditCheck, QualificationAuditFailure } from './audit'
import {
  auditContract,
  auditHashMatches,
  hashAuditMaterial,
  makeAuditCheck,
  sameAuditMaterial,
  type QualificationAuditFacts,
} from './core'

export const auditStoredEvidence = (
  facts: QualificationAuditFacts,
): Result.Result<readonly AuditCheck[], QualificationAuditFailure> =>
  Result.gen(function* () {
    const { artifactContentHashes, database, input, provenance, reference } = facts
    const expectedArtifactSchemas = new Map<string, string>([
      ['evaluation-summary', auditContract.summarySchemaVersion],
      ['input-manifest', input.manifest.schemaVersion],
      ['strategy', 'bayn.performance-metrics.v2'],
      ['buy-and-hold', 'bayn.performance-metrics.v2'],
      ['direct-volatility-timing', 'bayn.performance-metrics.v2'],
      ['double-cost-strategy', 'bayn.performance-metrics.v2'],
      ['simulated-orders', 'bayn.simulated-orders.v2'],
      ['cash-changes', 'bayn.cash-changes.v2'],
      ['daily-position-marks', 'bayn.daily-position-marks.v3'],
      [auditContract.decisionArtifactName, auditContract.decisionArtifactSchemaVersion],
      ['buy-and-hold-series', 'bayn.daily-performance-series.v1'],
      ['direct-volatility-timing-series', 'bayn.daily-performance-series.v1'],
      ['double-cost-strategy-series', 'bayn.daily-performance-series.v1'],
      ['equity-series', 'bayn.equity-series.v1'],
      ['marked-equity-reconciliation', 'bayn.marked-equity-reconciliation.v2'],
      ['reconciliation', 'bayn.reconciliation.v1'],
      ['qualification-artifact-manifest', 'bayn.qualification-artifact-manifest.v1'],
    ])
    const suppliedProtocolHash = yield* hashAuditMaterial(
      { scope: 'protocol', name: 'supplied-parameters' },
      input.protocol,
    )
    const storedProtocolHash = yield* hashAuditMaterial(
      { scope: 'protocol', name: 'stored-parameters' },
      database.protocol.parameters,
    )
    const protocolContentMatches = suppliedProtocolHash === storedProtocolHash
    const protocolHashMatches = suppliedProtocolHash === database.protocol.parameterHash
    const artifactHashes = database.artifacts.map(
      (value) => artifactContentHashes.get(value.name) === value.contentHash,
    )
    const eventHashes = yield* Result.all(
      database.events.map((value) =>
        auditHashMatches(
          { scope: 'event', name: value.kind, ordinal: value.ordinal },
          value.payload,
          value.contentHash,
        ),
      ),
    )
    const gateHashes = yield* Result.all(
      database.gates.map((value) =>
        auditHashMatches(
          { scope: 'gate', name: value.name, ordinal: value.ordinal },
          { name: value.name, passed: value.passed, actual: value.actual, required: value.required },
          value.contentHash,
        ),
      ),
    )
    const [writingStatus, completeStatus] = database.statuses
    let statusHistoryMatches = false
    if (
      database.statuses.length === 2 &&
      writingStatus?.status === 'WRITING' &&
      completeStatus?.status === 'COMPLETE'
    ) {
      const writingDetailMatches = yield* sameAuditMaterial(
        { scope: 'status', name: 'WRITING' },
        writingStatus.detail,
        {
          artifactCount: database.run.artifactCount,
          eventCount: database.run.eventCount,
          gateCount: database.run.gateCount,
        },
      )
      const completeDetailMatches = yield* sameAuditMaterial(
        { scope: 'status', name: 'COMPLETE' },
        completeStatus.detail,
        { reconciliationExact: true, verdict: reference.verdict.status },
      )
      statusHistoryMatches = writingDetailMatches && completeDetailMatches
    }
    return [
      makeAuditCheck('postgres-transaction-read-only', database.transactionReadOnly, 'transaction_read_only=on'),
      makeAuditCheck(
        'protocol-content',
        protocolContentMatches && protocolHashMatches && reference.protocolHash === database.protocol.protocolHash,
        `parameterHash=${database.protocol.parameterHash}`,
      ),
      makeAuditCheck(
        'run-identity',
        reference.runId === database.run.runId &&
          reference.protocolHash === database.run.protocolHash &&
          input.manifest.finalizedSnapshot.snapshotId === database.run.snapshotId &&
          database.protocol.strategyName === auditContract.name &&
          database.run.strategyName === auditContract.name &&
          database.run.evaluationSchemaVersion === auditContract.evaluationSchemaVersion &&
          provenance.contractVersions.evaluation === auditContract.evaluationSchemaVersion &&
          database.run.initialCapitalMicros === input.protocol.initialCapitalMicros &&
          database.run.status === 'COMPLETE',
        `runId=${database.run.runId}`,
      ),
      makeAuditCheck(
        'evidence-counts',
        database.artifacts.length === database.run.artifactCount &&
          database.events.length === database.run.eventCount &&
          database.gates.length === database.run.gateCount,
        `${database.artifacts.length}/${database.events.length}/${database.gates.length}`,
      ),
      makeAuditCheck('artifact-hashes', artifactHashes.every(Boolean), `${database.artifacts.length} artifacts`),
      makeAuditCheck(
        'artifact-schema-versions',
        database.artifacts.length === expectedArtifactSchemas.size &&
          database.artifacts.every((value) => expectedArtifactSchemas.get(value.name) === value.schemaVersion),
        `${database.artifacts.length} versioned artifacts`,
      ),
      makeAuditCheck(
        'event-hashes-and-order',
        eventHashes.every(Boolean) &&
          database.events.every(
            (value, index) =>
              value.ordinal === index && value.id === value.payload.id && value.kind === value.payload.kind,
          ),
        `${database.events.length} events`,
      ),
      makeAuditCheck(
        'gate-hashes-and-order',
        gateHashes.every(Boolean) && database.gates.every((value, index) => value.ordinal === index),
        `${database.gates.length} gates`,
      ),
      makeAuditCheck(
        'status-history',
        statusHistoryMatches,
        database.statuses.map((status) => status.status).join(' -> '),
      ),
    ]
  })

export const auditSignalAndRepository = (facts: QualificationAuditFacts): readonly AuditCheck[] => {
  const { database, input, publisherSet, replicaSet, sortedAccess, sortedReplicas } = facts
  const candidateAccess = sortedAccess.filter((value) => value.user === input.signalPrincipals.candidate)
  const candidateBarReads = candidateAccess.filter((value) => value.kind === 'bars')
  const candidateSessionReads = candidateAccess.filter((value) => value.kind === 'sessions')
  const manifestReads = candidateAccess.filter((value) => value.kind === 'manifest')
  const preLockBarReads = candidateBarReads.filter(
    (value) => value.queryStartTime < database.qualification.lockCreatedAt,
  )
  const preLockSessionReads = candidateSessionReads.filter(
    (value) => value.queryStartTime < database.qualification.lockCreatedAt,
  )
  const preLockManifestReads = manifestReads.filter(
    (value) => value.queryStartTime < database.qualification.lockCreatedAt,
  )
  const lockedSessionReads = candidateSessionReads.filter(
    (value) =>
      value.queryStartTime >= database.qualification.lockCreatedAt &&
      value.queryStartTime <= database.qualification.resultCommittedAt,
  )
  const lockedManifestReads = manifestReads.filter(
    (value) =>
      value.queryStartTime >= database.qualification.lockCreatedAt &&
      value.queryStartTime <= database.qualification.resultCommittedAt,
  )
  return [
    makeAuditCheck(
      'signal-query-log-replica-coverage',
      sortedReplicas.length >= 2 &&
        replicaSet.size === sortedReplicas.length &&
        sortedAccess.every((value) => replicaSet.has(value.replica)),
      `${sortedReplicas.length} replicas=${sortedReplicas.join(',')}`,
    ),
    makeAuditCheck(
      'signal-lock-before-candidate-bars',
      preLockBarReads.length === 0 &&
        candidateBarReads.length === 1 &&
        candidateBarReads.every(
          (value) =>
            value.queryStartTime >= database.qualification.lockCreatedAt &&
            value.queryStartTime <= database.qualification.resultCommittedAt,
        ),
      `lock=${database.qualification.lockCreatedAt} barReads=${candidateBarReads
        .map((value) => `${value.replica}@${value.queryStartTime}`)
        .join(',')}`,
    ),
    makeAuditCheck(
      'signal-calendar-inspected-before-lock',
      preLockSessionReads.length >= 1 && lockedSessionReads.length >= 1,
      `preLock=${preLockSessionReads.length} locked=${lockedSessionReads.length}`,
    ),
    makeAuditCheck(
      'signal-manifest-inspected-before-lock',
      preLockManifestReads.length >= 1 && lockedManifestReads.length >= 1,
      `preLock=${preLockManifestReads.length} locked=${lockedManifestReads.length}`,
    ),
    makeAuditCheck(
      'signal-read-principals',
      input.signalPrincipals.candidate.length > 0 &&
        publisherSet.size === input.signalPrincipals.publishers.length &&
        input.signalPrincipals.publishers.length > 0 &&
        !publisherSet.has(input.signalPrincipals.candidate) &&
        sortedAccess.every((value) => value.user === input.signalPrincipals.candidate || publisherSet.has(value.user)),
      [...new Set(sortedAccess.map((value) => value.user))].join(','),
    ),
    makeAuditCheck(
      'source-revision-in-repository',
      input.repository.sourceCommitExists && input.repository.sourceCommitAncestorOfMain,
      `sourceRevision=${database.run.sourceRevision}`,
    ),
    makeAuditCheck(
      'no-pre-lock-result-reference',
      input.repository.preLockResultReferences.length === 0,
      input.repository.preLockResultReferences.join(',') || 'none',
    ),
  ]
}
