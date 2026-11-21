import { DateTime, Result } from 'effect'

import { rebuildAccountingLedger, verifyAccountingTransactionContent } from '../accounting/domain'
import type { AccountingTransaction } from '../accounting/schema'
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
    if (
      retainedById.size !== input.retainedTransactions.length ||
      durableById.size !== input.durableTransactions.length ||
      receiptsByEvent.size !== input.durableReceipts.length ||
      retainedById.size !== durableById.size ||
      durableById.size !== receiptsByEvent.size
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
      const verified = verifyAccountingReceipts([{ transaction: retained, ledger: ledger.success }], [receipt], {
        tigerBeetle: {
          clusterId: BigInt(receipt.tigerBeetleClusterId),
          ledger: receipt.tigerBeetleLedger,
        },
      })
      if (Result.isFailure(verified) || verified.success.exactReceipts.get(retained.brokerEventId) !== true)
        return yield* mismatch(Result.isFailure(verified) ? verified.failure : undefined)
    }
  })
