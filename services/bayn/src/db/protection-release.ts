import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Option, Result, Schema } from 'effect'

import { IntentStore, NativeProtectionCancelCommandSchema } from '../execution/intents/domain'
import { VerifiedProtectionReleaseSchema, type ProtectionReleaseBasis } from '../execution/protection-release'
import { withWriterFence } from '../execution/writer-fence'
import { canonicalHashV1Result, canonicalJsonEqualV1 } from '../hash'
import { JevExitTargetSchema } from '../jev/exit'
import {
  Sha256Schema,
  SignedMicrosSchema,
  StrictNonEmptyStringSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'

const LatchRows = Schema.Array(
  Schema.Struct({
    command: NativeProtectionCancelCommandSchema,
    acceptedAt: UtcInstantSchema,
    trigger: JevExitTargetSchema,
  }),
)

const FillRows = Schema.Array(
  Schema.Struct({
    orderId: StrictNonEmptyStringSchema,
    filledQuantityAtoms: UnsignedMicrosSchema,
    signedQuantityAtoms: SignedMicrosSchema,
    allPosted: Schema.Boolean,
  }),
)

const FrontierRows = Schema.Array(
  Schema.Struct({
    authorityGenerationHash: Sha256Schema,
    authorityVersion: StrictNonEmptyStringSchema,
    cycleVersion: StrictNonEmptyStringSchema,
    reconciliationId: Schema.NullOr(Sha256Schema),
    observationGeneration: Schema.NullOr(StrictNonEmptyStringSchema),
    brokerEvents: StrictNonEmptyStringSchema,
    mutations: StrictNonEmptyStringSchema,
    protectionCommands: StrictNonEmptyStringSchema,
    latestCommand: Schema.NullOr(NativeProtectionCancelCommandSchema),
    notifications: StrictNonEmptyStringSchema,
  }),
)

const ProtectionReleaseEvidence = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.protection-release-proof.v1'),
  cycleId: Sha256Schema,
  entryDecisionHash: Sha256Schema,
  baselineReconciliationId: Sha256Schema,
  baselineReconciledAt: UtcInstantSchema,
  postedFills: FillRows,
  frontier: FrontierRows.value,
  readback: VerifiedProtectionReleaseSchema,
})

const readReleaseFrontier = (sql: PgClient.PgClient, accountId: string, cycleId: string, reconciledAt: string) =>
  sql`
    SELECT a.generation_hash AS "authorityGenerationHash", a.version::text AS "authorityVersion",
      c.state_version::text AS "cycleVersion",
      (SELECT reconciliation_id FROM reconciliations WHERE account_id = ${accountId}
        ORDER BY reconciled_at DESC, reconciliation_id COLLATE "C" DESC LIMIT 1) AS "reconciliationId",
      (SELECT generation::text FROM broker_observations WHERE account_id = ${accountId}) AS "observationGeneration",
      (SELECT count(*)::text FROM broker_events WHERE account_id = ${accountId}
        AND observed_at >= ${reconciledAt}::timestamptz) AS "brokerEvents",
      (SELECT count(*)::text FROM mutation_events m JOIN intents i USING (intent_id) WHERE i.account_id = ${accountId}
        AND m.occurred_at >= ${reconciledAt}::timestamptz) AS mutations,
      (SELECT count(*)::text FROM native_protection_cancel_commands WHERE account_id = ${accountId}
        AND requested_at >= ${reconciledAt}::timestamptz) AS "protectionCommands",
      (SELECT jsonb_build_object('intentId', x.intent_id, 'accountId', x.account_id, 'brokerOrderId', x.broker_order_id,
               'requestedAt', to_char(x.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
       FROM native_protection_cancel_commands x JOIN intents i USING (intent_id, account_id)
       WHERE x.account_id = ${accountId} AND i.cycle_id = ${cycleId}
       ORDER BY x.requested_at DESC, x.intent_id, x.broker_order_id LIMIT 1) AS "latestCommand",
      (SELECT count(*)::text FROM broker_notification_receipts WHERE account_id = ${accountId}
        AND recorded_at >= ${reconciledAt}::timestamptz) AS notifications
    FROM authority_state a CROSS JOIN autonomous_cycles c
    WHERE a.singleton AND c.account_id = ${accountId} AND c.cycle_id = ${cycleId} AND c.state = 'ACTIVE'
  `.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(FrontierRows, strictParseOptions)),
    Effect.map(([row]) => row),
  )

