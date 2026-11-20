import { Data, Result, Schema } from 'effect'

import { AccountingTransactionSchema } from '../accounting/schema'
import { intentPlanSchemaVersion, IntentState, NativeProtectionSchema, OrderSchema } from '../execution/contracts'
import { makeExecutionIntentFromDecodedPlan, type IntentPlan } from '../execution/intents/domain'
import { MutationEventSchema } from '../execution/mutations/model'
import {
  CycleDecisionRow,
  FillExecutionRow,
  IntentExecutionRow,
  OrderExecutionRow,
} from '../forward-performance/postgres/model'
import { verifyPerformanceDecisions } from '../forward-performance/postgres/projection'
import { canonicalHashV1Result } from '../hash'
import {
  decodeInferenceCostRequest,
  InferenceUsageStatus,
  makeInferenceCostReport,
  type InferenceCostRequestSchema,
} from '../inference-costs'
import { verifyInferenceExpenseCoverage, type InferenceExpenseRecord } from '../inference-expense'
import { IsoDateSchema, PositiveMicrosSchema, Sha256Schema, UnsignedMicrosSchema, strictParseOptions } from '../schemas'
import { executionOrderPlans, ProtectionIntentEvidenceSchema } from '../system-assessment/execution-plans'
import { resolveExecutionOrderTerms } from '../system-assessment/execution-order-terms'
import type { verifyJevStudyExportRow } from './study-export'
import { JevStudyCycleSchema } from './study-inventory'

export class JevStudyOpportunityFailure extends Data.TaggedError('JevStudyOpportunityFailure')<{
  readonly message: string
}> {}

const invalid = (message: string) => Result.fail(new JevStudyOpportunityFailure({ message }))

export const JevStudyIntentSchema = Schema.Struct({
  ...IntentExecutionRow.fields,
  quantity_atoms: UnsignedMicrosSchema,
  notional_limit_micros: UnsignedMicrosSchema,
  authority_generation_hash: Sha256Schema,
  risk_decision_id: Schema.NullOr(Sha256Schema),
  state: Schema.Enum(IntentState),
  protection: Schema.NullOr(NativeProtectionSchema),
})

export const JevStudyCycleSourcesSchema = Schema.Struct({
  decisions: Schema.Array(CycleDecisionRow),
  protectionIntents: Schema.Array(ProtectionIntentEvidenceSchema),
  intents: Schema.Array(JevStudyIntentSchema),
  orders: Schema.Array(
    Schema.Struct({
      ...OrderExecutionRow.fields,
      schema_version: Schema.String,
      parent_broker_order_id: Schema.NullOr(Schema.String),
      order_type: Schema.String,
      time_in_force: Schema.String,
      limit_price_micros: Schema.NullOr(PositiveMicrosSchema),
      stop_price_micros: Schema.NullOr(PositiveMicrosSchema),
      source_sequence: UnsignedMicrosSchema,
      quantity_atoms: Schema.NullOr(PositiveMicrosSchema),
      notional_micros: Schema.NullOr(PositiveMicrosSchema),
      filled_quantity_atoms: UnsignedMicrosSchema,
    }),
  ),
  fills: Schema.Array(
    Schema.Struct({
      ...FillExecutionRow.fields,
      quantity_atoms: PositiveMicrosSchema,
      price_atoms: PositiveMicrosSchema,
      fee_micros: UnsignedMicrosSchema,
    }),
  ),
  mutations: Schema.Array(MutationEventSchema),
  transactions: Schema.Array(AccountingTransactionSchema),
})

type StudyBatch = Result.Result.Success<ReturnType<typeof verifyJevStudyExportRow>>

