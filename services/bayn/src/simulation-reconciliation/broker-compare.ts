import { Result, pipe } from 'effect'

import {
  compareAccountStatus,
  compareCash,
  compareEquity,
  compareLedger,
  comparePositions,
  temporalMetrics,
  validateAccountBindings,
} from './broker-account-comparison'
import {
  canonicalHash,
  indexUnique,
  type ReconciliationComparison,
  type ReconciliationDecision,
  type ReconciliationSnapshot,
} from './broker-model'
import { compareFills, compareOrders } from './broker-order-comparison'

export const compareReconciliation = (
  snapshot: ReconciliationSnapshot,
): ReconciliationDecision<ReconciliationComparison> =>
  pipe(
    Result.all({
      bindings: validateAccountBindings(snapshot),
      account: compareAccountStatus(snapshot),
      orders: compareOrders(snapshot),
      fills: compareFills(snapshot),
      positions: comparePositions(snapshot),
      cash: compareCash(snapshot),
      equity: compareEquity(snapshot),
      ledger: compareLedger(snapshot),
      temporal: temporalMetrics(snapshot),
    }),
    Result.flatMap(({ account, cash, equity, fills, ledger, orders, positions, temporal }) => {
      const ordered = [
        ...account,
        ...orders,
        ...fills,
        ...positions.discrepancies,
        ...cash.discrepancies,
        ...equity.discrepancies,
        ...ledger,
      ].sort((left, right) =>
        left.discrepancyId < right.discrepancyId ? -1 : left.discrepancyId > right.discrepancyId ? 1 : 0,
      )
      return pipe(
        indexUnique(ordered, (value) => value.discrepancyId, 'discrepancy'),
        Result.flatMap(() =>
          ordered.length === 0
            ? Result.succeed(snapshot.stateHash)
            : canonicalHash('observed-hash', {
                schemaVersion: 'bayn.paper-reconciliation-observed.v1',
                stateHash: snapshot.stateHash,
                discrepancies: ordered.map((value) => value.evidenceHash),
              }),
        ),
        Result.map((observedHash) => ({
          expectedHash: snapshot.stateHash,
          observedHash,
          discrepancies: ordered,
          metrics: {
            ...temporal,
            cashDifferenceMicros: cash.difference.toString(),
            positionDifferenceMicros: positions.difference.toString(),
            equityDifferenceMicros: equity.difference.toString(),
            accountingExact: snapshot.ledgerExact,
            discrepancyCount: ordered.length,
          },
        })),
      )
    }),
  )
