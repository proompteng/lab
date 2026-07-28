import { PgClient } from '@effect/sql-pg'
import { Effect, Option } from 'effect'

import { decodeSingleQualification, liftQualificationResult } from './boundary'
import { databaseError, ensure, runDatabase } from './errors'
import type { EvidenceStoreService } from './model'
import {
  validateQualificationLineage,
  validateQualificationLockMatch,
  validateQualificationOpenInput,
  renderQualificationDecisionFailure,
} from './qualification'
import type { QualificationStatements } from './qualification-statements'
import type { EvidenceReferencePrograms } from './reference-programs'

export interface QualificationPrograms {
  readonly listPriorTrials: EvidenceStoreService['listPriorTrials']
  readonly openQualification: EvidenceStoreService['openQualification']
  readonly readQualification: EvidenceStoreService['readQualification']
}

export const makeQualificationPrograms = (
  sql: PgClient.PgClient,
  statements: QualificationStatements,
  references: EvidenceReferencePrograms,
): QualificationPrograms => {
  const listPriorTrials = runDatabase(
    'list-prior-trials',
    statements.getPriorTrials(undefined).pipe(Effect.map((rows) => rows.map((row) => row.run_id))),
  )

  const readQualification: EvidenceStoreService['readQualification'] = (candidateRunId) =>
    runDatabase(
      'read-qualification',
      Effect.gen(function* () {
        const rows = yield* statements.getQualificationByCandidate({ candidateRunId })
        return yield* decodeSingleQualification(rows, 'read-qualification')
      }),
    )

  const openQualification: EvidenceStoreService['openQualification'] = (input) =>
    runDatabase(
      'open-qualification',
      Effect.gen(function* () {
        const plan = yield* Effect.fromResult(validateQualificationOpenInput(input)).pipe(
          Effect.mapError((cause) =>
            databaseError('invariant', 'open-qualification', renderQualificationDecisionFailure(cause), cause),
          ),
        )
        const lock = plan.lock
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* references.ensureProtocolReference({
              protocolHash: lock.protocolHash,
              provenance: plan.provenance,
              parameters: plan.parameters,
            })
            yield* references.ensureSnapshotReference(plan.inputManifest)
            yield* sql`LOCK TABLE qualification_trials IN SHARE MODE`
            yield* sql`LOCK TABLE qualification_locks IN SHARE ROW EXCLUSIVE MODE`

            const existingRows = yield* statements.getQualificationByIdentity({
              candidateRunId: lock.candidateRunId,
              snapshotId: lock.data.snapshotId,
            })
            const existing = yield* decodeSingleQualification(existingRows, 'open-qualification')
            if (Option.isSome(existing)) {
              yield* liftQualificationResult(
                'open-qualification',
                validateQualificationLockMatch(existing.value.lock, lock),
              )
              return existing.value
            }

            const incompleteCount = yield* statements.getIncompleteQualificationCount(undefined)
            yield* ensure(
              incompleteCount.count === 0,
              'open-qualification',
              'another qualification lock is opened without a terminal result',
            )

            const priorTrialRunIds = (yield* statements.getPriorTrials(undefined)).map((row) => row.run_id)
            yield* liftQualificationResult(
              'open-qualification',
              validateQualificationLineage(priorTrialRunIds, lock.priorTrialRunIds),
            )
            const candidateRunCount = yield* statements.getCandidateRunCount({ candidateRunId: lock.candidateRunId })
            yield* ensure(
              candidateRunCount.count === 0,
              'open-qualification',
              'candidate evaluation was observed before qualification lock acquisition',
            )

            const inserted = yield* statements.insertQualificationLock({
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

            const rows = yield* statements.getQualificationByIdentity({
              candidateRunId: lock.candidateRunId,
              snapshotId: lock.data.snapshotId,
            })
            const stored = yield* decodeSingleQualification(rows, 'open-qualification')
            if (Option.isNone(stored)) {
              return yield* Effect.fail(
                databaseError('invariant', 'open-qualification', 'conflicting qualification lock is missing'),
              )
            }
            yield* liftQualificationResult(
              'open-qualification',
              validateQualificationLockMatch(stored.value.lock, lock),
            )
            return stored.value
          }),
        )
      }),
    )

  return { listPriorTrials, openQualification, readQualification }
}
