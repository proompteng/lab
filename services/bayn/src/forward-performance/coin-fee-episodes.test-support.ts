import assert from 'node:assert/strict'
import { Result } from 'effect'
import { coinFeeLedgerPlan, prepareAccounting } from '../accounting/domain'
import type { StoredBrokerFee } from '../accounting/broker-fees'
import { prepareFeeAccrual } from '../accounting/fee-accrual'
import { OrderSide } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import { hashLedgerPlanResult } from '../ledger-plan'

// Synthetic fractional fills and observed debit; these are not account or profitability evidence.
export const coinRoundTrip = (
  offset = 0,
  accountId = 'episode-account',
  cycleId = 'f'.repeat(64),
  dates: {
    readonly sourceDate?: StoredBrokerFee['data']['date']
    readonly observedDate?: StoredBrokerFee['data']['date']
  } = {},
) => {
  const sourceDate = dates.sourceDate ?? '2026-09-18'
  const observedDate = dates.observedDate ?? sourceDate
  const accounting = [
    { index: 1, side: OrderSide.Buy, quantityAtoms: '33050000' },
    { index: 3, side: OrderSide.Sell, quantityAtoms: '32967375' },
  ]
    .map((fill) => ({ ...fill, index: fill.index + offset }))
    .map(({ index, side, quantityAtoms }) =>
      Result.getOrThrow(
        prepareAccounting(
          Result.getOrThrow(canonicalHashV1Result({ syntheticCoinFill: index })),
          {
            schemaVersion: 'bayn.fill.v2',
            accountId,
            intentId: Result.getOrThrow(canonicalHashV1Result({ syntheticCoinIntent: index, accountId, cycleId })),
            fillId: `synthetic-coin-fill-${index}`,
            brokerOrderId: `synthetic-coin-order-${index}`,
            clientOrderId: `synthetic-coin-client-${index}`,
            symbol: 'ETH/USD',
            side,
            quantityAtoms,
            priceAtoms: '100000000000',
            feeMicros: '0',
            occurredAt: `${side === OrderSide.Buy ? sourceDate : observedDate}T15:30:${String(index).padStart(2, '0')}.000Z`,
          },
          side === OrderSide.Buy
            ? { quantityAtoms: '0', costMicros: '0' }
            : { quantityAtoms: '32967375', costMicros: '3296738' },
          7_001,
        ),
      ),
    )
  const fills = accounting.map((prepared) => prepared.transaction)
  const buy = fills[0]
  assert(buy !== undefined)
  const prepared = Result.getOrThrow(
    prepareFeeAccrual(
      {
        schemaVersion: 'bayn.broker-fee-accrual.v1',
        kind: 'COIN',
        accountId: buy.accountId,
        symbol: buy.symbol,
        date: observedDate,
        cycleId,
        positionSnapshotId: 'a'.repeat(64),
        observedAt: `${observedDate}T15:30:${String(2 + offset).padStart(2, '0')}.000Z`,
        projectedQuantityAtoms: buy.quantityAtoms,
        observedQuantityAtoms: '32967375',
        projectedCostMicros: '3305000',
        observedCostMicros: '3296738',
        sourceTrades: [
          { transactionId: buy.transactionId, quantityAtoms: buy.quantityAtoms, priceAtoms: buy.priceAtoms },
        ],
      },
      7_001,
    ),
  )
  const accrual = {
    accrual_id: prepared.accrualId,
    data: prepared.data,
    settlement_date: sourceDate,
    content_hash: prepared.contentHash,
    coin_quantity_atoms: prepared.coinQuantityAtoms,
    cash_debit_micros: prepared.cashDebitMicros,
    expense_micros: prepared.expenseMicros,
    matched_coin_quantity_atoms: '0',
    matched_cash_micros: '0',
    ledger_plan_hash: Result.getOrThrow(hashLedgerPlanResult(prepared.plan)),
    tigerbeetle_cluster_id: '2001',
    tigerbeetle_ledger: 7_001,
    posted: true,
  }
  return { fills, accrual, accounting }
}

export const coinActivity = (quantityAtoms = '82625', accountId = 'episode-account'): StoredBrokerFee => {
  const data: StoredBrokerFee['data'] = {
    accountId,
    activityId: 'synthetic-coin-fee',
    date: '2026-09-18',
    netAmountMicros: '0',
    coinDebit: { symbol: 'ETH/USD', quantityAtoms, priceAtoms: '100000000000' },
  }
  return {
    data,
    cash_match_corrections: [],
    matched_cash_micros: '0',
    coin_cost_basis_micros: '0',
    read_evidence: {
      requestId: 'synthetic-fee-read',
      status: 200,
      contentHash: 'a'.repeat(64),
      observedAt: '2026-09-18T16:00:00.000Z',
    },
    content_hash: Result.getOrThrow(canonicalHashV1Result({ schemaVersion: 'bayn.broker-fee.v1', ...data })),
    ledger_plan_hash: Result.getOrThrow(
      hashLedgerPlanResult(coinFeeLedgerPlan(data.accountId, data.activityId, 'ETH/USD', '0', 7_001)),
    ),
    tigerbeetle_cluster_id: '2001',
    tigerbeetle_ledger: 7_001,
    posted: true,
  }
}
