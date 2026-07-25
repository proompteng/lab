import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import { prepareAccounting } from '../accounting'
import { MutationOperation } from '../broker/alpaca-mutations'
import { MutationEventType } from '../execution/mutations'
import { canonicalHashV1 } from '../hash'
import {
  AccountStatus,
  Authority,
  IntentState,
  KillState,
  OrderSide,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  TerminalOutcome,
  TimeInForce,
  type AccountSnapshot,
  type AccountingReceipt,
  type Fill,
  type Order,
  type Position,
} from '../paper'
import {
  canonicalAccountingReceiptMaterial,
  compareOpeningCash,
  decideReconciliation,
  projectIntentExpectations,
  reconciliationAlgebraFailureDetails,
  riskContextFromRow,
  validateReconciliationReadback,
  verifyAccountingReceipts,
  type ReconciliationAlgebraFailure,
  type RiskContextRow,
} from './reconciliation-algebra'

const successOf = <A>(result: Result.Result<A, ReconciliationAlgebraFailure>): A => {
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) throw new Error(`expected success, received ${result.failure._tag}`)
  return result.success
}

const failureOf = <A>(result: Result.Result<A, ReconciliationAlgebraFailure>): ReconciliationAlgebraFailure => {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isSuccess(result)) throw new Error('expected failure')
  return result.failure
}

const hash = (value: string): string => canonicalHashV1({ value })
const accountId = 'paper-account'
const openingObservedAt = '2026-07-22T15:29:59.000Z'
const observedAt = '2026-07-22T15:30:00.000Z'
const reconciledAt = '2026-07-22T15:30:01.000Z'
const tigerBeetle = { clusterId: 1n, ledger: 1 }

const fill: Fill = {
  schemaVersion: 'bayn.paper-fill.v1',
  accountId,
  fillId: 'fill-1',
  brokerOrderId: 'broker-order-1',
  clientOrderId: 'bayn-order-1',
  intentId: hash('intent-1'),
  symbol: 'NVDA',
  side: OrderSide.Buy,
  quantityMicros: '1000000',
  priceMicros: '100000000',
  feeMicros: '0',
  occurredAt: observedAt,
}

const preparedResult = prepareAccounting(hash('broker-event-1'), fill, { quantityMicros: '0', costMicros: '0' }, 1)
if (Result.isFailure(preparedResult)) throw new Error('test setup: prepareAccounting failed')
const prepared = preparedResult.success
const postedMicros = prepared.ledger.transfers.reduce((sum, transfer) => sum + transfer.amount, 0n).toString()
const receiptMaterial = {
  schemaVersion: 'bayn.paper-accounting-receipt.v1' as const,
  intentId: fill.intentId,
  brokerEventId: prepared.transaction.brokerEventId,
  tigerBeetleClusterId: tigerBeetle.clusterId.toString(),
  tigerBeetleLedger: tigerBeetle.ledger,
  accountIds: prepared.ledger.accounts.map((account) => account.id.toString()),
  transferIds: prepared.ledger.transfers.map((transfer) => transfer.id.toString()),
  debitMicros: postedMicros,
  creditMicros: postedMicros,
}
const receipt: AccountingReceipt = {
  ...receiptMaterial,
  receiptId: hash('receipt-1'),
  contentHash: canonicalHashV1(receiptMaterial),
  recordedAt: observedAt,
}

const account: AccountSnapshot = {
  schemaVersion: 'bayn.paper-account-snapshot.v1',
  accountId,
  status: AccountStatus.Active,
  currency: 'USD',
  cashMicros: '900000000',
  equityMicros: '1000000000',
  buyingPowerMicros: '900000000',
  observedAt,
}

const position: Position = {
  schemaVersion: 'bayn.paper-position.v1',
  accountId,
  symbol: fill.symbol,
  quantityMicros: fill.quantityMicros,
  averageEntryPriceMicros: fill.priceMicros,
  marketPriceMicros: fill.priceMicros,
  marketValueMicros: fill.priceMicros,
  unrealizedPnlMicros: '0',
  observedAt,
}

