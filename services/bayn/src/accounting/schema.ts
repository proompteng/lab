import { Schema } from 'effect'

import {
  OrderSide,
  PositiveMicrosSchema as PositiveMicros,
  SignedMicrosSchema as SignedMicros,
  UnsignedMicrosSchema as UnsignedMicros,
} from '../execution/contracts'
import {
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  SymbolSchema as SymbolName,
  UtcInstantSchema as UtcInstant,
  strictParseOptions,
} from '../schemas'
import { Pipeable } from '../pipeable'

export const AccountingTransactionSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-accounting-transaction.v1'),
  transactionId: Sha256,
  brokerEventId: Sha256,
  intentId: Schema.optionalKey(Sha256),
  accountId: NonEmptyString,
  symbol: SymbolName,
  side: Schema.Enum(OrderSide),
  quantityMicros: PositiveMicros,
  priceMicros: PositiveMicros,
  notionalMicros: PositiveMicros,
  feeMicros: UnsignedMicros,
  costBasisMicros: UnsignedMicros,
  realizedPnlMicros: SignedMicros,
  quantityDeltaMicros: SignedMicros,
  costBasisDeltaMicros: SignedMicros,
  cashDeltaMicros: SignedMicros,
  ledgerPlanHash: Sha256,
  contentHash: Sha256,
  occurredAt: UtcInstant,
})

export type AccountingTransaction = typeof AccountingTransactionSchema.Type

const decodeAccountingTransactionDataFirst = Schema.decodeUnknownResult(AccountingTransactionSchema, strictParseOptions)

export const decodeAccountingTransaction = Pipeable.dual(1, (input: unknown) =>
  decodeAccountingTransactionDataFirst(input),
)
