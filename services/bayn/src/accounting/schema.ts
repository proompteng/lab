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

export const equityShortAccountingSchemaVersion = 'bayn.equity-short-accounting-transaction.v1' as const

export const AccountingTransactionSchema = Schema.Struct({
  schemaVersion: Schema.Literals([legacyAccountingTransactionSchemaVersion, equityShortAccountingSchemaVersion]),
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
}).check(
  Schema.makeFilter((transaction) => {
    if (transaction.schemaVersion !== equityShortAccountingSchemaVersion) return []
    const quantity = BigInt(transaction.quantityAtoms)
    const notional = BigInt(transaction.notionalMicros)
    const basis = BigInt(transaction.costBasisMicros)
    const fee = BigInt(transaction.feeMicros)
    const opening = transaction.side === OrderSide.Sell
    const valid =
      !transaction.symbol.includes('/') &&
      BigInt(transaction.quantityDeltaAtoms) === (opening ? -quantity : quantity) &&
      BigInt(transaction.costBasisDeltaMicros) === (opening ? -basis : basis) &&
      BigInt(transaction.cashDeltaMicros) === (opening ? notional - fee : -(notional + fee)) &&
      BigInt(transaction.realizedPnlMicros) === (opening ? 0n : basis - notional) &&
      (!opening || basis === notional)
    return valid ? [] : [{ path: [], issue: 'equity short inventory, proceeds and cover accounting must agree' }]
  }),
)

export type AccountingTransaction = typeof AccountingTransactionSchema.Type

export const decodeAccountingTransaction = Schema.decodeUnknownResult(AccountingTransactionSchema, strictParseOptions)
