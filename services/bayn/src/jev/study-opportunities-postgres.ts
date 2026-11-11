import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'

import { accountingTransactionFromRow, AccountingTransactionRowSchema } from '../db/accounting-rows'
import { executionDecisionRows } from '../db/execution-decision-query'
import { intentPlanSchemaVersion, ReconciliationSchema, RiskDecisionSchema, RiskOutcome } from '../execution/contracts'
import { makeExecutionIntentFromDecodedPlan, validateCommitIdentity } from '../execution/intents/domain'
import { decodeStoredEvents } from '../execution/mutations/rows'
import { CycleDecisionRow } from '../forward-performance/postgres/model'
import { canonicalHashV1Result } from '../hash'
import { inferenceCostRequestRows } from '../inference-costs-postgres'
import { decodeInferenceExpenseSessionRows } from '../inference-expense-postgres'
import { Sha256Schema, UnsignedMicrosSchema, strictParseOptions } from '../schemas'
import { ProtectionIntentEvidenceSchema, type ProtectionIntentEvidence } from '../system-assessment/execution-plans'
import type { JevStudyInventory } from './study-inventory'
import {
  JevStudyOpportunityFailure,
  JevStudyIntentSchema,
  makeJevStudyCycleOpportunity,
  makeJevStudyInferenceOpportunity,
  type JevStudyBatchDescription,
} from './study-opportunities'

const maximumCycleRows = 4_096
const maximumDecisionRows = 64
const maximumRequests = 20_000
const maximumQuotes = 100_000
const maximumDecisionSourceBytes = 16 * 1024 * 1024
const maximumQuoteSourceBytes = 64 * 1024 * 1024
const maximumProtectionReconciliations = 128
const maximumProtectionSourceBytes = 16 * 1024 * 1024
const SizeRows = Schema.Tuple([Schema.Struct({ bytes: UnsignedMicrosSchema, rows: UnsignedMicrosSchema })])
const ProtectionSourceSchema = Schema.Struct({
  plan: ProtectionIntentEvidenceSchema.fields.plan,
  authorityGenerationHash: Sha256Schema,
  intentId: Sha256Schema,
  clientOrderId: ProtectionIntentEvidenceSchema.fields.clientOrderId,
  riskDecisionId: Schema.NullOr(Sha256Schema),
  riskDecision: Schema.NullOr(RiskDecisionSchema),
})

const bounded = <A>(rows: readonly A[], maximum: number, name: string) =>
  rows.length > maximum
    ? Effect.fail(new JevStudyOpportunityFailure({ message: `${name} exceeds the opportunity export row bound` }))
    : Effect.succeed(rows)

