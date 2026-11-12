import { Effect, Result } from 'effect'
import { intentPlanSchemaVersion } from '../execution/contracts'
import { makePersistenceDocumentFixture } from './decision-persistence.test-support'
import { bracketEvidenceFixture, nativeEntryEvidenceFixture } from './bracket-evidence.test-support'
import { executionOrderPlans } from './execution-plans'
import { makeExecutionIntentFromDecodedPlan } from '../execution/intents/domain'
import { BrokerReadErrorKind } from '../broker/alpaca/failures'
import { nativeSafetyFixture } from './operational-safety.test-support'
import { testHash } from './fixtures.test-support'
import { makeOperationalSafetyScan } from './operational-safety'
import type { OperationalSafetySource } from './operational-safety-source'

export const nativeOrderSafetyFixture = async () => {
  const f = nativeSafetyFixture()
  const document = await Effect.runPromise(makePersistenceDocumentFixture(f.definition.riskPolicy.accountId))
  const entry =
    document.deltaRisk[0]?.protection?._tag === 'Bracket'
      ? bracketEvidenceFixture(document)
      : nativeEntryEvidenceFixture(document)
  const plans = Result.getOrThrow(executionOrderPlans(entry.cut.decisions, []))
  const id = document.orderedIntentIds[0]!
  const target = document.targetPlan.intentTargets[0]!
  const delta = document.deltaRisk[0]!
  const plan = {
    schemaVersion: intentPlanSchemaVersion,
    ...target,
    notionalLimitMicros: delta.notionalLimitMicros,
    limitPriceMicros: delta.limitPriceMicros,
    ...(delta.protection === undefined ? {} : { protection: delta.protection }),
  }
  const intent = Result.getOrThrow(makeExecutionIntentFromDecodedPlan(plan, document.bindings.authorityGenerationHash))
  const registration = {
    ...f.registration,
    policies: [{ ...f.definition, authorityGenerationHash: document.bindings.authorityGenerationHash }] as const,
  }
  const authority = { ...f.authority, generation_hash: document.bindings.authorityGenerationHash }
  const rawOrders = entry.cut.orders.map((row) => ({
    eventId: row.eventId,
    contentHash: testHash(row.order),
    occurredAt: row.occurredAt,
    order:
      row.order.parentBrokerOrderId === undefined ? { ...row.order, clientOrderId: intent.clientOrderId } : row.order,
  }))
  const rawFills = entry.cut.fills.map((fill) => ({
    eventId: fill.fillId,
    contentHash: testHash(fill),
    sourceTimestamp: `${fill.occurredAt.slice(0, -1)}000000Z`,
    sourceSequence: fill.sourceSequence,
    observedAt: entry.cut.asOf,
    transactionId: null,
    receiptId: null,
    fill: {
      schemaVersion: 'bayn.fill.v2' as const,
      accountId: target.accountId,
      fillId: fill.fillId,
      brokerOrderId: fill.brokerOrderId,
      clientOrderId: rawOrders.find((row) => row.order.brokerOrderId === fill.brokerOrderId)!.order.clientOrderId,
      intentId: id,
      symbol: target.symbol,
      side: fill.side,
      quantityAtoms: fill.quantityAtoms,
      priceAtoms: fill.priceAtoms,
      feeMicros: '0',
      occurredAt: fill.occurredAt,
    },
  }))
  const source: OperationalSafetySource = {
    ...f.safety,
    authority,
    baseline: { capturedAt: f.registration.registeredAt, authority },
    broker: {
      status: 'UNAVAILABLE',
      kind: BrokerReadErrorKind.ObservationPending,
      operation: 'fixture',
      retryable: true,
    },
    intents: [
      {
        intentId: id,
        authorityGenerationHash: document.bindings.authorityGenerationHash,
        plan,
        risk: delta.evaluation.decision,
      },
    ],
    orders: rawOrders,
    fills: rawFills,
  }
  const scan = (safety: OperationalSafetySource, mutations = entry.cut.mutations.slice(0, 0)) => {
    const sourceMaterial = { ...f.sourceMaterial, safety }
    const cut = { ...f.cut, sourceMaterial, sourceMaterialHash: testHash(sourceMaterial), mutations }
    const auditor = Result.getOrThrow(makeOperationalSafetyScan(cut, registration))
    Result.getOrThrow(auditor.consume(plans))
    return Result.getOrThrow(auditor.finish())
  }
  return { scan, source, rawFills, rawOrders, target, entry, plans, id, document, intent, authority, delta }
}
