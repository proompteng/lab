import { PgClient } from '@effect/sql-pg'
import { Data, Effect, Schema } from 'effect'

import { BrokerEnvironment, type BrokerIdentity } from '../../broker/identity'
import { makeAuthorityPostgres } from './authority-shared'
import { acquireExecutionWriterFence } from '../../execution/writer-fence'
import { sha256 } from '../../hash'

export class PaperAccountHandoffError extends Data.TaggedError('PaperAccountHandoffError')<{
  readonly message: string
}> {}

export interface PaperAccountHandoff {
  readonly from: string
  readonly to: BrokerIdentity
  readonly reconciliationStaleThresholdMs: number
}

const HandoffState = Schema.Array(
  Schema.Struct({
    generation_hash: Schema.String,
    selected: Schema.Boolean,
    settled: Schema.Boolean,
  }),
)

const readHandoff = (sql: PgClient.PgClient, handoff: PaperAccountHandoff) =>
  Effect.gen(function* () {
    if (handoff.to.environment !== BrokerEnvironment.Sandbox || handoff.to.identityHash === handoff.from)
      return yield* new PaperAccountHandoffError({ message: 'PAPER handoff requires a different sandbox account' })
    const rows = yield* sql<Record<string, unknown>>`
      SELECT s.generation_hash,
        coalesce(g.broker_identity_hash = ${handoff.to.identityHash}
          AND parent.broker_identity_hash = ${handoff.from}
          AND s.maximum = 'OBSERVE' AND s.effective = 'OBSERVE'
          AND s.kill_state = 'CLEAR' AND s.reason IS NULL, false) AS selected,
        coalesce(g.broker_identity_hash = ${handoff.from}
          AND g.broker_provider = 'alpaca' AND g.broker_environment = 'sandbox'
          AND s.maximum = s.effective AND s.kill_state = 'CLEAR' AND s.reason IS NULL
          AND EXISTS (SELECT 1 FROM execution_controller_status WHERE controller_key = ${handoff.from})
          AND r.status = 'EXACT' AND r.expected_hash = r.observed_hash AND jsonb_array_length(r.discrepancies) = 0
          AND r.reconciled_at >= s.updated_at
          AND r.reconciled_at <= clock_timestamp()
          AND r.reconciled_at > clock_timestamp() - ${handoff.reconciliationStaleThresholdMs}::bigint * interval '1 millisecond'
          AND EXISTS (
            SELECT 1 FROM (
              SELECT position_count, observed_at FROM position_snapshots
              WHERE account_id = g.account_id AND ingestion_order_trusted
              ORDER BY ingestion_sequence DESC LIMIT 1
            ) snapshot WHERE snapshot.position_count = 0 AND snapshot.observed_at <= r.reconciled_at
          )
          AND NOT EXISTS (
            SELECT 1 FROM autonomous_cycles WHERE account_id = g.account_id AND state IN ('PENDING', 'ACTIVE')
          )
          AND NOT EXISTS (
            SELECT 1 FROM intents WHERE account_id = g.account_id
              AND (state <> 'TERMINAL' OR updated_at > r.reconciled_at)
          )
          AND NOT paper_account_has_unresolved_mutation(g.account_id, r.reconciled_at)
          AND NOT EXISTS (
            SELECT 1 FROM mutation_events m JOIN intents i USING (intent_id)
            WHERE i.account_id = g.account_id AND m.occurred_at > r.reconciled_at
          )
          AND NOT EXISTS (
            SELECT 1 FROM (
              SELECT DISTINCT ON (o.broker_order_id) o.status, e.observed_at
              FROM orders o JOIN broker_events e USING (event_id)
              WHERE o.account_id = g.account_id
              ORDER BY o.broker_order_id, e.source_sequence DESC
            ) order_state
            WHERE order_state.status IN ('NEW', 'PARTIALLY_FILLED', 'PENDING', 'HELD')
              OR order_state.observed_at > r.reconciled_at
          )
          AND NOT EXISTS (
            WITH unresolved AS MATERIALIZED (
              SELECT q.payload FROM jev_evaluation_requests q JOIN autonomous_cycles c USING (cycle_id)
              LEFT JOIN jev_evaluation_resolutions resolution USING (request_id)
              WHERE c.account_id = g.account_id AND resolution.request_id IS NULL
            )
            SELECT 1 FROM unresolved WHERE (payload ->> 'expiresAt')::timestamptz > clock_timestamp()
          ), false) AS settled
      FROM authority_state s JOIN authority_generations g USING (generation_hash)
      LEFT JOIN authority_generations parent ON parent.generation_hash = g.previous_generation_hash
      LEFT JOIN LATERAL (
        SELECT status, expected_hash, observed_hash, discrepancies, reconciled_at FROM reconciliations
        WHERE account_id = g.account_id ORDER BY reconciled_at DESC, reconciliation_id COLLATE "C" DESC LIMIT 1
      ) r ON true
      WHERE s.singleton
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(HandoffState)))
    const state = rows[0]
    if (state === undefined || (!state.selected && !state.settled))
      return yield* new PaperAccountHandoffError({
        message:
          'PAPER account handoff requires the configured predecessor, clear authority, a flat account and fresh exact settlement',
      })
    return state
  })

export const verifyPaperAccountHandoff = (handoff: PaperAccountHandoff) =>
  Effect.flatMap(PgClient.PgClient, (sql) => readHandoff(sql, handoff)).pipe(Effect.asVoid)

export const selectPaperAccount = (handoff: PaperAccountHandoff) =>
  Effect.flatMap(PgClient.PgClient, (sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* acquireExecutionWriterFence(sql)
        const authority = makeAuthorityPostgres(sql)
        yield* authority.lockAuthorityGenerations
        yield* sql`SELECT singleton FROM authority_state WHERE singleton FOR UPDATE`
        const state = yield* readHandoff(sql, handoff)
        if (state.selected) return

        const target = handoff.to
        const generationHash = sha256(
          ['bayn.paper-account-handoff.v1', state.generation_hash, target.identityHash].join('\u0000'),
        )
        const activatedAt = yield* authority.nextAuthorityInstant
        yield* sql`
          INSERT INTO authority_generations (
            generation_hash, schema_version, previous_generation_hash, maximum,
            authority_version, account_id, broker_identity_schema_version, broker_identity_hash,
            broker_provider, broker_environment, activated_at
          )
          SELECT ${generationHash}, 'bayn.authority-generation-history.v1', generation_hash, 'OBSERVE',
            version + 1, ${target.accountId}, ${target.schemaVersion}, ${target.identityHash},
            ${target.provider}, ${target.environment}, ${activatedAt}
          FROM authority_state WHERE singleton AND generation_hash = ${state.generation_hash}
        `
        const updated = yield* sql`
          UPDATE authority_state
          SET generation_hash = ${generationHash}, maximum = 'OBSERVE', effective = 'OBSERVE',
            version = version + 1, updated_at = ${activatedAt}
          WHERE singleton AND generation_hash = ${state.generation_hash}
          RETURNING singleton
        `
        if (updated.length !== 1)
          return yield* new PaperAccountHandoffError({
            message: 'PAPER account handoff did not select its OBSERVE generation',
          })
      }),
    ),
  )