/** Compact references into the separately retained, natively reproduced batch file. */
export const describeJevStudyBatch = (row: StudyBatch) =>
  Result.gen(function* () {
    const candidates = yield* Result.all(
      row.plan.candidates.map((candidate) =>
        Result.gen(function* () {
          const result = row.result?.candidates.find((value) => value.symbol === candidate.symbol)
          return {
            symbol: candidate.symbol,
            planStatus: candidate.status,
            exclusionReason: candidate.status === 'EXCLUDED' ? candidate.reason : null,
            requestId: candidate.status === 'REQUESTED' ? candidate.request.requestId : null,
            requestFingerprint:
              candidate.status === 'REQUESTED' ? yield* canonicalHashV1Result(candidate.request) : null,
            resultStatus: result?.status ?? null,
            resolutionStatus: result?.status === 'RESOLVED' ? result.resolution.status : null,
            inferenceOutcome: result?.status === 'RESOLVED' ? (result.receipt?.outcome.status ?? null) : null,
            receiptHash: result?.status === 'RESOLVED' ? (result.receipt?.receiptHash ?? null) : null,
            resolutionHash: result?.status === 'RESOLVED' ? result.resolution.resolutionHash : null,
          }
        }),
      ),
    )
    return {
      batchId: row.batchId,
      cycleId: row.cycleId,
      observationHash: row.observationHash,
      protocolHash: row.plan.protocolHash,
      authorityGenerationHash: row.plan.authorityGenerationHash,
      snapshotId: row.plan.snapshotId,
      observedAt: row.plan.observedAt,
      purpose: row.purpose,
      resultHash: row.result?.resultHash ?? null,
      candidates,
    }
  })

export type JevStudyBatchDescription = Result.Result.Success<ReturnType<typeof describeJevStudyBatch>>

const unique = <A>(rows: readonly A[], key: (row: A) => string) => new Set(rows.map(key)).size === rows.length

