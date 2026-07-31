import { PgClient } from '@effect/sql-pg'
import { Context, Data, Effect, Layer, Schema } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations'
import {
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'

export interface PaperProofRecoveryRequired {
  readonly schemaVersion: 'bayn.paper-proof-recovery-required.v1'
  readonly proofPlanHash: string
  readonly qualificationRunId: string
  readonly intentId: string
  readonly operation: MutationOperation
  readonly reason: string
  readonly requiredAt: string
}

export interface PaperProofRecoveryResolution {
  readonly proofPlanHash: string
  readonly qualificationRunId: string
  readonly intentId: string
  readonly resolvedAt: string
  readonly reconciliationId: string
  readonly reconciliationContentHash: string
}

export interface PaperProofRecoveryStoreService {
  readonly require: (input: PaperProofRecoveryRequired) => Effect.Effect<void, PaperProofRecoveryStoreError>
  readonly readRequired: (input: {
    readonly proofPlanHash: string
    readonly intentId: string
  }) => Effect.Effect<PaperProofRecoveryRequired | undefined, PaperProofRecoveryStoreError>
  readonly resolve: (input: PaperProofRecoveryResolution) => Effect.Effect<void, PaperProofRecoveryStoreError>
}

export class PaperProofRecoveryStoreError extends Data.TaggedError('PaperProofRecoveryStoreError')<{
  readonly operation: 'initialize' | 'read' | 'require' | 'resolve'
  readonly failure: 'conflict' | 'decode' | 'invariant' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

export class PaperProofRecoveryStore extends Context.Service<
  PaperProofRecoveryStore,
  PaperProofRecoveryStoreService
>()('bayn/PaperProofRecoveryStore') {}

const RecoveryRowSchema = Schema.Struct({
  schema_version: Schema.Literal('bayn.paper-proof-recovery-required.v1'),
  proof_plan_hash: Sha256Schema,
  qualification_run_id: Sha256Schema,
  intent_id: Sha256Schema,
  operation: Schema.Enum(MutationOperation),
  reason: StrictNonEmptyStringSchema,
  required_at: UtcInstantSchema,
  resolved_at: Schema.NullOr(UtcInstantSchema),
  reconciliation_id: Schema.NullOr(Sha256Schema),
  reconciliation_content_hash: Schema.NullOr(Sha256Schema),
})
type RecoveryRow = typeof RecoveryRowSchema.Type

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(RecoveryRowSchema), strictParseOptions)

const storeError = (
  operation: PaperProofRecoveryStoreError['operation'],
  failure: PaperProofRecoveryStoreError['failure'],
  message: string,
  cause?: unknown,
): PaperProofRecoveryStoreError => new PaperProofRecoveryStoreError({ operation, failure, message, cause })

const query = <A>(
  operation: PaperProofRecoveryStoreError['operation'],
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, PaperProofRecoveryStoreError> =>
  effect.pipe(
    Effect.mapError((cause) => storeError(operation, 'query', `paper proof recovery ${operation} query failed`, cause)),
  )

const initialize = (sql: PgClient.PgClient): Effect.Effect<void, PaperProofRecoveryStoreError> =>
  query(
    'initialize',
    sql`
      CREATE TABLE IF NOT EXISTS paper_proof_recovery_required (
        proof_plan_hash text NOT NULL,
        intent_id text NOT NULL,
        schema_version text NOT NULL,
        qualification_run_id text NOT NULL,
        operation text NOT NULL,
        reason text NOT NULL,
        required_at timestamptz NOT NULL,
        resolved_at timestamptz,
        reconciliation_id text,
        reconciliation_content_hash text,
        PRIMARY KEY (proof_plan_hash, intent_id),
        CHECK (schema_version = 'bayn.paper-proof-recovery-required.v1'),
        CHECK (operation IN ('submit', 'cancel')),
        CHECK (length(reason) BETWEEN 1 AND 240)
      )
    `,
  ).pipe(Effect.asVoid)

const selectRows = (
  sql: PgClient.PgClient,
  proofPlanHash: string,
  intentId: string,
): Effect.Effect<readonly RecoveryRow[], PaperProofRecoveryStoreError> =>
  query(
    'read',
    sql`
      SELECT
        schema_version,
        proof_plan_hash,
        qualification_run_id,
        intent_id,
        operation,
        reason,
        to_char(required_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS required_at,
        CASE
          WHEN resolved_at IS NULL THEN NULL
          ELSE to_char(resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS resolved_at,
        reconciliation_id,
        reconciliation_content_hash
      FROM paper_proof_recovery_required
      WHERE proof_plan_hash = ${proofPlanHash} AND intent_id = ${intentId}
    `,
  ).pipe(
    Effect.flatMap((rows) =>
      decodeRows(rows).pipe(
        Effect.mapError((cause) => storeError('read', 'decode', 'paper proof recovery row is invalid', cause)),
      ),
    ),
  )

const requiredFromRow = (row: RecoveryRow): PaperProofRecoveryRequired => ({
  schemaVersion: row.schema_version,
  proofPlanHash: row.proof_plan_hash,
  qualificationRunId: row.qualification_run_id,
  intentId: row.intent_id,
  operation: row.operation,
  reason: row.reason,
  requiredAt: row.required_at,
})

const readRequired = (
  sql: PgClient.PgClient,
  input: { readonly proofPlanHash: string; readonly intentId: string },
): Effect.Effect<PaperProofRecoveryRequired | undefined, PaperProofRecoveryStoreError> =>
  initialize(sql).pipe(
    Effect.andThen(selectRows(sql, input.proofPlanHash, input.intentId)),
    Effect.flatMap((rows) => {
      const [row] = rows
      if (rows.length > 1) {
        return Effect.fail(
          storeError('read', 'invariant', 'paper proof recovery identity returned multiple rows'),
        )
      }
      return Effect.succeed(row === undefined || row.resolved_at !== null ? undefined : requiredFromRow(row))
    }),
  )

const requireRecovery = (
  sql: PgClient.PgClient,
  input: PaperProofRecoveryRequired,
): Effect.Effect<void, PaperProofRecoveryStoreError> =>
  initialize(sql).pipe(
    Effect.andThen(
      query(
        'require',
        sql`
          INSERT INTO paper_proof_recovery_required (
            proof_plan_hash,
            intent_id,
            schema_version,
            qualification_run_id,
            operation,
            reason,
            required_at,
            resolved_at,
            reconciliation_id,
            reconciliation_content_hash
          ) VALUES (
            ${input.proofPlanHash},
            ${input.intentId},
            ${input.schemaVersion},
            ${input.qualificationRunId},
            ${input.operation},
            ${input.reason},
            ${input.requiredAt},
            NULL,
            NULL,
            NULL
          )
          ON CONFLICT (proof_plan_hash, intent_id) DO UPDATE
          SET
            operation = EXCLUDED.operation,
            reason = EXCLUDED.reason,
            required_at = LEAST(paper_proof_recovery_required.required_at, EXCLUDED.required_at),
            resolved_at = NULL,
            reconciliation_id = NULL,
            reconciliation_content_hash = NULL
          WHERE
            paper_proof_recovery_required.schema_version = EXCLUDED.schema_version
            AND paper_proof_recovery_required.qualification_run_id = EXCLUDED.qualification_run_id
        `,
      ),
    ),
    Effect.andThen(selectRows(sql, input.proofPlanHash, input.intentId)),
    Effect.flatMap((rows) => {
      const [row] = rows
      if (
        rows.length !== 1 ||
        row === undefined ||
        row.resolved_at !== null ||
        row.qualification_run_id !== input.qualificationRunId ||
        row.operation !== input.operation
      ) {
        return Effect.fail(
          storeError('require', 'conflict', 'paper proof recovery requirement conflicts with durable evidence'),
        )
      }
      return Effect.void
    }),
  )

const resolveRecovery = (
  sql: PgClient.PgClient,
  input: PaperProofRecoveryResolution,
): Effect.Effect<void, PaperProofRecoveryStoreError> =>
  initialize(sql).pipe(
    Effect.andThen(
      query(
        'resolve',
        sql`
          UPDATE paper_proof_recovery_required
          SET
            resolved_at = ${input.resolvedAt},
            reconciliation_id = ${input.reconciliationId},
            reconciliation_content_hash = ${input.reconciliationContentHash}
          WHERE
            proof_plan_hash = ${input.proofPlanHash}
            AND intent_id = ${input.intentId}
            AND qualification_run_id = ${input.qualificationRunId}
            AND (
              resolved_at IS NULL
              OR (
                resolved_at = ${input.resolvedAt}
                AND reconciliation_id = ${input.reconciliationId}
                AND reconciliation_content_hash = ${input.reconciliationContentHash}
              )
            )
        `,
      ),
    ),
    Effect.andThen(selectRows(sql, input.proofPlanHash, input.intentId)),
    Effect.flatMap((rows) => {
      const [row] = rows
      if (
        rows.length !== 1 ||
        row === undefined ||
        row.qualification_run_id !== input.qualificationRunId ||
        row.resolved_at !== input.resolvedAt ||
        row.reconciliation_id !== input.reconciliationId ||
        row.reconciliation_content_hash !== input.reconciliationContentHash
      ) {
        return Effect.fail(
          storeError('resolve', 'conflict', 'paper proof recovery resolution conflicts with durable evidence'),
        )
      }
      return Effect.void
    }),
  )

export const makePaperProofRecoveryStore = (sql: PgClient.PgClient): PaperProofRecoveryStoreService => ({
  require: (input) => requireRecovery(sql, input),
  readRequired: (input) => readRequired(sql, input),
  resolve: (input) => resolveRecovery(sql, input),
})

export const PaperProofRecoveryStoreLive = Layer.effect(
  PaperProofRecoveryStore,
  Effect.map(PgClient.PgClient, makePaperProofRecoveryStore),
)
