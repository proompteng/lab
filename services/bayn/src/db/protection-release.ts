import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Option, Result, Schema } from 'effect'

import { IntentStore, NativeProtectionCancelCommandSchema } from '../execution/intents/domain'
import { IntentState, OrderSide, OrderType } from '../execution/contracts'
import { VerifiedProtectionReleaseSchema, type ProtectionReleaseBasis } from '../execution/protection-release'
import { ProtectionReleaseReferenceSchema, type ProtectionReleaseReference } from '../execution/events'
import { ProtectionCloseBasisSchema, protectionCloseReducesPosition } from '../execution/protection-close-basis'
import { withWriterFence } from '../execution/writer-fence'
import { canonicalHashV1Result, canonicalJsonEqualV1 } from '../hash'
import { JevExitTargetSchema, type JevExitTarget } from '../jev/exit'
import { currentAccountPostingBasis, readReconciliationRiskContext } from './reconciliation'
import { currentUtcInstant } from '../time'
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

export const deriveProtectionCloseBasis = (proofId: string, evidence: typeof ProtectionReleaseEvidence.Type) => {
  const { readback } = evidence
  const [position] = readback.positions.value
  return Schema.decodeUnknownResult(
    ProtectionCloseBasisSchema,
    strictParseOptions,
  )({
    proofId,
    accountId: readback.command.accountId,
    cycleId: evidence.cycleId,
    reconciliationId: evidence.baselineReconciliationId,
    authorityGenerationHash: evidence.frontier.authorityGenerationHash,
    protectionIntentId: readback.command.intentId,
    symbol: position?.symbol,
    signedQuantityAtoms: evidence.postedFills
      .reduce((sum, fill) => sum + BigInt(fill.signedQuantityAtoms), 0n)
      .toString(),
    checkedAt: readback.checkedAt,
    releasedOrderIds: [readback.root.value, ...(readback.root.value.legs ?? [])]
      .map(({ brokerOrderId }) => brokerOrderId)
      .sort(),
  })
}

const readReleaseFrontier = (
  sql: PgClient.PgClient,
  accountId: string,
  cycleId: string,
  reconciledAt: string,
  admittedIntentId?: string,
) =>
  sql`
    SELECT a.generation_hash AS "authorityGenerationHash", a.version::text AS "authorityVersion",
      c.state_version::text AS "cycleVersion",
      (SELECT reconciliation_id FROM reconciliations WHERE account_id = ${accountId}
        ORDER BY reconciled_at DESC, reconciliation_id COLLATE "C" DESC LIMIT 1) AS "reconciliationId",
      (SELECT generation::text FROM broker_observations WHERE account_id = ${accountId}) AS "observationGeneration",
      (SELECT count(*)::text FROM broker_events WHERE account_id = ${accountId}
        AND observed_at > ${reconciledAt}::timestamptz) AS "brokerEvents",
      (SELECT count(*)::text FROM mutation_events m JOIN intents i USING (intent_id) WHERE i.account_id = ${accountId}
        AND m.occurred_at >= ${reconciledAt}::timestamptz
        AND NOT (m.intent_id IS NOT DISTINCT FROM ${admittedIntentId ?? null} AND m.event_type = 'SUBMIT_STARTED')) AS mutations,
      (SELECT count(*)::text FROM native_protection_cancel_commands WHERE account_id = ${accountId}
        AND requested_at >= ${reconciledAt}::timestamptz) AS "protectionCommands",
      (SELECT jsonb_build_object('intentId', x.intent_id, 'accountId', x.account_id, 'brokerOrderId', x.broker_order_id,
               'requestedAt', to_char(x.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
       FROM native_protection_cancel_commands x JOIN intents i USING (intent_id, account_id)
       WHERE x.account_id = ${accountId} AND i.cycle_id = ${cycleId}
       ORDER BY x.requested_at DESC, x.intent_id, x.broker_order_id LIMIT 1) AS "latestCommand",
      (SELECT count(*)::text FROM broker_source_events WHERE account_id = ${accountId}
        AND recorded_at >= ${reconciledAt}::timestamptz) AS notifications
    FROM authority_state a CROSS JOIN autonomous_cycles c
    WHERE a.singleton AND c.account_id = ${accountId} AND c.cycle_id = ${cycleId} AND c.state = 'ACTIVE'
      AND (${currentAccountPostingBasis(sql, accountId, reconciledAt)})
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
      frontier.brokerEvents !== '0' ||
      frontier.mutations !== '0' ||
      frontier.protectionCommands !== '1' ||
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

export const readProtectionReleaseReference = (accountId: string, cycleId: string, claimId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const [reference] = yield* sql`
      SELECT proof_id AS "proofId", i.cycle_id AS "cycleId", evidence #>> '{readback,checkedAt}' AS "checkedAt"
      FROM protection_release_proofs p JOIN intents i USING (intent_id)
      WHERE i.account_id = ${accountId} AND i.cycle_id = ${cycleId} AND p.read_claim_id = ${claimId}
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ProtectionReleaseReferenceSchema), strictParseOptions)),
    )
    return reference
  })