/** Read the latest accepted cancellation and the signed fill basis that was already posted at that command. */
export const readProtectionReleaseBasis = (accountId: string, cycleId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const [latch] = yield* sql`
      WITH latest AS (
        SELECT c.* FROM native_protection_cancel_commands c JOIN intents i USING (intent_id, account_id)
        WHERE c.account_id = ${accountId} AND i.cycle_id = ${cycleId}
        ORDER BY c.requested_at DESC, c.intent_id, c.broker_order_id
        LIMIT 1
      )
      SELECT jsonb_build_object(
               'intentId', c.intent_id, 'accountId', c.account_id, 'brokerOrderId', c.broker_order_id,
               'requestedAt', to_char(c.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             ) AS command,
             to_char(r.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "acceptedAt",
             c.exit_target AS trigger
      FROM latest c
      JOIN native_protection_cancel_receipts r USING (intent_id, account_id, broker_order_id, requested_at)
      JOIN reconciliations e ON e.account_id = c.account_id AND e.status = 'EXACT'
        AND e.reconciliation_id = c.exit_target #>> '{evidence,portfolio,brokerState,reconciliation,reconciliationId}'
        AND e.content_hash = c.exit_target #>> '{evidence,portfolio,brokerState,reconciliation,contentHash}'
      WHERE c.exit_target IS NOT NULL
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(LatchRows, strictParseOptions)))
    if (latch === undefined) return undefined

    const intents = yield* IntentStore
    const stored = yield* intents.read(latch.command.intentId)
    if (Option.isNone(stored)) return undefined
    const reconciliation = latch.trigger.evidence.portfolio.brokerState.reconciliation
    const frontier = yield* readReleaseFrontier(sql, accountId, cycleId, reconciliation.reconciledAt)
    if (
      frontier === undefined ||
      frontier.authorityGenerationHash !== stored.value.intent.authorityGenerationHash ||
      frontier.reconciliationId !== reconciliation.reconciliationId ||
      !canonicalJsonEqualV1(frontier.latestCommand, latch.command)
    )
      return undefined
    const postedFills = yield* sql`
      SELECT f.broker_order_id AS "orderId",
             sum(abs(t.quantity_delta_atoms))::text AS "filledQuantityAtoms",
             sum(t.quantity_delta_atoms)::text AS "signedQuantityAtoms",
             bool_and(r.recorded_at IS NOT NULL AND r.recorded_at <= ${latch.command.requestedAt}::timestamptz) AS "allPosted"
      FROM accounting_transactions t
      JOIN intents i ON i.intent_id = t.intent_id AND i.account_id = t.account_id
      JOIN fills f ON f.event_id = t.broker_event_id AND f.account_id = t.account_id AND f.symbol = t.symbol
      LEFT JOIN accounting_receipts r ON r.broker_event_id = t.broker_event_id AND r.intent_id = t.intent_id
      WHERE t.account_id = ${accountId} AND i.cycle_id = ${cycleId} AND t.symbol = ${stored.value.intent.symbol}
        AND t.occurred_at <= ${latch.command.requestedAt}::timestamptz
      GROUP BY f.broker_order_id
      ORDER BY f.broker_order_id
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(FillRows, strictParseOptions)))
    if (postedFills.some((fill) => !fill.allPosted)) return undefined
    return {
      ...latch,
      protectionIntent: stored.value.intent,
      postedFills,
      frontier,
    } satisfies ProtectionReleaseBasis & {
      readonly frontier: NonNullable<typeof frontier>
    }
  })

