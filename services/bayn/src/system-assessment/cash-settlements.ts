import { Schema } from 'effect'
import type { AccountingTransaction } from '../accounting/schema'
import type { StoredCashSettlement } from '../accounting/cash-settlement'
import {
  IsoDateSchema,
  NonNegativeIntegerSchema,
  Sha256Schema,
  SignedMicrosSchema,
  StrictNonEmptyStringSchema,
  UtcDatabaseInstantSchema,
} from '../schemas'

export const FeeSettlementAnchorsSchema = Schema.Array(
  Schema.Struct({
    sessionDate: IsoDateSchema,
    phase: Schema.Literals(['OPENING', 'RECOVERY', 'RECONCILED']),
    cutAt: Schema.NullOr(UtcDatabaseInstantSchema),
    observation: Schema.NullOr(
      Schema.Struct({
        sourceHash: Sha256Schema,
        at: UtcDatabaseInstantSchema,
        availableAt: UtcDatabaseInstantSchema,
        cashMicros: SignedMicrosSchema,
        positions: Schema.NullOr(
          Schema.Struct({ sourceHash: Sha256Schema, at: UtcDatabaseInstantSchema, count: NonNegativeIntegerSchema }),
        ),
      }),
    ),
    reconciliationHash: Schema.NullOr(Sha256Schema),
    fees: Schema.Array(
      Schema.Struct({
        activityId: StrictNonEmptyStringSchema,
        sourceHash: Sha256Schema,
        postedAt: Schema.NullOr(UtcDatabaseInstantSchema),
        availableAt: UtcDatabaseInstantSchema,
      }),
    ),
  }),
)

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
