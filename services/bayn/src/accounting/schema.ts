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

import { legacyAccountingTransactionSchemaVersion } from '../execution/legacy-wire'

export const AccountingTransactionSchema = Schema.Struct({
  schemaVersion: Schema.Literal(legacyAccountingTransactionSchemaVersion),
  transactionId: Sha256,
  brokerEventId: Sha256,
  intentId: Schema.optionalKey(Sha256),
  accountId: NonEmptyString,
  symbol: SymbolName,
  side: Schema.Enum(OrderSide),
  quantityAtoms: PositiveMicros,
  priceAtoms: PositiveMicros,
  notionalMicros: PositiveMicros,
  feeMicros: UnsignedMicros,
  costBasisMicros: UnsignedMicros,
  realizedPnlMicros: SignedMicros,
  quantityDeltaAtoms: SignedMicros,
  costBasisDeltaMicros: SignedMicros,
  cashDeltaMicros: SignedMicros,
  ledgerPlanHash: Sha256,
  contentHash: Sha256,
  occurredAt: UtcInstant,
})

export type AccountingTransaction = typeof AccountingTransactionSchema.Type

export const decodeAccountingTransaction = Schema.decodeUnknownResult(AccountingTransactionSchema, strictParseOptions)
