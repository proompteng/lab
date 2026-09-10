import { HashMap, HashSet, Option, Result, pipe } from 'effect'

import { AccountStatus, DiscrepancyKind, type Position } from '../execution/contracts'
import {
  absolute,
  compareValue,
  fail,
  indexUnique,
  instant,
  integer,
  roundMicrosProduct,
  type DiscrepancyInput,
  type ProjectedPosition,
  type ReconciliationAccountSource,
  type ReconciliationDecision,
  type ReconciliationSnapshot,
} from './broker-model'

export interface PositionComparison {
  readonly difference: bigint
  readonly discrepancies: readonly DiscrepancyInput[]
}

const comparePosition = (
  snapshot: ReconciliationSnapshot,
  observed: HashMap.HashMap<string, Position>,
  projected: HashMap.HashMap<string, ProjectedPosition>,
  symbol: string,
): ReconciliationDecision<PositionComparison> => {
  const expectedPosition = Option.getOrUndefined(HashMap.get(projected, symbol))
  const observedPosition = Option.getOrUndefined(HashMap.get(observed, symbol))
  const expectedQuantityText = expectedPosition?.quantityMicros ?? '0'
  const observedQuantityText = observedPosition?.quantityMicros ?? '0'
  const expectedCostText = expectedPosition?.costBasisMicros ?? '0'
  return pipe(
    Result.all({
      expectedQuantity: integer('projected-position-quantity', symbol, expectedQuantityText),
      observedQuantity: integer('position-quantity', symbol, observedQuantityText),
      expectedCost: integer('projected-position-cost', symbol, expectedCostText),
      observedCost:
        observedPosition === undefined
          ? Result.succeed(0n)
          : roundMicrosProduct(symbol, observedPosition.quantityMicros, observedPosition.averageEntryPriceMicros),
    }),
    Result.flatMap(({ expectedCost, expectedQuantity, observedCost, observedQuantity }) =>
      pipe(
        Result.all({
          quantity: compareValue(
            snapshot.accountId,
            DiscrepancyKind.Position,
            `${symbol}:quantity`,
            expectedQuantity.toString(),
            observedQuantity.toString(),
          ),
          cost: compareValue(
            snapshot.accountId,
            DiscrepancyKind.Position,
            `${symbol}:cost`,
            expectedCost.toString(),
            observedCost.toString(),
          ),
        }),
        Result.map(({ cost, quantity }) => ({
          difference: absolute(expectedQuantity - observedQuantity),
          discrepancies: [...quantity, ...cost],
        })),
      ),
    ),
  )
}

export const comparePositions = (snapshot: ReconciliationSnapshot): ReconciliationDecision<PositionComparison> =>
  pipe(
    Result.all({
      observed: indexUnique(snapshot.positions, (position) => position.symbol, 'broker-position'),
      projected: indexUnique(snapshot.projectedPositions, (position) => position.symbol, 'projected-position'),
    }),
    Result.flatMap(({ observed, projected }) => {
      const symbols = [
        ...HashSet.union(HashSet.fromIterable(HashMap.keys(observed)), HashSet.fromIterable(HashMap.keys(projected))),
      ].sort()
      return pipe(
        Result.all(symbols.map((symbol) => comparePosition(snapshot, observed, projected, symbol))),
        Result.map((comparisons) => ({
          difference: comparisons.reduce((total, comparison) => total + comparison.difference, 0n),
          discrepancies: comparisons.flatMap((comparison) => comparison.discrepancies),
        })),
      )
    }),
  )

const accountBinding = (
  source: ReconciliationAccountSource,
  identity: string,
  expectedAccountId: string,
  observedAccountId: string,
): ReconciliationDecision<void> =>
  observedAccountId === expectedAccountId
    ? Result.succeed(undefined)
    : fail({ _tag: 'AccountBindingMismatch', source, identity, expectedAccountId, observedAccountId })

