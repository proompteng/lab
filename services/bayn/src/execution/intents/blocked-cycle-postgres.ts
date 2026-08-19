import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Schema } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../../schemas'
import {
  executionActivationExpiredRestrictionReason,
  executionMandateCompletedRestrictionReason,
  executionMandateFailureRestrictionPrefix,
  legacyExecutionActivationExpiredRestrictionReason,
  legacyExecutionMandateFailureRestrictionPattern,
  legacyExecutionMandateFailureRestrictionPrefix,
  legacyV1CompletedRestrictionReason,
} from '../mandate'
import {
  BlockedCycleIntentStore,
  BlockedCycleIntentStoreError,
  type BlockedCycleIntentStoreShape,
  type BlockedCycleIntentTerminalizationInput,
  type CurrentTerminalGenerationSettlementInput,
  type CurrentTerminalGenerationSettlementReceipt,
} from './blocked-cycle'

const InputSchema = Schema.Struct({
  authorityGenerationHash: Sha256Schema,
  cycleId: Sha256Schema,
  observedAt: UtcInstantSchema,
})

const ReceiptRows = Schema.Tuple([
  Schema.Struct({
    blocked_intent_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    expired_intent_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    terminal_intent_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    nonterminal_intent_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
])

const CurrentSettlementInputSchema = Schema.Struct({
  accountId: Schema.NonEmptyString,
  observedAt: UtcInstantSchema,
})

const CurrentSettlementRows = Schema.Tuple([
  Schema.Struct({
    authority_generation_hash: Schema.NullOr(Sha256Schema),
    blocked_cycle_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    blocked_intent_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    expired_intent_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    intent_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    terminal_intent_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    nonterminal_intent_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
])

const storeError = (
  failure: BlockedCycleIntentStoreError['failure'],
  message: string,
  cause?: unknown,
): BlockedCycleIntentStoreError => new BlockedCycleIntentStoreError({ failure, message, cause })

const classifyCause = (cause: unknown): BlockedCycleIntentStoreError => {
  if (cause instanceof BlockedCycleIntentStoreError) return cause
  if (Schema.isSchemaError(cause)) return storeError('decode', 'blocked-cycle intent evidence failed decoding', cause)
  if (isSqlError(cause)) {
    const failure =
      cause.reason._tag === 'ConstraintError' || cause.reason._tag === 'UniqueViolation' ? 'conflict' : 'query'
    return storeError(failure, 'blocked-cycle intent terminalization failed', cause)
  }
  return storeError('query', 'blocked-cycle intent terminalization failed', cause)
}

const terminalizeUntouchedApproved = (sql: PgClient.PgClient, candidate: BlockedCycleIntentTerminalizationInput) =>
  Schema.decodeUnknownEffect(
    InputSchema,
    strictParseOptions,
  )(candidate).pipe(
    Effect.flatMap((input) =>
      Effect.gen(function* () {
        const rows = yield* sql<Record<string, unknown>>`
            WITH bound_cycle AS MATERIALIZED (
              SELECT cycle.cycle_id, cycle.submission_cutoff_at
              FROM autonomous_cycles AS cycle
              JOIN autonomous_cycle_shadow_decisions AS decision
                ON decision.cycle_id = cycle.cycle_id
               AND decision.decision_hash = cycle.decision_hash
              WHERE cycle.cycle_id = ${input.cycleId}
                AND cycle.state = 'BLOCKED'
                AND cycle.terminal_at <= ${input.observedAt}
                AND decision.document ->> 'schemaVersion' = 'bayn.paper-cycle-decision.v1'
                AND decision.document ->> 'mode' = 'PAPER'
                AND decision.document #>> '{bindings,authorityGenerationHash}' = ${input.authorityGenerationHash}
              FOR UPDATE OF cycle
            ), terminalized AS (
              UPDATE intents AS intent
              SET
                state = 'TERMINAL',
                terminal_outcome = CASE
                  WHEN decision.expires_at <= ${input.observedAt}::timestamptz
                    OR cycle.submission_cutoff_at <= ${input.observedAt}::timestamptz
                  THEN 'EXPIRED'
                  ELSE 'BLOCKED'
                END,
                state_version = intent.state_version + 1,
                updated_at = GREATEST(
                  ${input.observedAt}::timestamptz,
                  intent.updated_at + interval '1 millisecond'
                )
              FROM bound_cycle AS cycle
              JOIN risk_decisions AS decision ON true
              WHERE intent.cycle_id = cycle.cycle_id
                AND intent.authority_generation_hash = ${input.authorityGenerationHash}
                AND intent.state = 'APPROVED'
                AND decision.decision_id = intent.risk_decision_id
                AND decision.intent_id = intent.intent_id
                AND NOT EXISTS (
                  SELECT 1 FROM mutation_events AS event WHERE event.intent_id = intent.intent_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM orders AS broker_order WHERE broker_order.intent_id = intent.intent_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM fills AS fill WHERE fill.intent_id = intent.intent_id
                )
              RETURNING intent.intent_id, intent.terminal_outcome
            ), counts AS (
              SELECT
                count(*) FILTER (WHERE terminal_outcome = 'BLOCKED')::integer AS blocked_intent_count,
                count(*) FILTER (WHERE terminal_outcome = 'EXPIRED')::integer AS expired_intent_count
              FROM terminalized
            )
            SELECT
              counts.blocked_intent_count,
              counts.expired_intent_count,
              count(*) FILTER (
                WHERE intent.state = 'TERMINAL' OR terminalized.intent_id IS NOT NULL
              )::integer AS terminal_intent_count,
              count(*) FILTER (
                WHERE intent.state <> 'TERMINAL' AND terminalized.intent_id IS NULL
              )::integer AS nonterminal_intent_count
            FROM counts
            JOIN bound_cycle AS cycle ON true
            LEFT JOIN intents AS intent
              ON intent.cycle_id = cycle.cycle_id
             AND intent.authority_generation_hash = ${input.authorityGenerationHash}
            LEFT JOIN terminalized ON terminalized.intent_id = intent.intent_id
            GROUP BY counts.blocked_intent_count, counts.expired_intent_count
          `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(ReceiptRows, strictParseOptions)))
        const [receipt] = rows
        if (receipt.nonterminal_intent_count !== 0) {
          return yield* storeError(
            'invariant',
            'blocked cycle retains an intent that cannot be terminalized without broker recovery',
            { nonterminalIntentCount: receipt.nonterminal_intent_count },
          )
        }
        return {
          blockedIntentCount: receipt.blocked_intent_count,
          expiredIntentCount: receipt.expired_intent_count,
          terminalIntentCount: receipt.terminal_intent_count,
        }
      }),
    ),
    Effect.mapError(classifyCause),
  )

const settleCurrentTerminalGeneration = (sql: PgClient.PgClient, candidate: CurrentTerminalGenerationSettlementInput) =>
  Schema.decodeUnknownEffect(
    CurrentSettlementInputSchema,
    strictParseOptions,
  )(candidate).pipe(
    Effect.flatMap((input) =>
      sql<Record<string, unknown>>`
        WITH current_generation AS MATERIALIZED (
          SELECT
            state.generation_hash,
            generation.account_id,
            generation.research_plan_hash,
            state.updated_at AS restricted_at,
            (
              state.reason LIKE ${`${executionMandateFailureRestrictionPrefix}%`}
              OR state.reason LIKE ${`${legacyExecutionMandateFailureRestrictionPrefix}%`}
            ) AS requires_blocked_cycle,
            state.reason ~ ${legacyExecutionMandateFailureRestrictionPattern} AS legacy_failure_restriction
          FROM authority_state AS state
          JOIN authority_generations AS generation
            ON generation.generation_hash = state.generation_hash
          WHERE state.singleton
            AND state.maximum = 'PAPER'
            AND state.effective = 'OBSERVE'
            AND state.kill_state = 'ACTIVE'
            AND (
              state.reason LIKE ${`${executionMandateFailureRestrictionPrefix}%`}
              OR state.reason LIKE ${`${legacyExecutionMandateFailureRestrictionPrefix}%`}
              OR state.reason ~ ${legacyExecutionMandateFailureRestrictionPattern}
              OR (
                state.reason IN (
                  ${executionMandateCompletedRestrictionReason},
                  ${executionActivationExpiredRestrictionReason},
                  ${legacyV1CompletedRestrictionReason},
                  ${legacyExecutionActivationExpiredRestrictionReason}
                )
                AND EXISTS (
                  SELECT 1
                  FROM autonomous_forward_performance_receipts AS receipt
                  WHERE receipt.authority_generation_hash = state.generation_hash
                )
              )
            )
            AND generation.maximum = 'PAPER'
            AND generation.activation_schema_version IN (
              'bayn.paper-authority-generation.v2',
              'bayn.paper-authority-generation.v3'
            )
            AND generation.account_id = ${input.accountId}
          FOR UPDATE OF state
        ), blocked_cycles AS MATERIALIZED (
          SELECT cycle.cycle_id, cycle.submission_cutoff_at
          FROM current_generation AS generation
          JOIN autonomous_cycles AS cycle
            ON cycle.account_id = generation.account_id
          LEFT JOIN autonomous_cycle_shadow_decisions AS decision
            ON decision.cycle_id = cycle.cycle_id
           AND decision.decision_hash = cycle.decision_hash
          WHERE cycle.state = 'BLOCKED'
            AND cycle.terminal_at <= ${input.observedAt}::timestamptz
            AND (
              NOT generation.requires_blocked_cycle
              OR cycle.terminal_at >= generation.restricted_at
            )
            AND (
              (
                decision.document ->> 'schemaVersion' = 'bayn.paper-cycle-decision.v1'
                AND decision.document ->> 'mode' = 'PAPER'
                AND decision.document #>> '{bindings,authorityGenerationHash}' = generation.generation_hash
              )
              OR (
                cycle.decision_hash IS NULL
                AND generation.research_plan_hash IS NOT NULL
                AND cycle.qualification_run_id = generation.research_plan_hash
              )
            )
          FOR UPDATE OF cycle
        ), recoverable_generation AS MATERIALIZED (
          SELECT generation.*
          FROM current_generation AS generation
          WHERE NOT generation.requires_blocked_cycle
             OR EXISTS (SELECT 1 FROM blocked_cycles)
        ), terminalized AS (
          UPDATE intents AS intent
          SET
            state = 'TERMINAL',
            terminal_outcome = CASE
              WHEN decision.expires_at <= ${input.observedAt}::timestamptz
                OR cycle.submission_cutoff_at <= ${input.observedAt}::timestamptz
              THEN 'EXPIRED'
              ELSE 'BLOCKED'
            END,
            state_version = intent.state_version + 1,
            updated_at = GREATEST(
              ${input.observedAt}::timestamptz,
              intent.updated_at + interval '1 millisecond'
            )
          FROM recoverable_generation AS generation
          JOIN blocked_cycles AS cycle ON true
          JOIN risk_decisions AS decision ON true
          WHERE intent.authority_generation_hash = generation.generation_hash
            AND intent.cycle_id = cycle.cycle_id
            AND intent.state = 'APPROVED'
            AND decision.decision_id = intent.risk_decision_id
            AND decision.intent_id = intent.intent_id
            AND NOT EXISTS (
              SELECT 1 FROM mutation_events AS event WHERE event.intent_id = intent.intent_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM orders AS broker_order WHERE broker_order.intent_id = intent.intent_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM fills AS fill WHERE fill.intent_id = intent.intent_id
            )
          RETURNING intent.intent_id, intent.terminal_outcome
        ), terminalized_counts AS (
          SELECT
            count(*) FILTER (WHERE terminal_outcome = 'BLOCKED')::integer AS blocked_intent_count,
            count(*) FILTER (WHERE terminal_outcome = 'EXPIRED')::integer AS expired_intent_count
          FROM terminalized
        ), intent_counts AS (
          SELECT
            count(intent.intent_id)::integer AS intent_count,
            count(intent.intent_id) FILTER (
              WHERE intent.state = 'TERMINAL' OR terminalized.intent_id IS NOT NULL
            )::integer AS terminal_intent_count,
            count(intent.intent_id) FILTER (
              WHERE intent.state <> 'TERMINAL' AND terminalized.intent_id IS NULL
            )::integer AS nonterminal_intent_count
          FROM recoverable_generation AS generation
          LEFT JOIN intents AS intent
            ON intent.authority_generation_hash = generation.generation_hash
          LEFT JOIN terminalized ON terminalized.intent_id = intent.intent_id
        ), canonicalized_authority AS (
          UPDATE authority_state AS state
          SET
            reason = ${executionMandateFailureRestrictionPrefix} || ' ' || state.reason,
            version = state.version + 1,
            updated_at = GREATEST(
              ${input.observedAt}::timestamptz,
              state.updated_at + interval '1 millisecond'
            )
          FROM recoverable_generation AS generation
          WHERE state.singleton
            AND state.generation_hash = generation.generation_hash
            AND generation.legacy_failure_restriction
          RETURNING state.generation_hash
        )
        SELECT
          (SELECT generation_hash FROM recoverable_generation) AS authority_generation_hash,
          (SELECT count(*)::integer FROM blocked_cycles) AS blocked_cycle_count,
          terminalized_counts.blocked_intent_count,
          terminalized_counts.expired_intent_count,
          intent_counts.intent_count,
          intent_counts.terminal_intent_count,
          intent_counts.nonterminal_intent_count
        FROM terminalized_counts, intent_counts
      `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(CurrentSettlementRows, strictParseOptions))),
    ),
    Effect.flatMap(
      ([receipt]): Effect.Effect<CurrentTerminalGenerationSettlementReceipt, BlockedCycleIntentStoreError> => {
        if (receipt.authority_generation_hash === null) {
          return Effect.succeed({ _tag: 'NoTerminalGeneration' as const })
        }
        if (receipt.nonterminal_intent_count !== 0) {
          return Effect.fail(
            storeError(
              'invariant',
              `current blocked generation retains ${receipt.nonterminal_intent_count} intent(s) that require broker recovery after inspecting ${receipt.blocked_cycle_count} blocked cycle(s) and terminalizing ${receipt.blocked_intent_count} blocked/${receipt.expired_intent_count} expired intent(s)`,
            ),
          )
        }
        return Effect.succeed({
          _tag: 'TerminalGenerationSettled' as const,
          authorityGenerationHash: receipt.authority_generation_hash,
          blockedCycleCount: receipt.blocked_cycle_count,
          blockedIntentCount: receipt.blocked_intent_count,
          expiredIntentCount: receipt.expired_intent_count,
          intentCount: receipt.intent_count,
          terminalIntentCount: receipt.terminal_intent_count,
        })
      },
    ),
    Effect.mapError(classifyCause),
  )

const makeStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  return {
    terminalizeUntouchedApproved: (input) => terminalizeUntouchedApproved(sql, input),
    settleCurrentTerminalGeneration: (input) => settleCurrentTerminalGeneration(sql, input),
  } satisfies BlockedCycleIntentStoreShape
})

export const BlockedCycleIntentStoreLive = Layer.effect(BlockedCycleIntentStore, makeStore)
