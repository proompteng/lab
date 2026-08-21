import { PgClient } from '@effect/sql-pg'
import { Data, Effect, Option, Schema } from 'effect'

import type { OpeningDriveQualificationRun } from '../strategy/opening-drive/qualification-model'
import type {
  OpeningDriveQualificationLock,
  OpeningDriveQualificationVersionedSession,
} from '../strategy/opening-drive/qualification-runner'

export class OpeningDriveQualificationStoreError extends Data.TaggedError('OpeningDriveQualificationStoreError')<{
  readonly operation: 'prior-trials' | 'incomplete-lock' | 'open' | 'persist'
  readonly failure: 'query' | 'conflict' | 'invariant' | 'decode'
  readonly message: string
  readonly cause?: unknown
}> {}

const error = (
  operation: OpeningDriveQualificationStoreError['operation'],
  failure: OpeningDriveQualificationStoreError['failure'],
  message: string,
  cause?: unknown,
): OpeningDriveQualificationStoreError =>
  new OpeningDriveQualificationStoreError({ operation, failure, message, cause })

const HashRow = Schema.Struct({ receipt_hash: Schema.String })
const ExistingResultRow = Schema.Struct({ receipt_hash: Schema.String })
const IncompleteLockRow = Schema.Struct({ lock_id: Schema.String })
const CandidateRow = Schema.Struct({
  lock_id: Schema.String,
  receipt_hash: Schema.NullOr(Schema.String),
  verdict: Schema.NullOr(Schema.Literals(['QUALIFIED', 'REJECTED', 'INSUFFICIENT'])),
  session_count: Schema.NullOr(Schema.Int),
})
const VersionHashRow = Schema.Struct({
  session_date: Schema.String,
  opening_request_hash: Schema.String,
  exit_request_hash: Schema.String,
})
const decodeHashRows = Schema.decodeUnknownEffect(Schema.Array(HashRow))
const decodeExistingResultRows = Schema.decodeUnknownEffect(
  Schema.Array(ExistingResultRow).check(Schema.isMaxLength(1)),
)
const decodeIncompleteLockRows = Schema.decodeUnknownEffect(Schema.Array(IncompleteLockRow))
const decodeCandidateRows = Schema.decodeUnknownEffect(Schema.Array(CandidateRow).check(Schema.isMaxLength(1)))
const decodeVersionHashRows = Schema.decodeUnknownEffect(Schema.Array(VersionHashRow))
const encodeSqlJson = Schema.encodeSync(Schema.UnknownFromJsonString)

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const mapQueryFailure = (operation: OpeningDriveQualificationStoreError['operation'], message: string) =>
  Effect.mapError((cause: unknown) =>
    cause instanceof OpeningDriveQualificationStoreError ? cause : error(operation, 'query', message, cause),
  )

export const readOpeningDrivePriorTrialReceiptHashes = (
  sql: PgClient.PgClient,
): Effect.Effect<readonly string[], OpeningDriveQualificationStoreError> =>
  sql<Record<string, unknown>>`
    SELECT receipt_hash
    FROM opening_drive_qualification_results
    ORDER BY receipt_hash
  `.pipe(
    Effect.flatMap(decodeHashRows),
    Effect.map((rows) => Object.freeze(rows.map(({ receipt_hash }) => receipt_hash))),
    Effect.mapError((cause) =>
      cause instanceof OpeningDriveQualificationStoreError
        ? cause
        : error('prior-trials', 'decode', 'opening-drive prior trial receipt hashes could not be decoded', cause),
    ),
    mapQueryFailure('prior-trials', 'opening-drive prior trial receipt query failed'),
  )

export const readIncompleteOpeningDriveQualificationLockId = (
  sql: PgClient.PgClient,
): Effect.Effect<Option.Option<string>, OpeningDriveQualificationStoreError> =>
  Effect.gen(function* () {
    const rows = yield* decodeIncompleteLockRows(
      yield* sql<Record<string, unknown>>`
        SELECT lock.lock_id
        FROM opening_drive_qualification_locks AS lock
        LEFT JOIN opening_drive_qualification_results AS result ON result.lock_id = lock.lock_id
        WHERE result.lock_id IS NULL
        ORDER BY lock.created_at, lock.lock_id
        LIMIT 2
      `,
    )
    if (rows.length > 1) {
      return yield* error('incomplete-lock', 'invariant', 'multiple incomplete opening-drive qualification locks exist')
    }
    const row = rows[0]
    if (row === undefined) return Option.none()
    return Option.some(row.lock_id)
  }).pipe(mapQueryFailure('incomplete-lock', 'incomplete opening-drive qualification lock query failed'))