export const validateAccountBindings = (snapshot: ReconciliationSnapshot): ReconciliationDecision<void> =>
  pipe(
    Result.all([
      accountBinding('account', snapshot.account.accountId, snapshot.accountId, snapshot.account.accountId),
      accountBinding('valuation', snapshot.valuation.valuationId, snapshot.accountId, snapshot.valuation.accountId),
      ...snapshot.positions.map((position) =>
        accountBinding('position', position.symbol, snapshot.accountId, position.accountId),
      ),
      ...snapshot.orders.map((order) =>
        accountBinding('order', order.brokerOrderId, snapshot.accountId, order.accountId),
      ),
      ...snapshot.fills.map((fill) => accountBinding('fill', fill.fillId, snapshot.accountId, fill.accountId)),
    ]),
    Result.map(() => undefined),
  )

export interface ScalarComparison {
  readonly difference: bigint
  readonly discrepancies: readonly DiscrepancyInput[]
}

export const compareCash = (snapshot: ReconciliationSnapshot): ReconciliationDecision<ScalarComparison> =>
  pipe(
    Result.all({
      expected: integer('expected-cash', snapshot.accountId, snapshot.expectedCashMicros),
      observed: integer('account-cash', snapshot.accountId, snapshot.account.cashMicros),
    }),
    Result.flatMap(({ expected, observed }) =>
      pipe(
        compareValue(
          snapshot.accountId,
          DiscrepancyKind.Cash,
          snapshot.accountId,
          expected.toString(),
          observed.toString(),
        ),
        Result.map((discrepancies) => ({ difference: observed - expected, discrepancies })),
      ),
    ),
  )

export const compareEquity = (snapshot: ReconciliationSnapshot): ReconciliationDecision<ScalarComparison> =>
  pipe(
    Result.all({
      expected: integer('valuation-equity', snapshot.accountId, snapshot.valuation.equityMicros),
      observed: integer('account-equity', snapshot.accountId, snapshot.account.equityMicros),
    }),
    Result.flatMap(({ expected, observed }) =>
      pipe(
        compareValue(
          snapshot.accountId,
          DiscrepancyKind.Valuation,
          snapshot.accountId,
          expected.toString(),
          observed.toString(),
        ),
        Result.map((discrepancies) => ({ difference: observed - expected, discrepancies })),
      ),
    ),
  )

export const compareAccountStatus = (
  snapshot: ReconciliationSnapshot,
): ReconciliationDecision<readonly DiscrepancyInput[]> =>
  compareValue(
    snapshot.accountId,
    DiscrepancyKind.Account,
    snapshot.accountId,
    AccountStatus.Active,
    snapshot.account.status,
  )

export const compareLedger = (snapshot: ReconciliationSnapshot): ReconciliationDecision<readonly DiscrepancyInput[]> =>
  snapshot.ledgerExact
    ? Result.succeed([])
    : compareValue(
        snapshot.accountId,
        DiscrepancyKind.Accounting,
        `${snapshot.accountId}:ledger`,
        'EXACT',
        `MISMATCH:${snapshot.accountingHash}`,
      )

export interface TemporalMetrics {
  readonly brokerPollAgeMs: number
  readonly oldestUnknownMutationAgeMs: number
}

export const temporalMetrics = (snapshot: ReconciliationSnapshot): ReconciliationDecision<TemporalMetrics> =>
  pipe(
    Result.all({
      reconciledAt: instant('reconciledAt', snapshot.accountId, snapshot.reconciledAt),
      brokerTimes: Result.all([
        instant('account.observedAt', snapshot.account.accountId, snapshot.account.observedAt),
        instant('valuation.asOf', snapshot.valuation.valuationId, snapshot.valuation.asOf),
        ...snapshot.positions.map((position) => instant('position.observedAt', position.symbol, position.observedAt)),
        ...snapshot.orders.map((order) => instant('order.observedAt', order.brokerOrderId, order.observedAt)),
      ]),
      unknownTimes: Result.all(
        snapshot.intents.flatMap((intent) =>
          intent.unknownSince === undefined
            ? []
            : [instant('intent.unknownSince', intent.intentId, intent.unknownSince)],
        ),
      ),
    }),
    Result.map(({ brokerTimes, reconciledAt, unknownTimes }) => ({
      brokerPollAgeMs: Math.max(0, reconciledAt - (brokerTimes.length === 0 ? reconciledAt : Math.min(...brokerTimes))),
      oldestUnknownMutationAgeMs: unknownTimes.length === 0 ? 0 : Math.max(0, reconciledAt - Math.min(...unknownTimes)),
    })),
  )
