import { Effect } from 'effect'

import type { ReconciliationPersistence } from '../db/execution-store'
import type { BrokerSnapshot, ReconciliationReport, ReconciliationWriteResult } from '../db/reconciliation'
import type { WriterFenceService } from '../execution/writer-fence'
import {
  compareText,
  type NormalizedBrokerSnapshot,
  type ReconciliationPassResult,
  type ReconciliationWriteDecision,
  type StableBrokerSnapshot,
} from './broker-reconciler-model'
import { prepareNormalizedSnapshot } from './broker-normalization'

const ingestBrokerEvents = (store: ReconciliationPersistence, normalized: NormalizedBrokerSnapshot) =>
  Effect.gen(function* () {
    const accountReceipt = yield* store.events.ingest(normalized.account)
    const positionsReceipt = yield* store.events.ingestPositions(normalized.positions)
    yield* Effect.forEach(normalized.orderEvents, store.events.ingest, { discard: true })
    yield* Effect.forEach(normalized.fillEvents, store.accounting.account, { discard: true })
    return yield* store.valuation.value({
      accountEventId: accountReceipt.eventId,
      positionSnapshotId: positionsReceipt.snapshotId,
    })
  })

const makeReconciliationDecision = (
  normalized: NormalizedBrokerSnapshot,
  ordersObservedAt: string,
  valuation: BrokerSnapshot['valuation'],
  reconciledAt: string,
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
      positions,
      positionsObservedAt: normalized.positions.observedAt,
      orders,
      ordersObservedAt,
      fills: normalized.fillEvents.map((event) => event.fill),
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
  Effect.logInfo('Paper account reconciliation completed').pipe(
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
  now: Effect.Effect<string>,
) =>
  Effect.gen(function* () {
    const valuation = yield* ingestBrokerEvents(store, normalized)
    const decision = makeReconciliationDecision(normalized, ordersObservedAt, valuation, yield* now)
    const persisted = yield* store.reconciliation.reconcile(decision.snapshot)
    const result = makePassResult(decision, persisted)
    yield* logCompletedPass(result, decision)
    return result
  })

export const persistStableSnapshot = (
  store: ReconciliationPersistence,
  fence: WriterFenceService,
  snapshot: StableBrokerSnapshot,
  now: Effect.Effect<string>,
) =>
  fence.transaction(
    prepareNormalizedSnapshot(store, snapshot).pipe(
      Effect.flatMap((normalized) => writeReconciliation(store, normalized, snapshot.history.orders.observedAt, now)),
    ),
  )
