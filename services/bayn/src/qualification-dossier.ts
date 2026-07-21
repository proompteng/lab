import { Schema } from 'effect'

import { canonicalHashV1 } from './hash'
import { QualificationLockSchema, QualificationResultSchema } from './qualification'
import {
  auditQualification,
  type AuditDatabaseSnapshot,
  type QualificationAuditInput,
  type QualificationAuditReport,
} from './qualification-audit'
import type { InputManifest } from './types'

const StrictParseOptions = { onExcessProperty: 'error' } as const
const decodeLock = Schema.decodeUnknownSync(QualificationLockSchema, StrictParseOptions)
const decodeResult = Schema.decodeUnknownSync(QualificationResultSchema, StrictParseOptions)

const itemCount = (payload: unknown): number => {
  if (typeof payload !== 'object' || payload === null || !('items' in payload)) return 0
  return Array.isArray(payload.items) ? payload.items.length : 0
}

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message)
}

const evidenceSummary = (database: AuditDatabaseSnapshot) => ({
  artifacts: database.artifacts
    .map((artifact) => ({
      name: artifact.name,
      schemaVersion: artifact.schemaVersion,
      itemCount: itemCount(artifact.payload),
      contentHash: artifact.contentHash,
    }))
    .sort((left, right) => left.name.localeCompare(right.name)),
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

const validateSubject = (
  database: AuditDatabaseSnapshot,
  manifest: InputManifest,
  audit: QualificationAuditReport,
): void => {
  const auditMaterial = Object.fromEntries(Object.entries(audit).filter(([name]) => name !== 'auditHash'))
  assert(audit.status === 'PASS' && audit.checks.every((check) => check.passed), 'qualification audit did not pass')
  assert(audit.auditHash === canonicalHashV1(auditMaterial), 'qualification audit hash is invalid')
  assert(database.transactionReadOnly, 'qualification database snapshot was not read-only')
  assert(database.run.status === 'COMPLETE', 'qualification evaluation is not complete')
  assert(database.run.runId === audit.runId, 'qualification audit and evaluation run IDs differ')
  assert(database.run.protocolHash === database.protocol.protocolHash, 'run and protocol hashes differ')
  assert(database.run.snapshotId === manifest.finalizedSnapshot.snapshotId, 'run and Signal snapshot IDs differ')
  assert(database.run.artifactCount === database.artifacts.length, 'artifact count differs from the stored run')
  assert(database.run.eventCount === database.events.length, 'event count differs from the stored run')
  assert(database.run.gateCount === database.gates.length, 'gate count differs from the stored run')
  assert(audit.evidence.artifactCount === database.artifacts.length, 'audit artifact count differs')
  assert(audit.evidence.eventCount === database.events.length, 'audit event count differs')
  assert(audit.evidence.gateCount === database.gates.length, 'audit gate count differs')
}

export interface QualificationDossier {
  readonly schemaVersion: 'bayn.qualification-dossier.v1'
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
    readonly lock: ReturnType<typeof decodeLock>
    readonly result: ReturnType<typeof decodeResult>
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

export const makeQualificationDossier = (input: QualificationAuditInput): QualificationDossier => {
  const audit = auditQualification(input)
  const database = input.database
  validateSubject(database, input.manifest, audit)
  const lock = decodeLock(database.qualification.lock)
  const result = decodeResult(database.qualification.result)
  assert(lock.candidateRunId === database.run.runId, 'qualification lock and evaluation run IDs differ')
  assert(result.runId === database.run.runId, 'qualification result and evaluation run IDs differ')
  assert(lock.lockId === database.qualification.storedLockId, 'qualification lock ID differs from its row')
  assert(result.lockId === lock.lockId, 'qualification result and lock IDs differ')
  assert(
    result.analysis.analysisHash === database.qualification.storedAnalysisHash,
    'analysis hash differs from its row',
  )
  assert(result.resultHash === database.qualification.storedResultHash, 'result hash differs from its row')
  assert(result.verdict === database.qualification.storedVerdict, 'qualification verdict differs from its row')
  assert(canonicalHashV1(lock.priorTrialRunIds) === canonicalHashV1(database.priorTrialRunIds), 'trial lineage differs')

  const material = {
    schemaVersion: 'bayn.qualification-dossier.v1' as const,
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
  return { ...material, dossierHash: canonicalHashV1(material) }
}