const order: Order = {
  schemaVersion: 'bayn.paper-order.v1',
  accountId,
  brokerOrderId: fill.brokerOrderId,
  clientOrderId: fill.clientOrderId,
  intentId: fill.intentId,
  symbol: fill.symbol,
  side: fill.side,
  orderType: OrderType.Market,
  timeInForce: TimeInForce.Day,
  quantityMicros: fill.quantityMicros,
  filledQuantityMicros: fill.quantityMicros,
  status: OrderStatus.Filled,
  observedAt,
}

const intentRow = {
  intent_id: fill.intentId ?? hash('missing-intent'),
  client_order_id: fill.clientOrderId,
  symbol: fill.symbol,
  side: fill.side,
  order_type: order.orderType,
  time_in_force: order.timeInForce,
  quantity_micros: fill.quantityMicros,
  state: IntentState.Terminal,
  terminal_outcome: TerminalOutcome.Filled,
  broker_order_id: fill.brokerOrderId,
  mutation_operation: MutationOperation.Submit,
  mutation_event_type: MutationEventType.SubmitAccepted,
  mutation_occurred_at: observedAt,
} as const

const makeComparison = (status: AccountStatus = AccountStatus.Active) => {
  const intentProjection = successOf(projectIntentExpectations([intentRow]))
  const accounting = successOf(verifyAccountingReceipts([prepared.transaction], [receipt], { tigerBeetle }))
  const durableFills = [
    {
      fillId: fill.fillId,
      brokerOrderId: fill.brokerOrderId,
      accounted: accounting.exactReceipts.get(prepared.transaction.brokerEventId) === true,
    },
  ]
  const projectedPositions = [
    {
      symbol: position.symbol,
      quantityMicros: position.quantityMicros,
      costBasisMicros: prepared.transaction.costBasisMicros,
    },
  ]
  return successOf(
    compareOpeningCash({
      accountId,
      openingCash: { cash_micros: '1000000000', observed_at: openingObservedAt },
      transactions: [prepared.transaction],
      receipts: [receipt],
      ledgerExact: true,
      snapshot: {
        account: { ...account, status },
        positions: [position],
        positionsObservedAt: observedAt,
        orders: [order],
        ordersObservedAt: observedAt,
        fills: [fill],
        valuation: {
          schemaVersion: 'bayn.paper-valuation.v1',
          valuationId: hash('valuation-1'),
          accountId,
          sourceHash: hash('valuation-source'),
          cashMicros: account.cashMicros,
          longMarketValueMicros: position.marketValueMicros,
          shortMarketValueMicros: '0',
          equityMicros: account.equityMicros,
          asOf: observedAt,
        },
        reconciledAt,
      },
      intents: intentProjection.intents,
      durableFills,
      projectedPositions,
    }),
  )
}

const emptyRiskRow = (): RiskContextRow => ({
  trading_date: '2026-07-22',
  authority_schema_version: null,
  authority_generation_hash: null,
  authority_maximum: null,
  authority_effective: null,
  authority_kill: null,
  authority_reason: null,
  authority_version: null,
  authority_updated_at: null,
  authority_observed_at: null,
  daily_traded_notional_micros: '0',
  day_start_equity_micros: '1000000000',
  peak_equity_micros: '1000000000',
})