export const openOpeningDriveQualification = (
  sql: PgClient.PgClient,
  lock: OpeningDriveQualificationLock,
  versions: readonly OpeningDriveQualificationVersionedSession[],
): Effect.Effect<
  | { readonly state: 'ACQUIRED'; readonly lockId: string }
  | {
      readonly state: 'TERMINAL'
      readonly lockId: string
      readonly receiptHash: string
      readonly verdict: 'QUALIFIED' | 'REJECTED' | 'INSUFFICIENT'
      readonly sessionCount: number
    },
  OpeningDriveQualificationStoreError
> =>
  sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`LOCK TABLE opening_drive_qualification_locks IN SHARE ROW EXCLUSIVE MODE`
        const incomplete = yield* decodeIncompleteLockRows(
          yield* sql<Record<string, unknown>>`
          SELECT lock.lock_id
          FROM opening_drive_qualification_locks AS lock
          LEFT JOIN opening_drive_qualification_results AS result ON result.lock_id = lock.lock_id
          WHERE result.lock_id IS NULL
          ORDER BY lock.created_at, lock.lock_id
        `,
        )
        const candidateRows = yield* decodeCandidateRows(
          yield* sql<Record<string, unknown>>`
            SELECT
              lock.lock_id,
              result.receipt_hash,
              result.verdict,
              CASE WHEN result.lock_id IS NULL THEN NULL ELSE (result.document ->> 'sessionCount')::integer END AS session_count
            FROM opening_drive_qualification_locks AS lock
            LEFT JOIN opening_drive_qualification_results AS result ON result.lock_id = lock.lock_id
            WHERE lock.candidate_key = ${lock.candidateKey}
          `,
        )
        const existingCandidate = candidateRows[0]
        const foreignIncomplete = incomplete.find(({ lock_id }) => lock_id !== existingCandidate?.lock_id)
        if (foreignIncomplete !== undefined) {
          return yield* error(
            'open',
            'conflict',
            'an opening-drive qualification lock is opened incomplete and blocks every later trial',
          )
        }
        if (
          existingCandidate !== undefined &&
          existingCandidate.receipt_hash !== null &&
          existingCandidate.verdict !== null &&
          existingCandidate.session_count !== null
        ) {
          return {
            state: 'TERMINAL' as const,
            lockId: existingCandidate.lock_id,
            receiptHash: existingCandidate.receipt_hash,
            verdict: existingCandidate.verdict,
            sessionCount: existingCandidate.session_count,
          }
        }
        if (existingCandidate !== undefined) {
          return yield* error(
            'open',
            'conflict',
            'opening-drive candidate is already opened incomplete and cannot be retried',
          )
        }
        const priorRows = yield* decodeHashRows(
          yield* sql<Record<string, unknown>>`
          SELECT receipt_hash
          FROM opening_drive_qualification_results
          ORDER BY receipt_hash
        `,
        )
        const prior = priorRows.map(({ receipt_hash }) => receipt_hash)
        if (!sameStrings(prior, lock.binding.priorTrialReceiptHashes)) {
          return yield* error(
            'open',
            'conflict',
            'opening-drive qualification prior-trial lineage changed before the immutable lock was acquired',
          )
        }

        if (incomplete.length > 0) {
          return yield* error(
            'open',
            'conflict',
            'an opening-drive qualification lock is opened incomplete and blocks every later trial',
          )
        }

        yield* sql`
        INSERT INTO opening_drive_qualification_locks (
          lock_id, candidate_key, schema_version, source_revision, strategy_behavior_hash,
          protocol_hash, policy_hash, cost_model_hash, evaluation_calendar_hash,
          replay_version_graph_hash, first_session, last_session,
          prior_trial_receipt_hashes, binding, calendar
        ) VALUES (
          ${lock.lockId}, ${lock.candidateKey}, ${lock.schemaVersion}, ${lock.binding.sourceRevision}, ${lock.binding.strategyBehaviorHash},
          ${lock.binding.protocolHash}, ${lock.binding.policyHash}, ${lock.binding.costModelHash},
          ${lock.binding.evaluationCalendarHash}, ${lock.binding.replayVersionGraphHash},
          ${lock.calendar.firstSession}, ${lock.calendar.lastSession},
          ${sql.json(encodeSqlJson(lock.binding.priorTrialReceiptHashes))}, ${sql.json(lock.binding)}, ${sql.json(lock.calendar)}
        )
        ON CONFLICT (lock_id) DO NOTHING
      `

        yield* Effect.forEach(
          versions,
          (version) => sql`
          INSERT INTO opening_drive_qualification_replay_versions (
            lock_id, session_date, opening_request_hash, exit_request_hash, opening_request, exit_request
          ) VALUES (
            ${lock.lockId}, ${version.sessionDate}, ${version.version.openingRequestHash}, ${version.version.exitRequestHash},
            ${sql.json(version.openingRequest)}, ${sql.json(version.exitRequest)}
          )
          ON CONFLICT (lock_id, session_date) DO NOTHING
        `,
          { discard: true },
        )
        const storedVersions = yield* decodeVersionHashRows(
          yield* sql<Record<string, unknown>>`
          SELECT session_date::text AS session_date, opening_request_hash, exit_request_hash
          FROM opening_drive_qualification_replay_versions
          WHERE lock_id = ${lock.lockId}
          ORDER BY session_date
        `,
        )
        const expectedVersions = versions.map((version) => ({
          session_date: version.sessionDate,
          opening_request_hash: version.version.openingRequestHash,
          exit_request_hash: version.version.exitRequestHash,
        }))
        if (JSON.stringify(storedVersions) !== JSON.stringify(expectedVersions)) {
          return yield* error('open', 'conflict', 'stored opening-drive replay versions differ from the immutable lock')
        }
        return { state: 'ACQUIRED' as const, lockId: lock.lockId }
      }),
    )
    .pipe(mapQueryFailure('open', 'opening-drive qualification lock transaction failed'))