export const makeJevStudyCycleOpportunity = (
  cycleInput: unknown,
  sourcesInput: unknown,
  batches: readonly JevStudyBatchDescription[],
  accountId: string,
  sessionDate: string,
  asOf: string,
) =>
  Result.gen(function* () {
    const cycle = yield* Schema.decodeUnknownResult(JevStudyCycleSchema, strictParseOptions)(cycleInput)
    const sources = yield* Schema.decodeUnknownResult(JevStudyCycleSourcesSchema, strictParseOptions)(sourcesInput)
    if (
      !unique(sources.decisions, (row) => row.decision_hash) ||
      !unique(sources.protectionIntents, (row) => row.intentId) ||
      !unique(sources.intents, (row) => row.intent_id) ||
      !unique(sources.orders, (row) => row.event_id) ||
      !unique(sources.fills, (row) => row.event_id) ||
      !unique(sources.fills, (row) => row.fill_id) ||
      !unique(sources.mutations, (row) => row.eventId) ||
      !unique(sources.transactions, (row) => row.transactionId) ||
      !unique(batches, (row) => row.batchId)
    )
      return yield* invalid('Opportunity source identities are duplicated')
    // A batch protocolHash hashes parameters; the cycle hash additionally binds strategy behavior.
    // The complete native decision verifier below reproduces that strategy identity.
    if (batches.some((batch) => batch.cycleId !== cycle.cycleId))
      return yield* invalid('Opportunity batch differs from its cycle')

    const verified = verifyPerformanceDecisions(sources.decisions)
    if (verified.unverifiedDecisionHashes.length > 0)
      return yield* invalid('Opportunity decision does not reproduce through the retained execution verifier')
    const documents = verified.verifiedRows.map((row) => row.document)
    for (const row of verified.verifiedRows) {
      const document = row.document
      if (
        row.cycle_id !== cycle.cycleId ||
        document.bindings.cycleId !== cycle.cycleId ||
        document.bindings.accountId !== accountId ||
        document.bindings.strategyProtocolHash !== cycle.protocolHash ||
        document.contentHash !== row.decision_hash ||
        document.createdAt !== row.created_at.toISOString() ||
        document.createdAt > asOf
      )
        return yield* invalid('Opportunity decision identity, scope or cut differs')
    }

    const gaps: { readonly code: string; readonly sourceId: string }[] = []
    const gap = (code: string, sourceId: string) => gaps.push({ code, sourceId })
    const entry = documents.find((document) => document.contentHash === cycle.decisionHash)
    if (cycle.decisionHash !== null && entry === undefined) gap('MISSING_CYCLE_DECISION', cycle.decisionHash)
    const target = entry !== undefined && 'strategyDecision' in entry ? entry.strategyDecision : undefined
    const jevEntry = target?.schemaVersion === 'bayn.jev-entry-target.v7' ? target : undefined
    if (jevEntry !== undefined) {
      if (jevEntry.sessionDate !== sessionDate) return yield* invalid('Opportunity entry belongs to another session')
      const batch = batches.find((value) => value.batchId === jevEntry.evidence.batchPlan.batchId)
      if (batch === undefined) gap('MISSING_ENTRY_BATCH', jevEntry.evidence.batchPlan.batchId)
      else if (
        batch.observationHash !== jevEntry.evidence.batchPlan.observationHash ||
        batch.resultHash !== jevEntry.evidence.batchResult.resultHash ||
        batch.authorityGenerationHash !== jevEntry.evidence.observation.authorityGenerationHash
      )
        return yield* invalid('Opportunity entry differs from its exported batch')
    }
    // Native rejections only record unsupported judgments after usable, complete inference.
    const requested =
      jevEntry?.evidence.batchPlan.candidates.filter((candidate) => candidate.status === 'REQUESTED') ?? []
    const completedAbstention =
      requested.length > 0 &&
      requested.every(
        (candidate) => jevEntry?.entryPlanRejections[candidate.symbol] === 'UNSUPPORTED_OR_UNCERTAIN_JUDGMENTS',
      )
    const disposition =
      jevEntry === undefined || entry === undefined
        ? cycle.decisionHash === null
          ? 'NO_RECORDED_DECISION'
          : entry === undefined
            ? 'MISSING_DECISION'
            : 'NON_JEV_ENTRY_DECISION'
        : jevEntry.selectedSymbols.length === 0
          ? completedAbstention
            ? 'ABSTAINED'
            : 'NO_SELECTION'
          : entry.targetPlan.status === 'PLANNED'
            ? 'SELECTED_PLANNED'
            : entry.targetPlan.status === 'BLOCKED'
              ? 'SELECTED_BLOCKED'
              : entry.targetPlan.targets.every(
                    (value) => value.currentQuantityAtoms === '0' && value.targetQuantityAtoms === '0',
                  )
                ? 'SELECTED_ZERO_ALLOCATION'
                : 'SELECTED_TARGETS_SATISFIED'

    const intents = new Map(sources.intents.map((row) => [row.intent_id, row]))
    for (const evidence of sources.protectionIntents)
      if (
        evidence.plan.accountId !== accountId ||
        evidence.plan.cycleId !== cycle.cycleId ||
        evidence.plan.createdAt > asOf ||
        evidence.riskDecision.decidedAt > asOf ||
        evidence.reconciliation.reconciledAt > asOf
      )
        return yield* invalid('Opportunity protection evidence scope or cut differs')
    const plans = yield* executionOrderPlans(
      documents.filter((document) => 'orderedIntentIds' in document).map((document) => ({ document })),
      sources.protectionIntents,
    )
    for (const intentId of plans.keys()) if (!intents.has(intentId)) gap('MISSING_PLANNED_INTENT', intentId)
    for (const intent of sources.intents) {
      if (
        intent.cycle_id !== cycle.cycleId ||
        intent.account_id !== accountId ||
        intent.created_at.toISOString() > asOf ||
        intent.updated_at.toISOString() > asOf
      )
        return yield* invalid('Opportunity intent scope or cut differs')
      const decision = documents.find((document) => document.bindings.strategyDecisionHash === intent.decision_hash)
      if (decision === undefined) gap('MISSING_INTENT_DECISION', intent.intent_id)
      else if (
        !('authorityGenerationHash' in decision.bindings) ||
        decision.bindings.authorityGenerationHash !== intent.authority_generation_hash
      )
        return yield* invalid('Opportunity intent authority differs from its decision')
      const plan = plans.get(intent.intent_id)
      if (plan !== undefined) {
        let expectedPlan: IntentPlan
        if (plan.protectionIntent !== null) {
          // The execution deadline starts at risk.decidedAt; immutable intent identity binds plan.createdAt.
          expectedPlan = plan.protectionIntent.plan
          if (plan.protectionIntent.riskDecision.decisionId !== intent.risk_decision_id)
            return yield* invalid('Opportunity protection approval differs from its persisted intent reference')
        } else {
          const index = plan.document.orderedIntentIds.indexOf(intent.intent_id)
          const target = plan.document.targetPlan.intentTargets[index]
          const risk = plan.document.deltaRisk[index]
          if (target === undefined || risk === undefined) return yield* invalid('Opportunity sealed plan is incomplete')
          expectedPlan = {
            schemaVersion: intentPlanSchemaVersion,
            ...target,
            notionalLimitMicros: risk.notionalLimitMicros,
            limitPriceMicros: risk.limitPriceMicros,
            ...(risk.protection === undefined ? {} : { protection: risk.protection }),
            ...(plan.document.replanGenerationHash === undefined
              ? {}
              : { replanGenerationHash: plan.document.replanGenerationHash }),
          }
        }
        const expected = yield* makeExecutionIntentFromDecodedPlan(expectedPlan, intent.authority_generation_hash)
        if (
          expected.intentId !== intent.intent_id ||
          expected.clientOrderId !== intent.client_order_id ||
          (expectedPlan.replanGenerationHash ?? null) !== intent.replan_generation_hash ||
          plan.target.symbol !== intent.symbol ||
          plan.target.side !== intent.side ||
          plan.target.quantityAtoms !== intent.quantity_atoms ||
          expectedPlan.createdAt !== intent.created_at.toISOString() ||
          expectedPlan.notionalLimitMicros !== intent.notional_limit_micros ||
          (yield* canonicalHashV1Result(plan.risk.protection ?? null)) !==
            (yield* canonicalHashV1Result(intent.protection))
        )
          return yield* invalid('Opportunity intent differs from its sealed target or risk terms')
      } else gap('UNREPRODUCED_EXECUTION_PLAN', intent.intent_id)
    }
    const orderReceipts = []
    const latestOrders = new Map<string, (typeof sources.orders)[number]>()
    for (const order of sources.orders) {
      if (
        order.account_id !== accountId ||
        order.observed_at.toISOString() > asOf ||
        order.occurred_at.toISOString() > asOf
      )
        return yield* invalid('Opportunity order scope or cut differs')
      const intent = intents.get(order.intent_id)
      if (intent === undefined) gap('MISSING_ORDER_INTENT', order.event_id)
      else if (
        order.symbol !== intent.symbol ||
        (order.parent_broker_order_id === null &&
          (order.client_order_id !== intent.client_order_id || order.side !== intent.side))
      )
        return yield* invalid('Opportunity order differs from its original intent identity')
      const prior = latestOrders.get(order.broker_order_id)
      if (
        prior !== undefined &&
        (prior.intent_id !== order.intent_id ||
          prior.account_id !== order.account_id ||
          prior.client_order_id !== order.client_order_id ||
          prior.symbol !== order.symbol ||
          prior.side !== order.side ||
          prior.parent_broker_order_id !== order.parent_broker_order_id)
      )
        return yield* invalid('Opportunity broker order identity changes across lifecycle observations')
      if (
        prior === undefined ||
        BigInt(prior.source_sequence) < BigInt(order.source_sequence) ||
        (prior.source_sequence === order.source_sequence && prior.event_id < order.event_id)
      )
        latestOrders.set(order.broker_order_id, order)
      const value = yield* Schema.decodeUnknownResult(
        OrderSchema,
        strictParseOptions,
      )({
        schemaVersion: order.schema_version,
        accountId: order.account_id,
        brokerOrderId: order.broker_order_id,
        ...(order.parent_broker_order_id === null ? {} : { parentBrokerOrderId: order.parent_broker_order_id }),
        clientOrderId: order.client_order_id,
        intentId: order.intent_id,
        symbol: order.symbol,
        side: order.side,
        orderType: order.order_type,
        timeInForce: order.time_in_force,
        ...(order.quantity_atoms === null ? {} : { quantityAtoms: order.quantity_atoms }),
        ...(order.notional_micros === null ? {} : { notionalMicros: order.notional_micros }),
        filledQuantityAtoms: order.filled_quantity_atoms,
        ...(order.limit_price_micros === null ? {} : { limitPriceMicros: order.limit_price_micros }),
        ...(order.stop_price_micros === null ? {} : { stopPriceMicros: order.stop_price_micros }),
        status: order.status,
        observedAt: order.observed_at.toISOString(),
      })
      const plan = plans.get(order.intent_id)
      if (plan !== undefined) {
        const observation = { eventId: order.event_id, occurredAt: order.occurred_at.toISOString(), order: value }
        orderReceipts.push({
          ...observation,
          intentId: order.intent_id,
          decisionId: plan.decisionId,
          authorityGenerationHash: plan.document.bindings.authorityGenerationHash,
          sourceHash: yield* canonicalHashV1Result(observation),
        })
      }
    }
    const latestReceipts = orderReceipts.filter(
      (row) => latestOrders.get(row.order.brokerOrderId)?.event_id === row.eventId,
    )
    for (const row of latestReceipts) {
      const root =
        row.order.parentBrokerOrderId === undefined
          ? row
          : latestReceipts.find((value) => value.order.brokerOrderId === row.order.parentBrokerOrderId)
      const plan = plans.get(row.intentId)
      if (root === undefined || plan === undefined) {
        gap('MISSING_NATIVE_ORDER_ROOT', row.eventId)
        continue
      }
      const children = latestReceipts.filter((value) => value.order.parentBrokerOrderId === root.order.brokerOrderId)
      if (new Set([root, ...children].map((value) => value.order.clientOrderId)).size !== children.length + 1)
        return yield* invalid('Opportunity native group has duplicate client identities')
      const terms = yield* resolveExecutionOrderTerms(row.order.brokerOrderId, root, children, plan)
      if (terms._tag === 'Missing') gap(terms.reason, row.eventId)
    }
    for (const fill of sources.fills) {
      if (
        fill.account_id !== accountId ||
        fill.observed_at.toISOString() > asOf ||
        fill.occurred_at.toISOString() > asOf
      )
        return yield* invalid('Opportunity fill scope or cut differs')
      const intent = intents.get(fill.intent_id)
      if (intent === undefined) gap('MISSING_FILL_INTENT', fill.event_id)
      else if (fill.symbol !== intent.symbol) return yield* invalid('Opportunity fill symbol differs from its intent')
      const order = latestOrders.get(fill.broker_order_id)
      if (order === undefined) gap('MISSING_FILL_ORDER', fill.event_id)
      else if (
        order.intent_id !== fill.intent_id ||
        order.client_order_id !== fill.client_order_id ||
        order.account_id !== fill.account_id ||
        order.symbol !== fill.symbol ||
        order.side !== fill.side
      )
        return yield* invalid('Opportunity fill differs from its exact broker order and client identity')
      if (!sources.transactions.some((transaction) => transaction.brokerEventId === fill.event_id))
        gap('UNACCOUNTED_FILL', fill.event_id)
    }
    for (const mutation of sources.mutations) {
      if (mutation.occurredAt > asOf) return yield* invalid('Opportunity mutation exceeds its cut')
      if (!intents.has(mutation.intentId)) gap('MISSING_MUTATION_INTENT', mutation.eventId)
    }
    for (const order of latestOrders.values()) {
      const quantity = sources.fills
        .filter((fill) => fill.broker_order_id === order.broker_order_id)
        .reduce((sum, fill) => sum + BigInt(fill.quantity_atoms), 0n)
      if (quantity !== BigInt(order.filled_quantity_atoms))
        gap(
          quantity < BigInt(order.filled_quantity_atoms) ? 'MISSING_ORDER_FILLS' : 'ORDER_FILL_QUANTITY_LAG',
          order.event_id,
        )
    }
    for (const transaction of sources.transactions) {
      const { contentHash, ...material } = transaction
      if (
        transaction.accountId !== accountId ||
        transaction.occurredAt > asOf ||
        (yield* canonicalHashV1Result(material)) !== contentHash
      )
        return yield* invalid('Opportunity accounting transaction scope, cut or content hash differs')
      const fill = sources.fills.find((value) => value.event_id === transaction.brokerEventId)
      if (fill === undefined) gap('MISSING_TRANSACTION_FILL', transaction.transactionId)
      else if (
        transaction.intentId !== fill.intent_id ||
        transaction.symbol !== fill.symbol ||
        transaction.side !== fill.side ||
        transaction.quantityAtoms !== fill.quantity_atoms ||
        transaction.priceAtoms !== fill.price_atoms ||
        transaction.feeMicros !== fill.fee_micros ||
        transaction.occurredAt !== fill.occurred_at.toISOString()
      )
        return yield* invalid('Opportunity accounting transaction differs from its original fill')
    }
    if (cycle.state === 'NO_TRADE' && (sources.intents.length > 0 || sources.fills.length > 0))
      return yield* invalid('A no-trade cycle has execution activity')

    const rows = sources.intents.map((intent) => ({
      intentId: intent.intent_id,
      cycleId: intent.cycle_id,
      decisionHash: intent.decision_hash,
      authorityGenerationHash: intent.authority_generation_hash,
      riskDecisionId: intent.risk_decision_id,
      clientOrderId: intent.client_order_id,
      symbol: intent.symbol,
      side: intent.side,
      quantityAtoms: intent.quantity_atoms,
      notionalLimitMicros: intent.notional_limit_micros,
      state: intent.state,
      terminalOutcome: intent.terminal_outcome,
      protection: intent.protection,
      replanGenerationHash: intent.replan_generation_hash,
      createdAt: intent.created_at.toISOString(),
      updatedAt: intent.updated_at.toISOString(),
      mutationEventIds: sources.mutations.filter((row) => row.intentId === intent.intent_id).map((row) => row.eventId),
      orderEventIds: sources.orders.filter((row) => row.intent_id === intent.intent_id).map((row) => row.event_id),
      fillEventIds: sources.fills.filter((row) => row.intent_id === intent.intent_id).map((row) => row.event_id),
    }))
    return {
      recordType: 'CYCLE' as const,
      cycle,
      disposition,
      selectedSymbols: jevEntry?.selectedSymbols ?? null,
      entryPlanRejections: jevEntry?.entryPlanRejections ?? null,
      targetPlanStatus: entry?.targetPlan.status ?? null,
      targetPlanReason: entry?.targetPlan.reason ?? null,
      batches,
      // Retain the complete verifier input, not a prefix claiming to be a sealed decision.
      decisions: documents,
      protectionIntents: sources.protectionIntents,
      intents: rows,
      mutations: sources.mutations,
      orders: sources.orders.map(({ occurred_at, observed_at, ...row }) => ({
        ...row,
        occurred_at: occurred_at.toISOString(),
        observed_at: observed_at.toISOString(),
      })),
      fills: sources.fills.map(({ occurred_at, observed_at, ...row }) => ({
        ...row,
        occurred_at: occurred_at.toISOString(),
        observed_at: observed_at.toISOString(),
      })),
      transactions: sources.transactions,
      exitReasons: documents.flatMap((document) =>
        'strategyDecision' in document && document.strategyDecision.schemaVersion === 'bayn.jev-exit-target.v5'
          ? [{ decisionHash: document.contentHash, reason: document.strategyDecision.reason }]
          : [],
      ),
      joinCoverage: gaps.length === 0 ? 'COMPLETE_FOR_RECORDED_CYCLE_ROWS' : 'INCOMPLETE',
      gaps,
      financialVerification: 'TRANSACTION_CONTENT_AND_FILL_JOIN_ONLY',
      independentlyVerifiedLedger: false,
      recordedGrossRealizedPnlMicros: sources.transactions
        .reduce((sum, transaction) => sum + BigInt(transaction.realizedPnlMicros), 0n)
        .toString(),
      reportedFillFeeMicros: sources.fills.reduce((sum, fill) => sum + BigInt(fill.fee_micros), 0n).toString(),
      brokerFeeCoverage: 'UNKNOWN',
      operatingCostCoverage: 'UNKNOWN',
      allInProfitMicros: null,
    }
  })