/** Store readback evidence. The later order admission still needs to check its current frontier under the writer fence. */
export const recordProtectionReleaseProof = (
  basis: RetainedReleaseBasis,
  verified: typeof VerifiedProtectionReleaseSchema.Type,
  maximumObservationAgeMs: number,
  claimId: string,
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
      const [inserted] = yield* sql`
        INSERT INTO protection_release_proofs (proof_id, intent_id, broker_order_id, requested_at, evidence, read_claim_id)
        SELECT ${proofId}, intent_id, broker_order_id, requested_at, ${sql.json(evidence)}, claim_id
        FROM protection_release_read_claims WHERE claim_id = ${claimId}
          AND intent_id = ${command.intentId} AND broker_order_id = ${command.brokerOrderId}
          AND requested_at = ${command.requestedAt}::timestamptz
        ON CONFLICT DO NOTHING
        RETURNING proof_id
      `
      if (inserted !== undefined) return proofId
      const existing = yield* readProtectionReleaseReference(command.accountId, trigger.cycleId, claimId)
      return existing?.proofId === proofId ? proofId : undefined
    }),
  )

/** Reopen the immutable proof under the same fence used by its consumer. */
export const withCurrentProtectionReleaseProof = <A, E, R>(
  scope: {
    readonly proofId: string
    readonly cycleId: string
    readonly accountId: string
    readonly admittedIntentId?: string
  },
  maximumObservationAgeMs: number,
  consume: (evidence: typeof ProtectionReleaseEvidence.Type, trigger: JevExitTarget) => Effect.Effect<A, E, R>,
) =>
  withWriterFence(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const [row] = yield* sql`
        SELECT proof.evidence, c.exit_target AS trigger
        FROM protection_release_proofs AS proof
        JOIN native_protection_cancel_commands c USING (intent_id, broker_order_id, requested_at)
        JOIN intents i USING (intent_id, account_id)
        WHERE proof.proof_id = ${scope.proofId} AND i.cycle_id = ${scope.cycleId} AND i.account_id = ${scope.accountId}
      `.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ evidence: ProtectionReleaseEvidence, trigger: JevExitTargetSchema })),
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
      const current = yield* readReleaseFrontier(
        sql,
        scope.accountId,
        scope.cycleId,
        evidence.baselineReconciledAt,
        scope.admittedIntentId,
      )
      if (current === undefined || !canonicalJsonEqualV1(evidence.frontier, current)) return undefined
      return yield* consume(evidence, row.trigger)
    }),
  )

const ProtectionSubmitRows = Schema.Array(
  Schema.Struct({
    accountId: StrictNonEmptyStringSchema,
    cycleId: Sha256Schema,
    authorityGenerationHash: Sha256Schema,
    symbol: StrictNonEmptyStringSchema,
    side: Schema.Enum(OrderSide),
    orderType: Schema.Literal(OrderType.Limit),
    quantityAtoms: UnsignedMicrosSchema,
    protectionClose: ProtectionCloseBasisSchema,
    maximumAgeMs: Schema.Int.check(Schema.isGreaterThan(0)),
    expiresAt: UtcInstantSchema,
    databaseAt: UtcInstantSchema,
  }),
)