/** Capture original standalone approvals, never a plan synthesized from current broker state. */
export const readJevStudyProtectionIntents = (
  sql: PgClient.PgClient,
  scope: { readonly accountId: string; readonly asOf: string },
  decisions: readonly (typeof CycleDecisionRow.Type)[],
  intents: readonly (typeof JevStudyIntentSchema.Type)[],
) =>
  Effect.gen(function* () {
    const evidence: ProtectionIntentEvidence[] = []
    let sourceBytes = 0n
    for (const intent of intents) {
      const protection = intent.protection
      if (protection === null || protection._tag === 'Bracket') continue
      const source = sql`
        SELECT intent.intent_id AS "intentId", intent.client_order_id AS "clientOrderId",
          intent.authority_generation_hash AS "authorityGenerationHash", intent.risk_decision_id AS "riskDecisionId",
          jsonb_strip_nulls(jsonb_build_object(
            'schemaVersion', ${intentPlanSchemaVersion}::text, 'strategyName', intent.strategy_name, 'cycleId', intent.cycle_id,
            'decisionHash', intent.decision_hash, 'policyHash', intent.policy_hash, 'accountId', intent.account_id,
            'symbol', intent.symbol, 'side', intent.side, 'orderType', intent.order_type, 'timeInForce', intent.time_in_force,
            'quantityAtoms', intent.quantity_atoms::text, 'notionalLimitMicros', intent.notional_limit_micros::text,
            'limitPriceMicros', intent.limit_price_micros::text, 'protection', intent.protection,
            'replanGenerationHash', intent.replan_generation_hash,
            'createdAt', to_char(intent.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )) AS plan,
          CASE WHEN risk.decision_id IS NULL THEN NULL ELSE jsonb_build_object(
            'schemaVersion', risk.schema_version, 'decisionId', risk.decision_id, 'inputHash', risk.input_hash,
            'intentId', risk.intent_id, 'policyHash', risk.policy_hash, 'outcome', risk.outcome, 'reasonCodes', risk.reason_codes,
            'decidedAt', to_char(risk.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'expiresAt', to_char(risk.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          ) END AS "riskDecision"
        FROM intents AS intent LEFT JOIN risk_decisions AS risk ON risk.decision_id = intent.risk_decision_id
        WHERE intent.intent_id = ${intent.intent_id} LIMIT 2
      `
      const [size] = yield* sql`
        SELECT COALESCE(sum(octet_length(to_jsonb(source)::text)), 0)::text AS bytes, count(*)::text AS rows
        FROM (${source}) AS source
      `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SizeRows, strictParseOptions)))
      if (size.rows !== '1')
        return yield* new JevStudyOpportunityFailure({ message: 'Protection source differs from its unique intent' })
      sourceBytes += BigInt(size.bytes)
      if (sourceBytes > BigInt(maximumProtectionSourceBytes))
        return yield* new JevStudyOpportunityFailure({
          message: 'Cycle protection source exceeds its preflight byte bound',
        })
      const [row] = yield* sql`SELECT * FROM (${source}) AS source`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([ProtectionSourceSchema]), strictParseOptions)),
      )
      const reproduced = yield* Effect.fromResult(
        makeExecutionIntentFromDecodedPlan(row.plan, row.authorityGenerationHash),
      )
      if (
        row.intentId !== intent.intent_id ||
        reproduced.intentId !== row.intentId ||
        reproduced.clientOrderId !== row.clientOrderId ||
        row.clientOrderId !== intent.client_order_id ||
        row.plan.accountId !== scope.accountId ||
        row.plan.cycleId !== intent.cycle_id ||
        row.authorityGenerationHash !== intent.authority_generation_hash ||
        row.riskDecisionId !== intent.risk_decision_id ||
        row.plan.createdAt > scope.asOf
      )
        return yield* new JevStudyOpportunityFailure({ message: 'Protection source identity, scope or cut differs' })
      // Join by the exact stored decision ID, then verify its intent binding. A foreign or rejected present
      // approval must fail rather than disappearing through a restrictive SQL join.
      const riskDecision = row.riskDecision
      if (riskDecision === null) continue
      yield* Effect.fromResult(validateCommitIdentity(reproduced, riskDecision))
      if (
        riskDecision.decisionId !== row.riskDecisionId ||
        riskDecision.outcome !== RiskOutcome.Approved ||
        riskDecision.decidedAt > scope.asOf ||
        riskDecision.decidedAt < row.plan.createdAt ||
        riskDecision.expiresAt <= riskDecision.decidedAt
      )
        return yield* new JevStudyOpportunityFailure({
          message: 'Protection approval outcome, identity or cut differs',
        })
      const entry = decisions.find((decision) => decision.decision_hash === protection.entryDecisionHash)
      if (entry === undefined) continue
      // The complete native decision verifier remains authoritative; this narrow projection only bounds acquisition.
      const view = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          riskPolicy: Schema.optionalKey(Schema.Struct({ maxBrokerStateAgeMs: Schema.Int })),
        }),
      )(entry.document)
      if (view.riskPolicy === undefined) continue
      const maximumAgeMs = view.riskPolicy.maxBrokerStateAgeMs
      if (maximumAgeMs <= 0)
        return yield* new JevStudyOpportunityFailure({
          message: 'Protection entry has no valid reconciliation age bound',
        })
      const reconciliationSource = sql`
        SELECT schema_version AS "schemaVersion", reconciliation_id AS "reconciliationId", account_id AS "accountId",
          expected_hash AS "expectedHash", observed_hash AS "observedHash", content_hash AS "contentHash",
          status, discrepancies,
          to_char(reconciled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "reconciledAt"
        FROM reconciliations WHERE account_id = ${scope.accountId}
          AND reconciled_at <= ${row.plan.createdAt}::timestamptz
          AND reconciled_at > ${row.plan.createdAt}::timestamptz - ${maximumAgeMs} * interval '1 millisecond'
        ORDER BY reconciled_at, reconciliation_id COLLATE "C" LIMIT ${maximumProtectionReconciliations + 1}
      `
      const [reconciliationSize] = yield* sql`
        SELECT COALESCE(sum(octet_length(to_jsonb(source)::text)), 0)::text AS bytes, count(*)::text AS rows
        FROM (${reconciliationSource}) AS source
      `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SizeRows, strictParseOptions)))
      if (BigInt(reconciliationSize.rows) > BigInt(maximumProtectionReconciliations))
        return yield* new JevStudyOpportunityFailure({
          message: 'Protection reconciliations exceed their preflight row bound',
        })
      sourceBytes += BigInt(reconciliationSize.bytes)
      if (sourceBytes > BigInt(maximumProtectionSourceBytes))
        return yield* new JevStudyOpportunityFailure({
          message: 'Cycle protection source exceeds its preflight byte bound',
        })
      const candidates = yield* sql`SELECT * FROM (${reconciliationSource}) AS source`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ReconciliationSchema), strictParseOptions)),
      )
      const matches = []
      for (const reconciliation of candidates)
        if (
          (yield* Effect.fromResult(
            canonicalHashV1Result({
              entryDecisionHash: protection.entryDecisionHash,
              reconciliationId: reconciliation.reconciliationId,
              protection: row.plan.protection,
            }),
          )) === row.plan.replanGenerationHash
        )
          matches.push(reconciliation)
      if (matches.length > 1)
        return yield* new JevStudyOpportunityFailure({
          message: 'Protection source has ambiguous original reconciliation',
        })
      const reconciliation = matches[0]
      if (reconciliation === undefined) continue
      const material = {
        plan: row.plan,
        authorityGenerationHash: row.authorityGenerationHash,
        intentId: row.intentId,
        clientOrderId: row.clientOrderId,
        riskDecision,
        reconciliation,
      }
      evidence.push({ ...material, sourceHash: yield* Effect.fromResult(canonicalHashV1Result(material)) })
    }
    return evidence
  })