export const makeJevStudyInferenceOpportunity = (
  sourceInput: unknown,
  quotes: readonly InferenceExpenseRecord[],
  scope: { readonly accountId: string; readonly sessionDate: string; readonly asOf: string },
  cycles: ReadonlySet<string>,
  candidates: readonly Pick<JevStudyBatchDescription['candidates'][number], 'requestId' | 'requestFingerprint'>[],
) =>
  Result.gen(function* () {
    const source = yield* decodeInferenceCostRequest(sourceInput, scope.asOf)
    const accountBindingHash = yield* canonicalHashV1Result({
      schemaVersion: 'bayn.inference-cost-account.v1',
      accountId: scope.accountId,
    })
    const evidence = {
      schemaVersion: 'bayn.inference-cost-evidence.v4' as const,
      accountBindingHash,
      sessionDate: yield* Schema.decodeUnknownResult(IsoDateSchema)(scope.sessionDate),
      asOf: scope.asOf,
      requests: [source],
    }
    const cost = yield* verifyInferenceExpenseCoverage(evidence, scope.accountId, quotes)
    const usage = yield* makeInferenceCostReport(evidence, { schemaVersion: 'bayn.inference-rate-card.v1', rates: [] })
    const matches = candidates.filter((candidate) => candidate.requestId === source.requestId)
    for (const candidate of matches)
      if (candidate.requestFingerprint !== (yield* canonicalHashV1Result(source.request)))
        return yield* invalid('Inference request differs from its original batch candidate')
    if (quotes.some((quote) => quote.verifiedAt !== null && quote.verifiedAt > scope.asOf))
      return yield* invalid('Inference quote verification exceeds the export cut')
    const { requestSchemaVersion: _version, sourceFingerprint, stages: _stages, ...original } = source
    const request: typeof InferenceCostRequestSchema.Type = original
    return {
      recordType: 'INFERENCE_REQUEST' as const,
      cycleId: source.cycleId,
      requestId: source.requestId,
      authorityGenerationHash: source.authorityGenerationHash,
      cycleJoin: cycles.has(source.cycleId) ? 'MATCHED' : 'OUTSIDE_JEV_CYCLE_INVENTORY',
      candidateJoin: matches.length > 0 ? 'MATCHED' : 'MISSING_BATCH_CANDIDATE',
      sourceFingerprint,
      source: request,
      frozenQuotes: quotes,
      costCoverage: cost,
      logicalRequestCount: 1,
      stageObligationCount: usage.requests.length,
      meteredStageCount: usage.requests.filter(
        (line) =>
          line.usageStatus === InferenceUsageStatus.Received || line.usageStatus === InferenceUsageStatus.Rejected,
      ).length,
      notDispatchedStageCount: usage.notDispatchedRequestCount,
      unknownUsageStageCount: usage.unknownUsageCount,
      // A stage obligation, including a recorded skip, is not evidence of a paid provider call.
      providerCallCount: null,
      invoiceReconciled: false,
      stages: usage.requests,
    }
  })