/** Reopen the already bound close under the current mutation transaction. */
export const readProtectionSubmit = (
  intentId: string,
  proofId: string,
  phase: 'admission' | 'transmission',
  submitExpiresAt?: string,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const [row] = yield* sql`
      SELECT i.account_id AS "accountId", i.cycle_id AS "cycleId",
        i.authority_generation_hash AS "authorityGenerationHash",
        i.symbol, i.side, i.order_type AS "orderType", i.quantity_atoms::text AS "quantityAtoms",
        c.document #> '{document,plannerInput,protectionClose}' AS "protectionClose",
        (c.document #>> '{document,plannerInput,maximumInputAgeMs}')::integer AS "maximumAgeMs",
        c.document ->> 'expiresAt' AS "expiresAt",
        to_char(execution_account_commit_now(i.account_id) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "databaseAt"
      FROM intents i JOIN autonomous_cycle_paper_closures c USING (cycle_id)
      WHERE i.intent_id = ${intentId} AND i.protection IS NULL AND i.order_type = 'LIMIT'
        AND i.state = ${phase === 'admission' ? IntentState.Approved : IntentState.IoStarted}
        AND c.document #> '{document,orderedIntentIds}' = jsonb_build_array(i.intent_id)
        AND c.document #>> '{document,bindings,strategyDecisionHash}' = i.decision_hash
        AND c.document #>> '{document,deltaRisk,0,evaluation,decision,decisionId}' = i.risk_decision_id
        AND c.document #>> '{document,plannerInput,protectionClose,proofId}' = ${proofId}
        AND (${phase === 'admission'} OR EXISTS (
          SELECT 1 FROM mutation_events m JOIN execution_decision_admissions a USING (event_id)
          WHERE m.intent_id = i.intent_id AND m.event_type = 'SUBMIT_STARTED'
            AND a.decision_id = c.document #>> '{document,contentHash}'
        ))
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(ProtectionSubmitRows, strictParseOptions)))
    if (
      row === undefined ||
      !protectionCloseReducesPosition(row.protectionClose, row) ||
      (submitExpiresAt !== undefined && row.databaseAt >= submitExpiresAt)
    )
      return undefined
    if (phase === 'admission') {
      // Serialize the scoped start with capture reservation until the intent becomes durably IO_STARTED.
      yield* sql`SELECT account_id FROM broker_observations WHERE account_id = ${row.accountId} FOR UPDATE`
    }
    return yield* withCurrentProtectionReleaseProof(
      {
        proofId,
        accountId: row.accountId,
        cycleId: row.cycleId,
        ...(phase === 'admission' ? {} : { admittedIntentId: intentId }),
      },
      row.maximumAgeMs,
      (evidence, trigger) =>
        Effect.gen(function* () {
          const proven = deriveProtectionCloseBasis(proofId, evidence)
          const now = yield* currentUtcInstant
          if (
            Result.isFailure(proven) ||
            !canonicalJsonEqualV1(proven.success, row.protectionClose) ||
            now >= row.expiresAt ||
            now >= trigger.commitDeadlineAt ||
            row.databaseAt >= trigger.commitDeadlineAt ||
            (submitExpiresAt !== undefined && now >= submitExpiresAt)
          )
            return undefined
          return evidence.readback
        }),
    )
  })

export const readCurrentProtectionClose = (
  reference: ProtectionReleaseReference,
  accountId: string,
  maximumObservationAgeMs: number,
) =>
  withCurrentProtectionReleaseProof({ ...reference, accountId }, maximumObservationAgeMs, (evidence, trigger) =>
    Effect.gen(function* () {
      const basis = deriveProtectionCloseBasis(reference.proofId, evidence)
      const brokerState = trigger.evidence.portfolio.brokerState
      const now = yield* currentUtcInstant
      if (
        Result.isFailure(basis) ||
        reference.checkedAt !== basis.success.checkedAt ||
        trigger.entryDecisionHash !== evidence.entryDecisionHash ||
        brokerState.reconciliation.reconciliationId !== evidence.baselineReconciliationId ||
        now >= trigger.commitDeadlineAt
      )
        return undefined
      const sql = yield* PgClient.PgClient
      const riskContext = yield* readReconciliationRiskContext(
        sql,
        { now: sql`${now}::timestamptz` },
        accountId,
        evidence.baselineReconciledAt,
        0,
      )
      if (
        riskContext.authority?.generationHash !== basis.success.authorityGenerationHash ||
        String(riskContext.authority.version) !== evidence.frontier.authorityVersion
      )
        return undefined
      return {
        _tag: 'ProtectionRelease' as const,
        trigger,
        protectionClose: basis.success,
        reconciliation: { brokerState, riskContext },
      }
    }),
  )