describe('PostgreSQL reconciliation algebra', () => {
  test('projects intent uncertainty without Effects', () => {
    const projection = successOf(
      projectIntentExpectations([
        {
          ...intentRow,
          state: IntentState.Acknowledged,
          terminal_outcome: null,
          mutation_operation: MutationOperation.Cancel,
          mutation_event_type: MutationEventType.RecoveryFound,
        },
        intentRow,
      ]),
    )

    expect(projection.unknownMutationCount).toBe(1)
    expect(projection.intents[0]).toMatchObject({ intentId: fill.intentId, unknownSince: observedAt })
    expect(projection.intents[1]?.unknownSince).toBeUndefined()
  })

  test('verifies ledger plans, receipt material, and exact accounting bindings', () => {
    const verification = successOf(verifyAccountingReceipts([prepared.transaction], [receipt], { tigerBeetle }))

    expect(verification.plans).toEqual([prepared.ledger])
    expect(verification.exactReceipts.get(prepared.transaction.brokerEventId)).toBe(true)
    expect(canonicalAccountingReceiptMaterial(receipt)).toEqual(receiptMaterial)
    expect(canonicalHashV1(canonicalAccountingReceiptMaterial(receipt))).toBe(receipt.contentHash)

    const inexact = successOf(
      verifyAccountingReceipts([prepared.transaction], [{ ...receipt, contentHash: hash('wrong-receipt-content') }], {
        tigerBeetle,
      }),
    )
    expect(inexact.exactReceipts.get(prepared.transaction.brokerEventId)).toBe(false)
  })

  test('rejects duplicate receipt broker events before ledger planning', () => {
    const conflictingReceipt: AccountingReceipt = {
      ...receipt,
      receiptId: hash('duplicate-receipt'),
      contentHash: hash('conflicting-receipt-content'),
    }
    const duplicateReceipts = [conflictingReceipt, receipt]
    const failure = failureOf(verifyAccountingReceipts([prepared.transaction], duplicateReceipts, { tigerBeetle }))

    expect(failure).toEqual({
      _tag: 'DuplicateReceiptBrokerEvent',
      brokerEventId: prepared.transaction.brokerEventId,
    })
    expect(
      failureOf(
        verifyAccountingReceipts(
          [{ ...prepared.transaction, contentHash: hash('invalid-transaction-content') }],
          duplicateReceipts,
          { tigerBeetle },
        ),
      ),
    ).toEqual(failure)
    expect(reconciliationAlgebraFailureDetails(failure)).toEqual({
      failure: 'invariant',
      message: `duplicate accounting receipt broker event ${prepared.transaction.brokerEventId}`,
      cause: failure,
    })
  })

  test('returns closed ledger-plan failures with their causes', () => {
    const failure = failureOf(
      verifyAccountingReceipts(
        [{ ...prepared.transaction, contentHash: hash('invalid-transaction-content') }],
        [receipt],
        { tigerBeetle },
      ),
    )
    expect(failure).toMatchObject({
      _tag: 'AccountingPlanFailed',
      transactionId: prepared.transaction.transactionId,
      brokerEventId: prepared.transaction.brokerEventId,
      cause: expect.any(Error),
    })
    if (failure._tag !== 'AccountingPlanFailed') throw new Error('expected accounting plan failure')
    const details = reconciliationAlgebraFailureDetails(failure)
    expect(details).toMatchObject({
      failure: 'invariant',
      message: `accounting ledger plan verification failed for transaction ${prepared.transaction.transactionId}`,
    })
    expect(details.cause).toBe(failure.cause)
  })

  test('compares opening cash and produces the unchanged exact accounting identity', () => {
    const result = makeComparison()

    expect(result.accountingHash).toBe(
      canonicalHashV1({
        schemaVersion: 'bayn.paper-accounting-state.v1',
        accountId,
        openingCash: { cash_micros: '1000000000', observed_at: openingObservedAt },
        transactions: [prepared.transaction],
        receipts: [receipt],
        ledgerExact: true,
      }),
    )
    expect(result.comparison.discrepancies).toEqual([])
    expect(result.comparison.metrics).toMatchObject({
      accountingExact: true,
      cashDifferenceMicros: '0',
      positionDifferenceMicros: '0',
      equityDifferenceMicros: '0',
    })
  })

  test('rejects accounting before the opening snapshot and contains comparison throws', () => {
    const exact = makeComparison()
    const predates = failureOf(
      compareOpeningCash({
        accountId,
        openingCash: { cash_micros: '1000000000', observed_at: '2026-07-22T15:30:00.001Z' },
        transactions: [prepared.transaction],
        receipts: [receipt],
        ledgerExact: true,
        snapshot: {
          account,
          positions: [position],
          positionsObservedAt: observedAt,
          orders: [order],
          ordersObservedAt: observedAt,
          fills: [fill],
          valuation: {
            schemaVersion: 'bayn.paper-valuation.v1',
            valuationId: hash('valuation-2'),
            accountId,
            sourceHash: hash('valuation-source-2'),
            cashMicros: account.cashMicros,
            longMarketValueMicros: position.marketValueMicros,
            shortMarketValueMicros: '0',
            equityMicros: account.equityMicros,
            asOf: observedAt,
          },
          reconciledAt,
        },
        intents: [],
        durableFills: [],
        projectedPositions: [],
      }),
    )
    expect(predates).toMatchObject({
      _tag: 'AccountingPredatesOpeningCash',
      transactionId: prepared.transaction.transactionId,
    })

    const duplicateComparison = failureOf(
      compareOpeningCash({
        accountId,
        openingCash: { cash_micros: '1000000000', observed_at: openingObservedAt },
        transactions: [],
        receipts: [],
        ledgerExact: true,
        snapshot: {
          account,
          positions: [],
          positionsObservedAt: observedAt,
          orders: [order, order],
          ordersObservedAt: observedAt,
          fills: [],
          valuation: {
            schemaVersion: 'bayn.paper-valuation.v1',
            valuationId: hash('valuation-3'),
            accountId,
            sourceHash: hash('valuation-source-3'),
            cashMicros: account.cashMicros,
            longMarketValueMicros: '0',
            shortMarketValueMicros: '0',
            equityMicros: account.cashMicros,
            asOf: observedAt,
          },
          reconciledAt,
        },
        intents: [],
        durableFills: [],
        projectedPositions: [],
      }),
    )
    expect(duplicateComparison).toMatchObject({
      _tag: 'AccountingProjectionFailed',
      operation: 'reconciliation-comparison',
      cause: expect.any(Error),
    })
    expect(exact.comparison.discrepancies).toEqual([])
  })

  test('ages discrepancies, builds deterministic identities, and validates readback', () => {
    const mismatch = makeComparison(AccountStatus.Restricted)
    const first = successOf(
      decideReconciliation({
        accountId,
        comparison: mismatch.comparison,
        previous: [],
        reconciledAt,
      }),
    )
    const nextObservedAt = '2026-07-22T15:30:02.000Z'
    const ongoing = successOf(
      decideReconciliation({
        accountId,
        comparison: mismatch.comparison,
        previous: first.discrepancies,
        reconciledAt: nextObservedAt,
      }),
    )
    const firstDiscrepancy = first.discrepancies[0]
    if (firstDiscrepancy === undefined) throw new Error('expected one reconciliation discrepancy')

    expect(first.status).toBe(ReconciliationStatus.Discrepancy)
    expect(first.discrepancies[0]).toMatchObject({
      firstObservedAt: reconciledAt,
      lastObservedAt: reconciledAt,
    })
    expect(ongoing.discrepancies[0]).toMatchObject({
      discrepancyId: firstDiscrepancy.discrepancyId,
      firstObservedAt: reconciledAt,
      lastObservedAt: nextObservedAt,
    })
    expect(successOf(validateReconciliationReadback(first, first.contentHash))).toBeUndefined()
    expect(failureOf(validateReconciliationReadback(first, hash('wrong-readback')))).toMatchObject({
      _tag: 'StoredReconciliationMismatch',
      reconciliationId: first.reconciliationId,
      expectedContentHash: first.contentHash,
    })
    expect(
      failureOf(
        decideReconciliation({
          accountId,
          comparison: mismatch.comparison,
          previous: [firstDiscrepancy, firstDiscrepancy],
          reconciledAt: nextObservedAt,
        }),
      ),
    ).toMatchObject({
      _tag: 'DuplicateReconciliationDiscrepancy',
      source: 'previous',
      discrepancyId: firstDiscrepancy.discrepancyId,
    })
    expect(
      failureOf(
        decideReconciliation({
          accountId,
          comparison: {
            ...mismatch.comparison,
            discrepancies: [firstDiscrepancy, firstDiscrepancy],
          },
          previous: [],
          reconciledAt: nextObservedAt,
        }),
      ),
    ).toMatchObject({
      _tag: 'DuplicateReconciliationDiscrepancy',
      source: 'current',
      discrepancyId: firstDiscrepancy.discrepancyId,
    })
  })

  test('validates absent and complete authority risk context without Effects', () => {
    expect(successOf(riskContextFromRow(emptyRiskRow(), 2))).toEqual({
      tradingDate: '2026-07-22',
      authority: null,
      authorityObservedAt: null,
      unknownMutationCount: 2,
      dailyTradedNotionalMicros: '0',
      dayStartEquityMicros: '1000000000',
      peakEquityMicros: '1000000000',
    })

    const updatedAt = new Date('2026-07-22T15:30:01.000Z')
    const observedAuthorityAt = new Date('2026-07-22T15:30:02.000Z')
    const authority = successOf(
      riskContextFromRow(
        {
          ...emptyRiskRow(),
          authority_schema_version: 'bayn.paper-authority.v1',
          authority_generation_hash: hash('authority-generation'),
          authority_maximum: Authority.Observe,
          authority_effective: Authority.Observe,
          authority_kill: KillState.Clear,
          authority_version: '1',
          authority_updated_at: updatedAt,
          authority_observed_at: observedAuthorityAt,
        },
        0,
      ),
    )
    expect(authority).toMatchObject({
      authority: {
        generationHash: hash('authority-generation'),
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Clear,
        version: 1,
        updatedAt: updatedAt.toISOString(),
      },
      authorityObservedAt: observedAuthorityAt.toISOString(),
    })
  })

  test('returns closed risk-row, authority-decode, and timestamp failures', () => {
    expect(
      failureOf(
        riskContextFromRow(
          {
            ...emptyRiskRow(),
            authority_reason: 'orphaned reason',
          },
          0,
        ),
      ),
    ).toMatchObject({
      _tag: 'InvalidRiskContext',
      reason: 'authority-evidence-without-state',
    })
    expect(
      failureOf(
        riskContextFromRow(
          {
            ...emptyRiskRow(),
            authority_schema_version: 'bayn.paper-authority.v1',
          },
          0,
        ),
      ),
    ).toMatchObject({
      _tag: 'InvalidRiskContext',
      reason: 'authority-state-incomplete',
      details: {
        missingFields: expect.arrayContaining(['authority_generation_hash', 'authority_observed_at']),
      },
    })

    const invalidAuthority = failureOf(
      riskContextFromRow(
        {
          ...emptyRiskRow(),
          authority_schema_version: 'bayn.paper-authority.v1',
          authority_generation_hash: hash('invalid-authority-generation'),
          authority_maximum: Authority.Observe,
          authority_effective: Authority.Paper,
          authority_kill: KillState.Clear,
          authority_version: '1',
          authority_updated_at: new Date('2026-07-22T15:30:01.000Z'),
          authority_observed_at: new Date('2026-07-22T15:30:02.000Z'),
        },
        0,
      ),
    )
    expect(invalidAuthority).toMatchObject({
      _tag: 'AuthorityStateDecodeFailed',
      cause: expect.anything(),
    })
    if (invalidAuthority._tag !== 'AuthorityStateDecodeFailed') {
      throw new Error('expected authority-state decode failure')
    }
    const decodeDetails = reconciliationAlgebraFailureDetails(invalidAuthority)
    expect(decodeDetails.failure).toBe('decode')
    expect(decodeDetails.cause).toBe(invalidAuthority.cause)

    const invalidTimestamp = failureOf(
      riskContextFromRow(
        {
          ...emptyRiskRow(),
          authority_schema_version: 'bayn.paper-authority.v1',
          authority_generation_hash: hash('invalid-date-authority-generation'),
          authority_maximum: Authority.Observe,
          authority_effective: Authority.Observe,
          authority_kill: KillState.Clear,
          authority_version: '1',
          authority_updated_at: new Date(Number.NaN),
          authority_observed_at: new Date('2026-07-22T15:30:02.000Z'),
        },
        0,
      ),
    )
    expect(invalidTimestamp).toMatchObject({
      _tag: 'RiskContextTimestampFailed',
      field: 'authority_updated_at',
      cause: expect.any(RangeError),
    })
  })
})
