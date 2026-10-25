import { Effect } from 'effect'

import type { ReconciliationPersistence } from '../db/execution-store'
import type { BrokerSnapshot, ReconciliationReport, ReconciliationWriteResult } from '../db/reconciliation'
import {
  compareText,
  type NormalizedBrokerSnapshot,
  type ReconciliationPassResult,
  type ReconciliationError,
  type ReconciliationWriteDecision,
  type StableBrokerSnapshot,
} from './broker-reconciler-model'
import { prepareNormalizedSnapshot } from './broker-normalization'

const ingestBrokerEvents = (store: ReconciliationPersistence, normalized: NormalizedBrokerSnapshot) =>
  Effect.gen(function* () {
    const accountReceipt = yield* store.events.ingest(normalized.account)
    // Retain the report's precision with its account event, avoiding a separate durable write in
    // the subsequent fee-preparation transaction. Reconciliation still verifies this exact binding.
    yield* store.reconciliation.retainCashReporting({
      account: normalized.account.account,
      accountEventId: accountReceipt.eventId,
      cashReportingQuantumMicros: normalized.cashReportingQuantumMicros,
    })
    const positionsReceipt = yield* store.events.ingestPositions(normalized.positions)
    const complete = yield* store.events.completeHistory([...normalized.orderEvents, ...normalized.fillEvents])
    yield* store.accounting.verifyCompleted(normalized.fillEvents.filter((event) => complete.has(event.sourceEventId)))
    yield* Effect.forEach(
      normalized.orderEvents.filter((event) => !complete.has(event.sourceEventId)),
      store.events.ingest,
      { discard: true },
    )
    yield* Effect.forEach(
      normalized.fillEvents.filter((event) => !complete.has(event.sourceEventId)),
      store.accounting.account,
      { discard: true },
    )
    const valuation = yield* store.valuation.value({
      accountEventId: accountReceipt.eventId,
      positionSnapshotId: positionsReceipt.snapshotId,
    })
    return { valuation, positionSnapshotId: positionsReceipt.snapshotId, accountEventId: accountReceipt.eventId }
  })

const makeReconciliationDecision = (
  normalized: NormalizedBrokerSnapshot,
  ordersObservedAt: string,
  valuation: BrokerSnapshot['valuation'],
  reconciledAt: string,
  positionSnapshotId: string,
  accountEventId: string,
): ReconciliationWriteDecision => {
  const positions = normalized.positions.positions
    .map((event) => event.position)
    .sort((left, right) => compareText(left.symbol, right.symbol))
  const orders = normalized.orderEvents
    .map((event) => event.order)
    .sort((left, right) => compareText(left.brokerOrderId, right.brokerOrderId))
  return {
    snapshot: {
      account: normalized.account.account,
      cashReportingQuantumMicros: normalized.cashReportingQuantumMicros,
      positions,
      positionsObservedAt: normalized.positions.observedAt,
      positionSnapshotId,
      accountEventId,
      orders,
      ordersObservedAt,
      fills: normalized.fillEvents.map((event) => event.fill),
      fees: normalized.fees,
      valuation,
      reconciledAt,
    },
    unknownOrderCount: orders.filter((order) => order.intentId === undefined).length,
    orderCount: normalized.orderEvents.length,
    fillCount: normalized.fillEvents.length,
  }
}

const makePassResult = (
  decision: ReconciliationWriteDecision,
  persisted: ReconciliationWriteResult,
): ReconciliationPassResult => {
  const report: ReconciliationReport = {
    reconciliation: persisted.reconciliation,
    metrics: persisted.metrics,
  }
  return {
    report,
    brokerState: {
      account: decision.snapshot.account,
      positions: decision.snapshot.positions,
      positionsObservedAt: decision.snapshot.positionsObservedAt,
      orders: decision.snapshot.orders,
      ordersObservedAt: decision.snapshot.ordersObservedAt,
      accountingHash: persisted.accountingHash,
      reconciliation: persisted.reconciliation,
      unknownOrderCount: decision.unknownOrderCount,
    },
    riskContext: persisted.riskContext,
  }
}

const logCompletedPass = (
  result: ReconciliationPassResult,
  decision: ReconciliationWriteDecision,
): Effect.Effect<void> =>
  Effect.logInfo('Broker account reconciliation completed').pipe(
    Effect.annotateLogs({
      status: result.report.reconciliation.status,
      reconciliationId: result.report.reconciliation.reconciliationId,
      orderCount: decision.orderCount,
      fillCount: decision.fillCount,
      discrepancyCount: result.report.metrics.discrepancyCount,
      brokerPollAgeMs: result.report.metrics.brokerPollAgeMs,
      oldestUnknownMutationAgeMs: result.report.metrics.oldestUnknownMutationAgeMs,
      accountingExact: result.report.metrics.accountingExact,
    }),
  )

const writeReconciliation = (
  store: ReconciliationPersistence,
  normalized: NormalizedBrokerSnapshot,
  ordersObservedAt: string,
  now: Effect.Effect<string, ReconciliationError>,
) =>
  Effect.gen(function* () {
    const { snapshot, persisted } = yield* store.reconciliation.reconcile(
      normalized.account.accountId,
      Effect.gen(function* () {
        const { valuation, positionSnapshotId, accountEventId } = yield* ingestBrokerEvents(store, normalized)
        return makeReconciliationDecision(
          normalized,
          ordersObservedAt,
          valuation,
          yield* now,
          positionSnapshotId,
          accountEventId,
        ).snapshot
      }),
    )
    const decision: ReconciliationWriteDecision = {
      snapshot,
      unknownOrderCount: snapshot.orders.filter((order) => order.intentId === undefined).length,
      orderCount: normalized.orderEvents.length,
      fillCount: normalized.fillEvents.length,
    }
    const result = makePassResult(decision, persisted)
    yield* logCompletedPass(result, decision)
    return result
  })

export const persistStableSnapshot = (
  store: ReconciliationPersistence,
  snapshot: StableBrokerSnapshot,
  now: Effect.Effect<string, ReconciliationError>,
) =>
  Effect.gen(function* () {
    const normalized = yield* prepareNormalizedSnapshot(store, snapshot)
    return yield* writeReconciliation(store, normalized, snapshot.history.orders.observedAt, now)
  })