export const persistOpeningDriveQualification = (
  sql: PgClient.PgClient,
  lock: OpeningDriveQualificationLock,
  run: OpeningDriveQualificationRun,
): Effect.Effect<'PERSISTED' | 'EXISTING', OpeningDriveQualificationStoreError> =>
  sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`LOCK TABLE opening_drive_qualification_locks IN SHARE ROW EXCLUSIVE MODE`
        const existing = yield* decodeExistingResultRows(
          yield* sql<Record<string, unknown>>`
          SELECT receipt_hash
          FROM opening_drive_qualification_results
          WHERE lock_id = ${lock.lockId}
        `,
        )
        const row = existing[0]
        if (row !== undefined) {
          if (row.receipt_hash !== run.receipt.receiptHash) {
            return yield* error('persist', 'conflict', 'opening-drive qualification lock already has another result')
          }
          return 'EXISTING' as const
        }
        if (
          run.receipt.protocolHash !== lock.binding.protocolHash ||
          run.receipt.policyHash !== lock.binding.policyHash ||
          run.receipt.costModelHash !== lock.binding.costModelHash ||
          run.receipt.calendarHash !== lock.binding.evaluationCalendarHash ||
          run.receipt.sourceRevision !== lock.binding.sourceRevision ||
          run.receipt.strategyBehaviorHash !== lock.binding.strategyBehaviorHash ||
          run.receipt.sessionCount !== run.sessions.length ||
          run.receipt.firstSession !== lock.calendar.firstSession ||
          run.receipt.lastSession !== lock.calendar.lastSession
        ) {
          return yield* error(
            'persist',
            'invariant',
            'opening-drive qualification result does not match its immutable lock',
          )
        }

        yield* sql`
        INSERT INTO opening_drive_qualification_results (lock_id, receipt_hash, verdict, document)
        VALUES (${lock.lockId}, ${run.receipt.receiptHash}, ${run.receipt.verdict}, ${sql.json(run.receipt)})
      `
        yield* Effect.forEach(
          run.sessions,
          (session) => sql`
          INSERT INTO opening_drive_qualification_session_replays (lock_id, session_date, receipt_hash, document)
          VALUES (${lock.lockId}, ${session.sessionDate}, ${session.receiptHash}, ${sql.json(session)})
        `,
          { discard: true },
        )
        return 'PERSISTED' as const
      }),
    )
    .pipe(mapQueryFailure('persist', 'opening-drive qualification result transaction failed'))