type RetainedReleaseBasis = NonNullable<Effect.Success<ReturnType<typeof readProtectionReleaseBasis>>>

/** Store readback evidence. The later order admission still needs to check its current frontier under the writer fence. */
export const recordProtectionReleaseProof = (
  basis: RetainedReleaseBasis,
  verified: typeof VerifiedProtectionReleaseSchema.Type,
  maximumObservationAgeMs: number,
) =>
  withWriterFence(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const { command, acceptedAt, trigger, frontier } = basis
      const age = (yield* Clock.currentTimeMillis) - Date.parse(verified.root.evidence.observedAt)
      if (
        !Number.isFinite(age) ||
        age < 0 ||
        age >= maximumObservationAgeMs ||
        !canonicalJsonEqualV1(command, verified.command) ||
        acceptedAt !== verified.acceptedAt
      )
        return undefined
      const reconciliation = trigger.evidence.portfolio.brokerState.reconciliation
      const current = yield* readReleaseFrontier(sql, command.accountId, trigger.cycleId, reconciliation.reconciledAt)
      if (current === undefined || !canonicalJsonEqualV1(frontier, current)) return undefined
      const evidence = {
        schemaVersion: 'bayn.protection-release-proof.v1',
        cycleId: trigger.cycleId,
        entryDecisionHash: trigger.entryDecisionHash,
        baselineReconciliationId: reconciliation.reconciliationId,
        baselineReconciledAt: reconciliation.reconciledAt,
        postedFills: basis.postedFills,
        frontier,
        readback: verified,
      } satisfies typeof ProtectionReleaseEvidence.Type
      const proofId = yield* Effect.fromResult(canonicalHashV1Result(evidence))
      yield* sql`
        INSERT INTO protection_release_proofs (proof_id, intent_id, broker_order_id, requested_at, evidence)
        VALUES (${proofId}, ${command.intentId}, ${command.brokerOrderId}, ${command.requestedAt}::timestamptz, ${sql.json(evidence)})
        ON CONFLICT (proof_id) DO NOTHING
      `
      return proofId
    }),
  )

/** Reopen the immutable proof under the same fence used by its consumer. */
export const withCurrentProtectionReleaseProof = <A, E, R>(
  scope: { readonly proofId: string; readonly cycleId: string; readonly accountId: string },
  maximumObservationAgeMs: number,
  consume: (evidence: typeof ProtectionReleaseEvidence.Type) => Effect.Effect<A, E, R>,
) =>
  withWriterFence(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const [row] = yield* sql`
        SELECT proof.evidence FROM protection_release_proofs AS proof JOIN intents i USING (intent_id)
        WHERE proof.proof_id = ${scope.proofId} AND i.cycle_id = ${scope.cycleId} AND i.account_id = ${scope.accountId}
      `.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ evidence: ProtectionReleaseEvidence })),
            strictParseOptions,
          ),
        ),
      )
      if (row === undefined) return undefined
      const { evidence } = row
      const hash = canonicalHashV1Result(evidence)
      const age = (yield* Clock.currentTimeMillis) - Date.parse(evidence.readback.root.evidence.observedAt)
      if (
        Result.isFailure(hash) ||
        hash.success !== scope.proofId ||
        evidence.cycleId !== scope.cycleId ||
        evidence.readback.command.accountId !== scope.accountId ||
        !Number.isFinite(age) ||
        age < 0 ||
        age >= maximumObservationAgeMs
      )
        return undefined
      const current = yield* readReleaseFrontier(sql, scope.accountId, scope.cycleId, evidence.baselineReconciledAt)
      if (current === undefined || !canonicalJsonEqualV1(evidence.frontier, current)) return undefined
      return yield* consume(evidence)
    }),
  )
