import { PgClient } from '@effect/sql-pg'
import { Schema } from 'effect'
import { SqlSchema } from 'effect/unstable/sql'

import { QualificationLockSchema, QualificationResultSchema } from '../../qualification'

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const GitRevision = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))
const ImageDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const QualificationTrialRow = Schema.Struct({ run_id: Sha256 })
const QualificationRow = Schema.Struct({
  lock_payload: QualificationLockSchema,
  result_payload: Schema.NullOr(QualificationResultSchema),
})
export type DecodedQualificationRow = typeof QualificationRow.Type

const CandidateRunCountRow = Schema.Struct({ count: NonNegativeInteger })
const InsertedLockRow = Schema.Struct({ lock_id: Sha256 })
const InsertedResultRow = Schema.Struct({ lock_id: Sha256 })

export const makeQualificationStatements = (sql: PgClient.PgClient) => {
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

  return {
    getPriorTrials,
    getQualificationByCandidate,
    getQualificationByIdentity,
    insertQualificationLock,
    insertQualificationResult,
    getCandidateRunCount,
    getIncompleteQualificationCount,
  }
}

export type QualificationStatements = ReturnType<typeof makeQualificationStatements>
