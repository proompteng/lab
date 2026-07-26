import { Result, Schema } from 'effect'

import { canonicalHashV1 } from '../hash'
import {
  QualificationLockSchema,
  QualificationResultSchema,
  type QualificationLock,
  type QualificationResult,
} from '../qualification'
import { strictParseOptions as StrictParseOptions } from '../schemas'
import type { InputManifest } from '../types'
import {
  auditQualification,
  type AuditDatabaseSnapshot,
  type QualificationAuditFailure,
  type QualificationAuditInput,
  type QualificationAuditReport,
} from './audit'

const decodeLock = Schema.decodeUnknownResult(QualificationLockSchema, StrictParseOptions)
const decodeResult = Schema.decodeUnknownResult(QualificationResultSchema, StrictParseOptions)

const itemCount = (payload: unknown): number => {
  if (typeof payload !== 'object' || payload === null || !('items' in payload)) return 0
  return Array.isArray(payload.items) ? payload.items.length : 0
}

const evidenceSummary = (database: AuditDatabaseSnapshot) => ({
  artifacts: database.artifacts
    .map((artifact) => ({
      name: artifact.name,
      schemaVersion: artifact.schemaVersion,
      itemCount: itemCount(artifact.payload),
      contentHash: artifact.contentHash,
    }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
  events: {
    count: database.events.length,
    contentHash: canonicalHashV1(
      database.events.map(({ ordinal, id, kind, contentHash }) => ({ ordinal, id, kind, contentHash })),
    ),
  },
  gates: {
    count: database.gates.length,
    contentHash: canonicalHashV1(
      database.gates.map(({ ordinal, name, passed, contentHash }) => ({ ordinal, name, passed, contentHash })),
    ),
  },
  statuses: {
    count: database.statuses.length,
    contentHash: canonicalHashV1(database.statuses),
  },
})

export type QualificationDossierFailure =
  | QualificationAuditFailure
  | {
      readonly _tag: 'QualificationDossierSubjectMismatch'
      readonly check: QualificationDossierSubjectCheck
      readonly actual: unknown
      readonly expected: unknown
    }
  | {
      readonly _tag: 'QualificationDossierDocumentInvalid'
      readonly document: 'lock' | 'result'
      readonly cause: Schema.SchemaError
    }

type QualificationDossierSubjectCheck =
  | 'audit-passed'
  | 'audit-hash'
  | 'database-read-only'
  | 'evaluation-complete'
  | 'audit-run-id'
  | 'protocol-hash'
  | 'snapshot-id'
  | 'stored-artifact-count'
  | 'stored-event-count'
  | 'stored-gate-count'
  | 'audit-artifact-count'
  | 'audit-event-count'
  | 'audit-gate-count'
  | 'lock-run-id'
  | 'result-run-id'
  | 'stored-lock-id'
  | 'result-lock-id'
  | 'stored-analysis-hash'
  | 'stored-result-hash'
  | 'stored-verdict'
  | 'trial-lineage'

const mismatch = (
  check: QualificationDossierSubjectCheck,
  actual: unknown,
  expected: unknown,
): Result.Result<never, QualificationDossierFailure> =>
  Result.fail({ _tag: 'QualificationDossierSubjectMismatch', check, actual, expected })

const requireEqual = (
  check: QualificationDossierSubjectCheck,
  actual: unknown,
  expected: unknown,
): Result.Result<void, QualificationDossierFailure> =>
  Object.is(actual, expected) ? Result.succeed(undefined) : mismatch(check, actual, expected)

const validateSubject = (
  database: AuditDatabaseSnapshot,
  manifest: InputManifest,
  audit: QualificationAuditReport,
): Result.Result<void, QualificationDossierFailure> => {
  const auditMaterial = Object.fromEntries(Object.entries(audit).filter(([name]) => name !== 'auditHash'))
  const checks = [
    requireEqual('audit-passed', audit.status === 'PASS' && audit.checks.every((check) => check.passed), true),
    requireEqual('audit-hash', audit.auditHash, canonicalHashV1(auditMaterial)),
    requireEqual('database-read-only', database.transactionReadOnly, true),
    requireEqual('evaluation-complete', database.run.status, 'COMPLETE'),
    requireEqual('audit-run-id', audit.runId, database.run.runId),
    requireEqual('protocol-hash', database.run.protocolHash, database.protocol.protocolHash),
    requireEqual('snapshot-id', database.run.snapshotId, manifest.finalizedSnapshot.snapshotId),
    requireEqual('stored-artifact-count', database.run.artifactCount, database.artifacts.length),
    requireEqual('stored-event-count', database.run.eventCount, database.events.length),
    requireEqual('stored-gate-count', database.run.gateCount, database.gates.length),
    requireEqual('audit-artifact-count', audit.evidence.artifactCount, database.artifacts.length),
    requireEqual('audit-event-count', audit.evidence.eventCount, database.events.length),
    requireEqual('audit-gate-count', audit.evidence.gateCount, database.gates.length),
  ]
  for (const check of checks) {
    if (Result.isFailure(check)) return Result.fail(check.failure)
  }
  return Result.succeed(undefined)
}

export interface QualificationDossier {
  readonly schemaVersion: 'bayn.qualification-dossier.v2'
  readonly subject: {
    readonly run: AuditDatabaseSnapshot['run']
    readonly protocol: AuditDatabaseSnapshot['protocol']
    readonly inputManifest: InputManifest
  }
  readonly evidence: ReturnType<typeof evidenceSummary> & { readonly endpoint: string }
  readonly qualification: {
    readonly lockCreatedAt: string
    readonly resultCommittedAt: string
    readonly priorTrialRunIds: readonly string[]
    readonly priorTrialSetHash: string
    readonly lock: QualificationLock
    readonly result: QualificationResult
  }
  readonly audit: QualificationAuditReport
  readonly authority: {
    readonly maximum: 'observe'
    readonly executable: boolean
    readonly paperMutation: false
    readonly brokerOrders: false
    readonly capitalPromotion: false
  }
  readonly dossierHash: string
}

export const makeQualificationDossier = (
  input: QualificationAuditInput,
): Result.Result<QualificationDossier, QualificationDossierFailure> => {
  const auditResult = auditQualification(input)
  if (Result.isFailure(auditResult)) return Result.fail(auditResult.failure)
  const audit = auditResult.success
  const database = input.database
  const subjectResult = validateSubject(database, input.manifest, audit)
  if (Result.isFailure(subjectResult)) return Result.fail(subjectResult.failure)
  const lockResult = decodeLock(database.qualification.lock)
  if (Result.isFailure(lockResult)) {
    return Result.fail({ _tag: 'QualificationDossierDocumentInvalid', document: 'lock', cause: lockResult.failure })
  }
  const resultResult = decodeResult(database.qualification.result)
  if (Result.isFailure(resultResult)) {
    return Result.fail({ _tag: 'QualificationDossierDocumentInvalid', document: 'result', cause: resultResult.failure })
  }
  const lock = lockResult.success
  const result = resultResult.success
  const bindingChecks = [
    requireEqual('lock-run-id', lock.candidateRunId, database.run.runId),
    requireEqual('result-run-id', result.runId, database.run.runId),
    requireEqual('stored-lock-id', lock.lockId, database.qualification.storedLockId),
    requireEqual('result-lock-id', result.lockId, lock.lockId),
    requireEqual('stored-analysis-hash', result.analysis.analysisHash, database.qualification.storedAnalysisHash),
    requireEqual('stored-result-hash', result.resultHash, database.qualification.storedResultHash),
    requireEqual('stored-verdict', result.verdict, database.qualification.storedVerdict),
    requireEqual('trial-lineage', canonicalHashV1(lock.priorTrialRunIds), canonicalHashV1(database.priorTrialRunIds)),
  ]
  for (const check of bindingChecks) {
    if (Result.isFailure(check)) return Result.fail(check.failure)
  }

  const material = {
    schemaVersion: 'bayn.qualification-dossier.v2' as const,
    subject: {
      run: database.run,
      protocol: database.protocol,
      inputManifest: input.manifest,
    },
    evidence: {
      endpoint: `/v1/evaluations/${database.run.runId}`,
      ...evidenceSummary(database),
    },
    qualification: {
      lockCreatedAt: database.qualification.lockCreatedAt,
      resultCommittedAt: database.qualification.resultCommittedAt,
      priorTrialRunIds: database.priorTrialRunIds,
      priorTrialSetHash: canonicalHashV1(database.priorTrialRunIds),
      lock,
      result,
    },
    audit,
    authority: {
      maximum: 'observe' as const,
      executable: result.verdict === 'QUALIFIED',
      paperMutation: false as const,
      brokerOrders: false as const,
      capitalPromotion: false as const,
    },
  }
  return Result.succeed({ ...material, dossierHash: canonicalHashV1(material) })
}