/** The caller owns the single repeatable-read, read-only transaction and bounded file sink. */
export const writeJevStudyOpportunities = <E>(
  sql: PgClient.PgClient,
  scope: { readonly accountId: string; readonly sessionDate: string; readonly asOf: string },
  cycles: JevStudyInventory['cycles'],
  batches: readonly JevStudyBatchDescription[],
  write: (value: unknown) => Effect.Effect<void, E>,
) =>
  Effect.gen(function* () {
    const { accountId, sessionDate, asOf } = scope
    yield* write({
      recordType: 'HEADER',
      schemaVersion: 'bayn.jev-study-opportunities.v2',
      accountBindingHash: yield* Effect.fromResult(
        canonicalHashV1Result({ schemaVersion: 'bayn.jev-study-account.v1', accountId }),
      ),
      sessionDate,
      asOf,
      cycleCount: cycles.length,
      sourceCoverage: 'RECORDED_DATABASE_ROWS_ONLY',
      controllerCoverage: 'UNKNOWN',
      qualification: 'UNQUALIFIED',
      independentlyVerifiedLedger: false,
    })
    const dispositions: Record<string, number> = {}
    let incompleteCycleCount = 0
    let fillCount = 0
    let intentCount = 0
    let protectionIntentCount = 0
    let transactionCount = 0
    for (const cycle of cycles) {
      // Reject large JSON groups before their payloads cross the wire or accumulate in this process.
      const [size] = yield* sql`
        SELECT COALESCE(sum(octet_length(source.document::text)), 0)::text AS bytes, count(*)::text AS rows FROM (
          SELECT document FROM (${executionDecisionRows(sql)}) AS decisions
          WHERE cycle_id = ${cycle.cycleId} LIMIT ${maximumDecisionRows + 1}
        ) AS source
      `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SizeRows, strictParseOptions)))
      if (BigInt(size.rows) > BigInt(maximumDecisionRows))
        return yield* new JevStudyOpportunityFailure({ message: 'Cycle decisions exceed their preflight row bound' })
      if (BigInt(size.bytes) > BigInt(maximumDecisionSourceBytes))
        return yield* new JevStudyOpportunityFailure({
          message: 'Cycle decision source exceeds its preflight byte bound',
        })
      const decisions = yield* sql`
        SELECT source.cycle_id, source.decision_hash, source.document, source.created_at
        FROM (${executionDecisionRows(sql)}) AS source
        WHERE source.cycle_id = ${cycle.cycleId}
        ORDER BY source.created_at, source.decision_hash COLLATE "C" LIMIT ${maximumDecisionRows + 1}
      `.pipe(
        Effect.flatMap((rows) => bounded(rows, maximumDecisionRows, 'Cycle decisions')),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(CycleDecisionRow), strictParseOptions)),
      )
      const [intentSize] = yield* sql`
        SELECT COALESCE(sum(octet_length(to_jsonb(source)::text)), 0)::text AS bytes, count(*)::text AS rows FROM (
          SELECT * FROM intents WHERE cycle_id = ${cycle.cycleId} LIMIT ${maximumCycleRows + 1}
        ) AS source
      `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SizeRows, strictParseOptions)))
      if (
        BigInt(intentSize.rows) > BigInt(maximumCycleRows) ||
        BigInt(intentSize.bytes) > BigInt(maximumProtectionSourceBytes)
      )
        return yield* new JevStudyOpportunityFailure({
          message: 'Cycle intents exceed their preflight row or byte bound',
        })
      const intents = yield* sql`
        SELECT intent_id, account_id, client_order_id, cycle_id, decision_hash, symbol, side,
          quantity_atoms::text AS quantity_atoms, notional_limit_micros::text AS notional_limit_micros,
          replan_generation_hash, terminal_outcome, created_at, updated_at, authority_generation_hash, state, protection,
          risk_decision_id
        FROM intents WHERE cycle_id = ${cycle.cycleId}
        ORDER BY intent_id COLLATE "C" LIMIT ${maximumCycleRows + 1}
      `.pipe(
        Effect.flatMap((rows) => bounded(rows, maximumCycleRows, 'Cycle intents')),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(JevStudyIntentSchema), strictParseOptions)),
      )
      const protectionIntents = yield* readJevStudyProtectionIntents(sql, scope, decisions, intents)
      const orders = yield* sql`
        SELECT observed_order.schema_version, observed_order.parent_broker_order_id,
          observed_order.order_type, observed_order.time_in_force,
          observed_order.limit_price_micros::text AS limit_price_micros,
          observed_order.stop_price_micros::text AS stop_price_micros,
          event.source_sequence::text AS source_sequence,
          event.event_id, observed_order.broker_order_id, observed_order.client_order_id,
          observed_order.intent_id, observed_order.account_id, observed_order.symbol, observed_order.side,
          observed_order.quantity_atoms::text AS quantity_atoms, observed_order.notional_micros::text AS notional_micros,
          observed_order.filled_quantity_atoms::text AS filled_quantity_atoms, observed_order.status,
          event.occurred_at, event.observed_at
        FROM orders AS observed_order JOIN intents AS intent ON intent.intent_id = observed_order.intent_id
        LEFT JOIN broker_events AS event ON event.event_id = observed_order.event_id
        WHERE intent.cycle_id = ${cycle.cycleId}
        ORDER BY event.source_sequence, event.event_id COLLATE "C"
        LIMIT ${maximumCycleRows + 1}
      `.pipe(Effect.flatMap((rows) => bounded(rows, maximumCycleRows, 'Cycle orders')))
      const fills = yield* sql`
        SELECT event.event_id, fill.fill_id, fill.broker_order_id, fill.client_order_id,
          fill.intent_id, fill.account_id, fill.symbol, fill.side, fill.quantity_atoms::text AS quantity_atoms,
          fill.price_atoms::text AS price_atoms, fill.fee_micros::text AS fee_micros,
          fill.source_timestamp, event.occurred_at, event.observed_at
        FROM fills AS fill JOIN intents AS intent ON intent.intent_id = fill.intent_id
        LEFT JOIN broker_events AS event ON event.event_id = fill.event_id
        WHERE intent.cycle_id = ${cycle.cycleId}
        ORDER BY event.occurred_at, fill.fill_id COLLATE "C" LIMIT ${maximumCycleRows + 1}
      `.pipe(Effect.flatMap((rows) => bounded(rows, maximumCycleRows, 'Cycle fills')))
      const mutationRows = yield* sql`
        SELECT event.schema_version, event.event_id, event.mutation_id, event.intent_id,
          event.sequence::integer AS sequence, event.operation, event.event_type, event.request_hash,
          event.consistency_delay_ms, event.broker_order_id, event.request_id, event.response_status,
          event.response_content_hash, event.routing, event.denial_reason,
          to_char(event.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at
        FROM mutation_events AS event JOIN intents AS intent ON intent.intent_id = event.intent_id
        WHERE intent.cycle_id = ${cycle.cycleId}
        ORDER BY event.intent_id COLLATE "C", event.operation, event.sequence LIMIT ${maximumCycleRows + 1}
      `.pipe(Effect.flatMap((rows) => bounded(rows, maximumCycleRows, 'Cycle mutations')))
      const transactions = yield* sql`
        SELECT transaction.schema_version, transaction.transaction_id, transaction.broker_event_id,
          transaction.intent_id, transaction.account_id, transaction.symbol, transaction.side,
          transaction.quantity_atoms::text AS quantity_atoms, transaction.price_atoms::text AS price_atoms,
          transaction.notional_micros::text AS notional_micros, transaction.fee_micros::text AS fee_micros,
          transaction.cost_basis_micros::text AS cost_basis_micros,
          transaction.realized_pnl_micros::text AS realized_pnl_micros,
          transaction.quantity_delta_atoms::text AS quantity_delta_atoms,
          transaction.cost_basis_delta_micros::text AS cost_basis_delta_micros,
          transaction.cash_delta_micros::text AS cash_delta_micros,
          transaction.ledger_plan_hash, transaction.content_hash, transaction.occurred_at
        FROM accounting_transactions AS transaction JOIN intents AS intent ON intent.intent_id = transaction.intent_id
        WHERE intent.cycle_id = ${cycle.cycleId}
        ORDER BY transaction.occurred_at, transaction.transaction_id COLLATE "C" LIMIT ${maximumCycleRows + 1}
      `.pipe(
        Effect.flatMap((rows) => bounded(rows, maximumCycleRows, 'Cycle transactions')),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AccountingTransactionRowSchema), strictParseOptions)),
      )
      const record = yield* Effect.fromResult(
        makeJevStudyCycleOpportunity(
          cycle,
          {
            decisions,
            protectionIntents,
            intents,
            orders,
            fills,
            mutations: yield* Effect.fromResult(decodeStoredEvents(mutationRows)),
            transactions: transactions.map(accountingTransactionFromRow),
          },
          batches.filter((batch) => batch.cycleId === cycle.cycleId),
          accountId,
          sessionDate,
          asOf,
        ),
      )
      dispositions[record.disposition] = (dispositions[record.disposition] ?? 0) + 1
      if (record.joinCoverage === 'INCOMPLETE') incompleteCycleCount++
      fillCount += record.fills.length
      intentCount += record.intents.length
      protectionIntentCount += record.protectionIntents.length
      transactionCount += record.transactions.length
      yield* write(record)
    }

    const [quoteSize] = yield* sql`
      SELECT COALESCE(sum(octet_length(source.payload::text)), 0)::text AS bytes, count(*)::text AS rows FROM (
        SELECT payload FROM inference_expense_quotes
        WHERE account_id = ${accountId} AND session_date = ${sessionDate}::date LIMIT ${maximumQuotes + 1}
      ) AS source
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SizeRows, strictParseOptions)))
    if (BigInt(quoteSize.rows) > BigInt(maximumQuotes))
      return yield* new JevStudyOpportunityFailure({ message: 'Frozen quotes exceed their preflight row bound' })
    if (BigInt(quoteSize.bytes) > BigInt(maximumQuoteSourceBytes))
      return yield* new JevStudyOpportunityFailure({ message: 'Frozen quote source exceeds its preflight byte bound' })
    const quoteRows = yield* sql`
      SELECT quote_hash AS "quoteHash", payload,
        to_char(verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "verifiedAt"
      FROM inference_expense_quotes
      WHERE account_id = ${accountId} AND session_date = ${sessionDate}::date
      ORDER BY quote_hash COLLATE "C" LIMIT ${maximumQuotes + 1}
    `.pipe(Effect.flatMap((rows) => bounded(rows, maximumQuotes, 'Frozen inference quotes')))
    const quotes = yield* decodeInferenceExpenseSessionRows(quoteRows, sessionDate)
    const costAccountBindingHash = yield* Effect.fromResult(
      canonicalHashV1Result({ schemaVersion: 'bayn.inference-cost-account.v1', accountId }),
    )
    if (
      quotes.some(
        (row) =>
          row.quote.accountBindingHash !== costAccountBindingHash || (row.verifiedAt !== null && row.verifiedAt > asOf),
      )
    )
      return yield* new JevStudyOpportunityFailure({ message: 'Frozen quote account or verification cut differs' })
    const cycleIds = new Set(cycles.map((cycle) => cycle.cycleId))
    const candidates = batches.flatMap((batch) => batch.candidates)
    const requests = new Set<string>()
    let cursor: string | null = null
    let stageObligationCount = 0
    let meteredStageCount = 0
    let notDispatchedStageCount = 0
    let unknownUsageStageCount = 0
    let incompleteInferenceRequestCount = 0
    let outsideCycleInferenceRequestCount = 0
    let missingCandidateInferenceRequestCount = 0
    let knownEstimatedInferenceCostPicoUsd = 0n
    let outsideCycleKnownEstimatedInferenceCostPicoUsd = 0n
    for (;;) {
      const page: readonly { readonly source: unknown }[] = yield* sql`
        SELECT (to_jsonb(item) - 'chartCheckpoint' - 'stagedCheckpoint') ||
          CASE WHEN item."chartCheckpoint" IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('chartCheckpoint', item."chartCheckpoint") END ||
          CASE WHEN item."stagedCheckpoint" IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('stagedCheckpoint', item."stagedCheckpoint") END AS source
        FROM (${inferenceCostRequestRows(sql, accountId, sessionDate)}) AS item
        WHERE (${cursor}::text IS NULL OR item."requestId" COLLATE "C" > ${cursor}::text COLLATE "C")
        ORDER BY item."requestId" COLLATE "C" LIMIT 1
      `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ source: Schema.Unknown })))))
      const row = page[0]
      if (row === undefined) break
      if (page.length !== 1 || requests.size >= maximumRequests)
        return yield* new JevStudyOpportunityFailure({ message: 'Inference request paging or row bound differs' })
      const identity = yield* Schema.decodeUnknownEffect(Schema.Struct({ requestId: Sha256Schema }))(row.source)
      const record: Result.Result.Success<ReturnType<typeof makeJevStudyInferenceOpportunity>> =
        yield* Effect.fromResult(
          makeJevStudyInferenceOpportunity(
            row.source,
            quotes.filter((quote) => quote.quote.line.requestId === identity.requestId),
            scope,
            cycleIds,
            candidates,
          ),
        )
      if ((cursor !== null && record.requestId <= cursor) || requests.has(record.requestId))
        return yield* new JevStudyOpportunityFailure({ message: 'Inference request cursor did not advance' })
      cursor = record.requestId
      requests.add(record.requestId)
      stageObligationCount += record.stageObligationCount
      meteredStageCount += record.meteredStageCount
      notDispatchedStageCount += record.notDispatchedStageCount
      unknownUsageStageCount += record.unknownUsageStageCount
      if (!record.costCoverage.completeMeteredCoverage) incompleteInferenceRequestCount++
      const knownCost = BigInt(record.costCoverage.knownEstimatedCostPicoUsd)
      knownEstimatedInferenceCostPicoUsd += knownCost
      if (record.cycleJoin !== 'MATCHED') {
        outsideCycleInferenceRequestCount++
        outsideCycleKnownEstimatedInferenceCostPicoUsd += knownCost
      }
      if (record.candidateJoin !== 'MATCHED') missingCandidateInferenceRequestCount++
      yield* write(record)
    }
    const unallocatedQuotes = quotes.filter((quote) => !requests.has(quote.quote.line.requestId))
    for (const quote of unallocatedQuotes)
      yield* write({ recordType: 'UNALLOCATED_INFERENCE_QUOTE', reason: 'MISSING_REQUEST_SOURCE', ...quote })

    const unallocatedExecution = yield* sql`
      SELECT 'FILL' AS kind, fill.event_id AS "sourceId", fill.intent_id AS "intentId", intent.cycle_id AS "cycleId"
      FROM fills AS fill LEFT JOIN broker_events AS event ON event.event_id = fill.event_id
      LEFT JOIN intents AS intent ON intent.intent_id = fill.intent_id
      LEFT JOIN autonomous_cycles AS cycle ON cycle.cycle_id = intent.cycle_id
      WHERE fill.account_id = ${accountId}
        AND (event.occurred_at AT TIME ZONE 'America/New_York')::date = ${sessionDate}::date
        AND (cycle.cycle_id IS NULL OR cycle.account_id <> ${accountId}
          OR cycle.strategy_name <> 'jev' OR cycle.execution_session_date <> ${sessionDate}::date)
      UNION ALL
      SELECT 'TRANSACTION', transaction.transaction_id, transaction.intent_id, intent.cycle_id
      FROM accounting_transactions AS transaction LEFT JOIN intents AS intent ON intent.intent_id = transaction.intent_id
      LEFT JOIN autonomous_cycles AS cycle ON cycle.cycle_id = intent.cycle_id
      WHERE transaction.account_id = ${accountId}
        AND (transaction.occurred_at AT TIME ZONE 'America/New_York')::date = ${sessionDate}::date
        AND (cycle.cycle_id IS NULL OR cycle.account_id <> ${accountId}
          OR cycle.strategy_name <> 'jev' OR cycle.execution_session_date <> ${sessionDate}::date)
      ORDER BY kind, "sourceId" LIMIT ${maximumCycleRows + 1}
    `.pipe(
      Effect.flatMap((rows) => bounded(rows, maximumCycleRows, 'Unallocated execution sources')),
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              kind: Schema.Literals(['FILL', 'TRANSACTION']),
              sourceId: Sha256Schema,
              intentId: Schema.NullOr(Sha256Schema),
              cycleId: Schema.NullOr(Sha256Schema),
            }),
          ),
          strictParseOptions,
        ),
      ),
    )
    if (unallocatedExecution.length > 0)
      yield* write({ recordType: 'UNALLOCATED_EXECUTION', sessionDate, sources: unallocatedExecution })
    const unclaimedCandidateRequestIds = [
      ...new Set(
        candidates.flatMap((candidate) =>
          candidate.requestId === null || requests.has(candidate.requestId) ? [] : [candidate.requestId],
        ),
      ),
    ].sort()
    const knownCostMicros = ((knownEstimatedInferenceCostPicoUsd + 999_999n) / 1_000_000n).toString()
    const summary = {
      cycleCount: cycles.length,
      dispositions,
      incompleteCycleCount,
      intentCount,
      protectionIntentCount,
      fillCount,
      transactionCount,
      inferenceRequestCount: requests.size,
      stageObligationCount,
      meteredStageCount,
      notDispatchedStageCount,
      unknownUsageStageCount,
      providerCallCount: null,
      incompleteInferenceRequestCount,
      outsideCycleInferenceRequestCount,
      missingCandidateInferenceRequestCount,
      unallocatedQuoteCount: unallocatedQuotes.length,
      unallocatedExecutionSourceCount: unallocatedExecution.length,
      unclaimedCandidateRequestIds,
      knownEstimatedInferenceCostPicoUsd: knownEstimatedInferenceCostPicoUsd.toString(),
      knownEstimatedInferenceCostMicros: knownCostMicros,
      outsideCycleKnownEstimatedInferenceCostPicoUsd: outsideCycleKnownEstimatedInferenceCostPicoUsd.toString(),
      estimatedTotalInferenceCostMicros:
        incompleteInferenceRequestCount === 0 &&
        unallocatedQuotes.length === 0 &&
        unclaimedCandidateRequestIds.length === 0
          ? knownCostMicros
          : null,
      invoiceReconciled: false,
      brokerFeeCoverage: 'UNKNOWN',
      operatingCostCoverage: 'UNKNOWN',
      allInProfitMicros: null,
    }
    yield* write({ recordType: 'SUMMARY', ...summary })
    return summary
  })
