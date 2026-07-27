import { Result, Schema } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
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

const itemCount = (artifactName: string, payload: unknown): Result.Result<number, QualificationDossierFailure> =>
  Result.try({
    try: () => {
      if (typeof payload !== 'object' || payload === null || !('items' in payload)) return 0
      return Array.isArray(payload.items) ? payload.items.length : 0
    },
    catch: (cause): QualificationDossierFailure => ({
      _tag: 'QualificationDossierEvidenceInspectionFailed',
      artifactName,
      operation: 'item-count',
      cause,
    }),
  })

interface QualificationDossierEvidenceSummary {
  readonly artifacts: readonly {
    readonly name: string
    readonly schemaVersion: string
    readonly itemCount: number
    readonly contentHash: string
  }[]
  readonly events: { readonly count: number; readonly contentHash: string }
  readonly gates: { readonly count: number; readonly contentHash: string }
  readonly statuses: { readonly count: number; readonly contentHash: string }
}

export type QualificationDossierFailure =
  | QualificationAuditFailure
  | {
      readonly _tag: 'QualificationDossierCanonicalizationFailed'
      readonly subject: QualificationDossierCanonicalizationSubject
      readonly cause: CanonicalHashFailure
    }
  | {
      readonly _tag: 'QualificationDossierEvidenceInspectionFailed'
      readonly artifactName: string
      readonly operation: 'item-count'
      readonly cause: unknown
    }
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

export interface QualificationDossierCanonicalizationSubject {
  readonly scope: 'audit' | 'dossier' | 'evidence' | 'lineage'
  readonly name: string
}

const hashDossierMaterial = (
  subject: QualificationDossierCanonicalizationSubject,
  value: unknown,
): Result.Result<string, QualificationDossierFailure> =>
  Result.mapError(
    canonicalHashV1Result(value),
    (cause): QualificationDossierFailure => ({
      _tag: 'QualificationDossierCanonicalizationFailed',
      subject,
      cause,
    }),
  )

const evidenceSummary = (
  database: AuditDatabaseSnapshot,
): Result.Result<QualificationDossierEvidenceSummary, QualificationDossierFailure> =>
  Result.gen(function* () {
    const artifacts = yield* Result.all(
      database.artifacts.map((artifact) =>
        Result.map(itemCount(artifact.name, artifact.payload), (count) => ({
          name: artifact.name,
          schemaVersion: artifact.schemaVersion,
          itemCount: count,
          contentHash: artifact.contentHash,
        })),
      ),
    )
    const eventsHash = yield* hashDossierMaterial(
      { scope: 'evidence', name: 'events' },
      database.events.map(({ ordinal, id, kind, contentHash }) => ({ ordinal, id, kind, contentHash })),
    )
    const gatesHash = yield* hashDossierMaterial(
      { scope: 'evidence', name: 'gates' },
      database.gates.map(({ ordinal, name, passed, contentHash }) => ({ ordinal, name, passed, contentHash })),
    )
    const statusesHash = yield* hashDossierMaterial({ scope: 'evidence', name: 'statuses' }, database.statuses)
    return {
      artifacts: [...artifacts].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
      events: { count: database.events.length, contentHash: eventsHash },
      gates: { count: database.gates.length, contentHash: gatesHash },
      statuses: { count: database.statuses.length, contentHash: statusesHash },
    }
  })

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
): Result.Result<void, QualificationDossierFailure> =>
  Result.gen(function* () {
    const auditMaterial = Object.fromEntries(Object.entries(audit).filter(([name]) => name !== 'auditHash'))
    const expectedAuditHash = yield* hashDossierMaterial({ scope: 'audit', name: 'report' }, auditMaterial)
    const checks = [
      requireEqual('audit-passed', audit.status === 'PASS' && audit.checks.every((check) => check.passed), true),
      requireEqual('audit-hash', audit.auditHash, expectedAuditHash),
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
    for (const check of checks) yield* check
  })

export interface QualificationDossier {
  readonly schemaVersion: 'bayn.qualification-dossier.v2'
  readonly subject: {
    readonly run: AuditDatabaseSnapshot['run']
    readonly protocol: AuditDatabaseSnapshot['protocol']
    readonly inputManifest: InputManifest
  }
  readonly evidence: QualificationDossierEvidenceSummary & { readonly endpoint: string }
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
): Result.Result<QualificationDossier, QualificationDossierFailure> =>
  Result.gen(function* () {
    const audit = yield* auditQualification(input)
    const database = input.database
    yield* validateSubject(database, input.manifest, audit)
    const lock = yield* Result.mapError(
      decodeLock(database.qualification.lock),
      (cause): QualificationDossierFailure => ({
        _tag: 'QualificationDossierDocumentInvalid',
        document: 'lock',
        cause,
      }),
    )
    const result = yield* Result.mapError(
      decodeResult(database.qualification.result),
      (cause): QualificationDossierFailure => ({
        _tag: 'QualificationDossierDocumentInvalid',
        document: 'result',
        cause,
      }),
    )
    const lockLineageHash = yield* hashDossierMaterial(
      { scope: 'lineage', name: 'lock-prior-trials' },
      lock.priorTrialRunIds,
    )
    const databaseLineageHash = yield* hashDossierMaterial(
      { scope: 'lineage', name: 'database-prior-trials' },
      database.priorTrialRunIds,
    )
    const bindingChecks = [
      requireEqual('lock-run-id', lock.candidateRunId, database.run.runId),
      requireEqual('result-run-id', result.runId, database.run.runId),
      requireEqual('stored-lock-id', lock.lockId, database.qualification.storedLockId),
      requireEqual('result-lock-id', result.lockId, lock.lockId),
      requireEqual('stored-analysis-hash', result.analysis.analysisHash, database.qualification.storedAnalysisHash),
      requireEqual('stored-result-hash', result.resultHash, database.qualification.storedResultHash),
      requireEqual('stored-verdict', result.verdict, database.qualification.storedVerdict),
      requireEqual('trial-lineage', lockLineageHash, databaseLineageHash),
    ]
    for (const check of bindingChecks) yield* check

    const summary = yield* evidenceSummary(database)
    const material = {
      schemaVersion: 'bayn.qualification-dossier.v2' as const,
      subject: {
        run: database.run,
        protocol: database.protocol,
        inputManifest: input.manifest,
      },
      evidence: {
        endpoint: `/v1/evaluations/${database.run.runId}`,
        ...summary,
      },
      qualification: {
        lockCreatedAt: database.qualification.lockCreatedAt,
        resultCommittedAt: database.qualification.resultCommittedAt,
        priorTrialRunIds: database.priorTrialRunIds,
        priorTrialSetHash: databaseLineageHash,
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
    const dossierHash = yield* hashDossierMaterial({ scope: 'dossier', name: 'document' }, material)
    return { ...material, dossierHash }
  })
