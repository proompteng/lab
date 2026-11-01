import { Result, Schema } from 'effect'
import {
  OrderSchema,
  OrderSide,
  OrderStatus,
  OrderType,
  RiskDecisionSchema,
  RiskOutcome,
  TimeInForce,
  intentPlanSchemaVersion,
} from '../execution/contracts'
import { makeExecutionIntentFromDecodedPlan, type IntentPlan } from '../execution/intents/domain'
import type { ExecutionDecisionDocument } from '../shadow-decision-contract'
import { bracketEvidenceFixture, nativeEntryEvidenceFixture } from './bracket-evidence.test-support'
import { testHash } from './fixtures.test-support'
import type { ProtectionIntentEvidence } from './execution-plans'
import { MutationEventSchema } from '../execution/mutations/model'

export const replacementProtectionFixture = (
  document: ExecutionDecisionDocument,
  kind: 'Oco' | 'StopLimit' = 'Oco',
) => {
  const f =
    document.deltaRisk[0]?.protection?._tag === 'Bracket'
      ? bracketEvidenceFixture(document)
      : nativeEntryEvidenceFixture(document)
  const decision = document.strategyDecision
  if (decision === undefined || !('exitPolicy' in decision)) throw new Error('Expected a protected entry decision')
  const terms = decision.exitPolicy.plans[f.parent.symbol]!.levels
  const risk = document.deltaRisk[0]!
  const { contentHash: _content, reconciliationId: _id, ...originalReconciliation } = risk.facts!.state.reconciliation
  const reconciliationMaterial = { ...originalReconciliation, reconciledAt: f.at(500) }
  const reconciliationId = testHash({
    schemaVersion: 'bayn.paper-reconciliation-id.v1',
    material: reconciliationMaterial,
  })
  const reconciliation = {
    ...reconciliationMaterial,
    reconciliationId,
    contentHash: testHash({ ...reconciliationMaterial, reconciliationId }),
  }
  const protection =
    kind === 'Oco'
      ? {
          _tag: kind,
          profitLimitPriceMicros: terms.profitLimitPriceMicros,
          stopPriceMicros: terms.stopPriceMicros,
          stopLimitPriceMicros: terms.stopLimitPriceMicros,
          entryDecisionHash: document.contentHash,
        }
      : { _tag: kind, stopPriceMicros: terms.stopPriceMicros, entryDecisionHash: document.contentHash }
  const plan: IntentPlan = {
    schemaVersion: intentPlanSchemaVersion,
    strategyName: document.bindings.strategyName,
    cycleId: document.bindings.cycleId,
    decisionHash: document.bindings.strategyDecisionHash,
    policyHash: document.bindings.policyHash,
    accountId: document.bindings.accountId,
    symbol: f.parent.symbol,
    side: OrderSide.Sell,
    orderType: kind === 'Oco' ? OrderType.Limit : OrderType.StopLimit,
    timeInForce: f.parent.symbol.includes('/') ? TimeInForce.GoodUntilCanceled : TimeInForce.Day,
    quantityAtoms: f.parent.quantityAtoms!,
    limitPriceMicros: kind === 'Oco' ? terms.profitLimitPriceMicros : terms.stopLimitPriceMicros,
    notionalLimitMicros: (
      (BigInt(f.parent.quantityAtoms!) *
        BigInt(kind === 'Oco' ? terms.profitLimitPriceMicros : terms.stopLimitPriceMicros)) /
      1000000000n
    ).toString(),
    protection,
    replanGenerationHash: testHash({
      entryDecisionHash: document.contentHash,
      reconciliationId: reconciliation.reconciliationId,
      protection,
    }),
    createdAt: f.at(1000),
  }
  const intent = Result.getOrThrow(makeExecutionIntentFromDecodedPlan(plan, document.bindings.authorityGenerationHash))
  const riskMaterial = {
    schemaVersion: risk.evaluation.decision.schemaVersion,
    intentId: intent.intentId,
    policyHash: plan.policyHash,
    inputHash: testHash('replacement-risk-input'),
    outcome: RiskOutcome.Approved,
    reasonCodes: [],
    decidedAt: f.at(1001),
    expiresAt: f.at(5000),
  }
  const riskDecision = Schema.decodeUnknownSync(RiskDecisionSchema)({
    ...riskMaterial,
    decisionId: testHash(riskMaterial),
  })
  const material = {
    plan,
    authorityGenerationHash: document.bindings.authorityGenerationHash,
    intentId: intent.intentId,
    clientOrderId: intent.clientOrderId,
    riskDecision,
    reconciliation,
  }
  const evidence: ProtectionIntentEvidence = { ...material, sourceHash: testHash(material) }
  const parent = Schema.decodeUnknownSync(OrderSchema)({
    ...f.parent,
    brokerOrderId: 'replacement-parent',
    clientOrderId: intent.clientOrderId,
    intentId: intent.intentId,
    side: OrderSide.Sell,
    orderType: plan.orderType,
    timeInForce: plan.timeInForce,
    limitPriceMicros: plan.limitPriceMicros,
    ...(kind === 'StopLimit' ? { stopPriceMicros: terms.stopPriceMicros } : {}),
    filledQuantityAtoms: kind === 'Oco' ? '1000000000' : f.parent.quantityAtoms!,
    status: kind === 'Oco' ? OrderStatus.Canceled : OrderStatus.Filled,
  })
  const stop = {
    ...parent,
    side: OrderSide.Sell,
    orderType: OrderType.StopLimit,
    stopPriceMicros: terms.stopPriceMicros,
    limitPriceMicros: terms.stopLimitPriceMicros,
    quantityAtoms: (BigInt(parent.quantityAtoms!) - (kind === 'Oco' ? 1000000000n : 0n)).toString(),
    filledQuantityAtoms: (BigInt(parent.quantityAtoms!) - (kind === 'Oco' ? 1000000000n : 0n)).toString(),
    status: OrderStatus.Filled,
    intentId: intent.intentId,
    brokerOrderId: 'replacement-stop',
    clientOrderId: 'replacement-stop-client',
    parentBrokerOrderId: parent.brokerOrderId,
  }
  const orders = [parent, ...(kind === 'Oco' ? [stop] : [])].map((order, index) => {
    const material = { eventId: testHash({ replacementOrder: index }), occurredAt: f.at(8000 + index), order }
    return {
      ...material,
      intentId: intent.intentId,
      decisionId: intent.intentId,
      authorityGenerationHash: document.bindings.authorityGenerationHash,
      sourceHash: testHash(material),
    }
  })
  const fills = [
    ...f.cut.fills.slice(0, 2),
    ...(kind === 'Oco'
      ? [
          { order: parent, quantity: 1000000000n },
          { order: stop, quantity: BigInt(stop.quantityAtoms!) },
        ]
      : [{ order: parent, quantity: BigInt(parent.quantityAtoms!) }]
    ).map(({ order, quantity }, index) => ({
      ...f.cut.fills[0]!,
      sourceSequence: String(index + 3),
      fillId: testHash({ replacementFill: kind, index }),
      intentId: intent.intentId,
      decisionId: intent.intentId,
      brokerOrderId: order.brokerOrderId,
      side: OrderSide.Sell,
      quantityAtoms: quantity.toString(),
      priceAtoms: (BigInt(order.limitPriceMicros!) * 1000n).toString(),
      occurredAt: f.at(2000 + index * 1000),
    })),
  ]
  const supplied = fills.map((fill) => ({
    ...f.supplied[0]!,
    fillId: fill.fillId,
    intentId: fill.intentId,
    decisionId: fill.decisionId,
    orderId: fill.brokerOrderId,
    side: fill.side,
    fillQuantityAtoms: fill.quantityAtoms,
    fillPriceAtoms: fill.priceAtoms,
    sourceHash: fill.sourceHash,
    filledAt: fill.occurredAt,
  }))
  const start = Schema.decodeUnknownSync(MutationEventSchema)({
    schemaVersion: 'bayn.paper-mutation-event.v1',
    eventId: testHash('replacement-start'),
    mutationId: testHash('replacement-mutation'),
    intentId: intent.intentId,
    sequence: 1,
    eventType: 'SUBMIT_STARTED',
    operation: 'SUBMIT',
    requestHash: testHash('replacement-request'),
    consistencyDelayMs: 1000,
    occurredAt: f.at(1001),
  })
  const outcome = {
    ...start,
    eventId: testHash('replacement-outcome'),
    sequence: 2,
    eventType: f.cut.mutations[0]!.event.eventType,
    occurredAt: f.at(1004),
    routing: { startedAt: f.at(1002), requestDispatchedAt: f.at(1003), completedAt: f.at(1004) },
  }
  const admissionMaterial = { eventId: start.eventId, decisionId: document.contentHash, observedAt: f.at(1002) }
  const cut = {
    ...f.cut,
    protectionIntents: [evidence],
    fills,
    orders: [
      ...f.cut.orders.map((row, index) => {
        if (index === 0) return row
        const material = {
          eventId: row.eventId,
          occurredAt: row.occurredAt,
          order: { ...row.order, status: OrderStatus.Canceled, filledQuantityAtoms: '0' },
        }
        return { ...row, ...material, sourceHash: testHash(material) }
      }),
      ...orders,
    ],
    mutations: [
      ...f.cut.mutations,
      ...[start, outcome].map((event) => ({
        authorityGenerationHash: evidence.authorityGenerationHash,
        strategyDecisionHash: document.bindings.strategyDecisionHash,
        event,
      })),
    ],
    decisionAdmissions: [{ ...admissionMaterial, sourceHash: testHash(admissionMaterial) }],
  }
  return { ...f, terms, evidence, parent, stop, cut, supplied }
}
