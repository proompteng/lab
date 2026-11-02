import type { AccountingTransaction } from '../accounting/schema'
import type { StoredCashSettlement } from '../accounting/cash-settlement'

/** Every supported broker quantum divides one cent. Exact-cent movements need no rounding receipt. */
export const cashSettlementMatches = (
  trade: AccountingTransaction,
  settlement: StoredCashSettlement | undefined,
  accountId: string,
  asOf: string,
) => {
  if (trade.accountId !== accountId || trade.occurredAt > asOf) return false
  if (settlement === undefined) return BigInt(trade.cashDeltaMicros) % 10_000n === 0n
  return (
    settlement.posted &&
    settlement.data.accountId === accountId &&
    settlement.data.transactionId === trade.transactionId &&
    settlement.data.transactionContentHash === trade.contentHash &&
    settlement.data.brokerEventId === trade.brokerEventId &&
    settlement.data.occurredAt === trade.occurredAt &&
    settlement.data.observedAt <= asOf &&
    settlement.data.cashDeltaMicros === trade.cashDeltaMicros
  )
}
