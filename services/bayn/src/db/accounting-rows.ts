import { Schema } from 'effect'

import type { AccountingTransaction } from '../accounting'
import { OrderSide, type AccountingReceipt } from '../paper'
import { Sha256Schema as Sha256, StrictNonEmptyStringSchema as NonEmptyString } from '../schemas'

export const AccountingTransactionRowSchema = Schema.Struct({
  schema_version: Schema.Literal('bayn.paper-accounting-transaction.v1'),
  transaction_id: Sha256,
  broker_event_id: Sha256,
  intent_id: Schema.NullOr(Sha256),
  account_id: NonEmptyString,
  symbol: Schema.String,
  side: Schema.Enum(OrderSide),
  quantity_micros: Schema.String,
  price_micros: Schema.String,
  notional_micros: Schema.String,
  fee_micros: Schema.String,
  cost_basis_micros: Schema.String,
  realized_pnl_micros: Schema.String,
  quantity_delta_micros: Schema.String,
  cost_basis_delta_micros: Schema.String,
  cash_delta_micros: Schema.String,
  ledger_plan_hash: Sha256,
  content_hash: Sha256,
  occurred_at: Schema.DateValid,
})

export const AccountingReceiptRowSchema = Schema.Struct({
  schema_version: Schema.Literal('bayn.paper-accounting-receipt.v1'),
  receipt_id: Sha256,
  intent_id: Schema.NullOr(Sha256),
  broker_event_id: Sha256,
  tigerbeetle_cluster_id: Schema.String,
  tigerbeetle_ledger: Schema.Int,
  account_ids: Schema.Array(Schema.String),
  transfer_ids: Schema.Array(Schema.String),
  debit_micros: Schema.String,
  credit_micros: Schema.String,
  content_hash: Sha256,
  recorded_at: Schema.DateValid,
})

export const accountingTransactionFromRow = (
  row: typeof AccountingTransactionRowSchema.Type,
): AccountingTransaction => ({
  schemaVersion: row.schema_version,
  transactionId: row.transaction_id,
  brokerEventId: row.broker_event_id,
  ...(row.intent_id === null ? {} : { intentId: row.intent_id }),
  accountId: row.account_id,
  symbol: row.symbol,
  side: row.side,
  quantityMicros: row.quantity_micros,
  priceMicros: row.price_micros,
  notionalMicros: row.notional_micros,
  feeMicros: row.fee_micros,
  costBasisMicros: row.cost_basis_micros,
  realizedPnlMicros: row.realized_pnl_micros,
  quantityDeltaMicros: row.quantity_delta_micros,
  costBasisDeltaMicros: row.cost_basis_delta_micros,
  cashDeltaMicros: row.cash_delta_micros,
  ledgerPlanHash: row.ledger_plan_hash,
  contentHash: row.content_hash,
  occurredAt: row.occurred_at.toISOString(),
})

export const accountingReceiptFromRow = (row: typeof AccountingReceiptRowSchema.Type): AccountingReceipt => ({
  schemaVersion: row.schema_version,
  receiptId: row.receipt_id,
  ...(row.intent_id === null ? {} : { intentId: row.intent_id }),
  brokerEventId: row.broker_event_id,
  tigerBeetleClusterId: row.tigerbeetle_cluster_id,
  tigerBeetleLedger: row.tigerbeetle_ledger,
  accountIds: row.account_ids,
  transferIds: row.transfer_ids,
  debitMicros: row.debit_micros,
  creditMicros: row.credit_micros,
  contentHash: row.content_hash,
  recordedAt: row.recorded_at.toISOString(),
})
