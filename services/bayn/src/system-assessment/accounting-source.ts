import { DateTime, Result } from 'effect'

import { rebuildAccountingLedger, verifyAccountingTransactionContent } from '../accounting/domain'
import { verifyCashSettlement, type StoredCashSettlement } from '../accounting/cash-settlement'
import type { AccountingTransaction } from '../accounting/schema'
import { planAccountingReceipt } from '../db/execution-store/decisions'
import type { AccountingReceipt } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import { verifyAccountingReceipts } from '../reconciliation/algebra'
import { SystemAssessmentError } from './economics'

export type RetainedAccountLedgerPrefix = {
  readonly accountId: string
  readonly asOf: string
  readonly retainedTransactions: readonly AccountingTransaction[]
  readonly durableTransactions: readonly AccountingTransaction[]
  readonly durableReceipts: readonly AccountingReceipt[]
  readonly retainedCashSettlements: readonly StoredCashSettlement[]
  readonly durableCashSettlements: readonly StoredCashSettlement[]
}

const mismatch = (cause?: unknown) =>
  Result.fail(
    new SystemAssessmentError({
      message: 'Native cash ledger witness differs from immutable accounting',
      ...(cause === undefined ? {} : { cause }),
    }),
  )

export const verifyRetainedAccountLedgerPrefix = (input: RetainedAccountLedgerPrefix) =>
  Result.gen(function* () {
    const retainedById = new Map(
      input.retainedTransactions.map((transaction) => [transaction.transactionId, transaction]),
    )
    const durableById = new Map(
      input.durableTransactions.map((transaction) => [transaction.transactionId, transaction]),
    )
    const receiptsByEvent = new Map(input.durableReceipts.map((receipt) => [receipt.brokerEventId, receipt]))
    const retainedSettlementsByTransaction = new Map(
      input.retainedCashSettlements.map((settlement) => [settlement.data.transactionId, settlement]),
    )
    const durableSettlementsByTransaction = new Map(
      input.durableCashSettlements.map((settlement) => [settlement.data.transactionId, settlement]),
    )
    if (
      retainedById.size !== input.retainedTransactions.length ||
      durableById.size !== input.durableTransactions.length ||
      receiptsByEvent.size !== input.durableReceipts.length ||
      retainedById.size !== durableById.size ||
      durableById.size !== receiptsByEvent.size ||
      retainedSettlementsByTransaction.size !== input.retainedCashSettlements.length ||
      durableSettlementsByTransaction.size !== input.durableCashSettlements.length ||
      retainedSettlementsByTransaction.size !== durableSettlementsByTransaction.size
    )
      return yield* mismatch()

    for (const retained of input.retainedTransactions) {
      const durable = durableById.get(retained.transactionId)
      const receipt = receiptsByEvent.get(retained.brokerEventId)
      if (
        durable === undefined ||
        receipt === undefined ||
        retained.accountId !== input.accountId ||
        durable.accountId !== input.accountId ||
        retained.brokerEventId !== durable.brokerEventId ||
        DateTime.toEpochMillis(DateTime.makeUnsafe(receipt.recordedAt)) >
          DateTime.toEpochMillis(DateTime.makeUnsafe(input.asOf)) ||
        Result.isFailure(verifyAccountingTransactionContent(retained)) ||
        Result.isFailure(verifyAccountingTransactionContent(durable)) ||
        (yield* canonicalHashV1Result(retained)) !== (yield* canonicalHashV1Result(durable))
      )
        return yield* mismatch()

      const ledger = rebuildAccountingLedger(retained, receipt.tigerBeetleLedger)
      if (Result.isFailure(ledger)) return yield* mismatch(ledger.failure)
      const plannedReceipt = planAccountingReceipt(
        { transaction: retained, ledger: ledger.success },
        receipt.tigerBeetleClusterId,
        receipt.tigerBeetleLedger,
      )
      if (Result.isFailure(plannedReceipt) || plannedReceipt.success.receiptId !== receipt.receiptId)
        return yield* mismatch(Result.isFailure(plannedReceipt) ? plannedReceipt.failure : undefined)
      const verified = verifyAccountingReceipts([{ transaction: retained, ledger: ledger.success }], [receipt], {
        tigerBeetle: {
          clusterId: BigInt(receipt.tigerBeetleClusterId),
          ledger: receipt.tigerBeetleLedger,
        },
      })
      if (Result.isFailure(verified) || verified.success.exactReceipts.get(retained.brokerEventId) !== true)
        return yield* mismatch(Result.isFailure(verified) ? verified.failure : undefined)
    }

    for (const retained of input.retainedCashSettlements) {
      const durable = durableSettlementsByTransaction.get(retained.data.transactionId)
      const transaction = durableById.get(retained.data.transactionId)
      if (
        durable === undefined ||
        transaction === undefined ||
        DateTime.toEpochMillis(DateTime.makeUnsafe(retained.data.observedAt)) >
          DateTime.toEpochMillis(DateTime.makeUnsafe(input.asOf)) ||
        (yield* canonicalHashV1Result(retained)) !== (yield* canonicalHashV1Result(durable)) ||
        transaction.accountId !== retained.data.accountId ||
        transaction.contentHash !== retained.data.transactionContentHash ||
        transaction.brokerEventId !== retained.data.brokerEventId ||
        transaction.cashDeltaMicros !== retained.data.cashDeltaMicros ||
        transaction.occurredAt !== retained.data.occurredAt
      )
        return yield* mismatch()
      const verified = verifyCashSettlement(retained, input.accountId, {
        clusterId: BigInt(retained.tigerbeetle_cluster_id),
        ledger: retained.tigerbeetle_ledger,
      })
      if (Result.isFailure(verified)) return yield* mismatch(verified.failure)
    }
  })
