import { AccountFlags, type Account, type Transfer } from 'tigerbeetle-node'
import { Schema } from 'effect'

import { canonicalHashV1, stableU128, stableU64 } from './hash'
import { AccountCode, hashLedgerPlan, LEDGER_SCHEMA_VERSION, TransferCode, type LedgerPlan } from './ledger-plan'
import {
  OrderSide,
  type Fill,
  PositiveMicrosSchema as PositiveMicros,
  SignedMicrosSchema as SignedMicros,
  UnsignedMicrosSchema as UnsignedMicros,
} from './paper'
import {
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  SymbolSchema as SymbolName,
  UtcInstantSchema as UtcInstant,
  strictParseOptions,
} from './schemas'

const MICROS = 1_000_000n
type AccountCodeValue = (typeof AccountCode)[keyof typeof AccountCode]
type TransferCodeValue = (typeof TransferCode)[keyof typeof TransferCode]

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

export interface PositionCost {
  readonly quantityMicros: string
  readonly costMicros: string
}

export interface PreparedAccounting {
  readonly transaction: AccountingTransaction
  readonly ledger: LedgerPlan
}

const decodeTransaction = Schema.decodeUnknownSync(AccountingTransactionSchema, strictParseOptions)

const roundDiv = (numerator: bigint, denominator: bigint): bigint => {
  if (numerator < 0n || denominator <= 0n) {
    throw new Error('fixed-point division requires a non-negative numerator and positive denominator')
  }
  return (numerator + denominator / 2n) / denominator
}

const makeAccount = (brokerAccountId: string, ledger: number, name: string, code: AccountCodeValue): Account => {
  const owner = stableU128('bayn-paper-account-v1', brokerAccountId)
  return {
    id: stableU128('bayn-paper-ledger-account-v1', brokerAccountId, name),
    debits_pending: 0n,
    debits_posted: 0n,
    credits_pending: 0n,
    credits_posted: 0n,
    user_data_128: owner,
    user_data_64: stableU64('bayn-paper-account-v1', brokerAccountId),
    user_data_32: LEDGER_SCHEMA_VERSION,
    reserved: 0,
    ledger,
    code,
    flags: AccountFlags.history,
    timestamp: 0n,
  }
}

const makeTransfer = (
  transactionId: string,
  brokerEventId: string,
  brokerAccountId: string,
  ledger: number,
  leg: string,
  debitAccountId: bigint,
  creditAccountId: bigint,
  amount: bigint,
  code: TransferCodeValue,
): Transfer => ({
  id: stableU128('bayn-paper-transfer-v1', brokerEventId, leg),
  debit_account_id: debitAccountId,
  credit_account_id: creditAccountId,
  amount,
  pending_id: 0n,
  user_data_128: stableU128('bayn-paper-transaction-v1', transactionId),
  user_data_64: stableU64('bayn-paper-account-v1', brokerAccountId),
  user_data_32: LEDGER_SCHEMA_VERSION,
  timeout: 0,
  ledger,
  code,
  flags: 0,
  timestamp: 0n,
})

interface Amounts {
  readonly notional: bigint
  readonly costBasis: bigint
  readonly realizedPnl: bigint
  readonly quantityDelta: bigint
  readonly costBasisDelta: bigint
  readonly cashDelta: bigint
}

type LedgerFill = Pick<Fill, 'accountId' | 'symbol' | 'side' | 'feeMicros'>

const calculateAmounts = (fill: Fill, prior: PositionCost): Amounts => {
  const quantity = BigInt(fill.quantityMicros)
  const price = BigInt(fill.priceMicros)
  const fee = BigInt(fill.feeMicros)
  const priorQuantity = BigInt(prior.quantityMicros)
  const priorCost = BigInt(prior.costMicros)
  if (priorQuantity < 0n || priorCost < 0n) throw new Error('position cost state must not be negative')
  if (priorQuantity === 0n && priorCost !== 0n) throw new Error('an empty position cannot retain cost basis')

  const notional = roundDiv(quantity * price, MICROS)
  if (notional <= 0n) throw new Error('fill notional rounds to zero micros')
  if (fill.side === OrderSide.Buy) {
    return {
      notional,
      costBasis: notional,
      realizedPnl: 0n,
      quantityDelta: quantity,
      costBasisDelta: notional,
      cashDelta: -(notional + fee),
    }
  }

  if (quantity > priorQuantity) throw new Error('sell fill exceeds the recorded long position')
  const costBasis = quantity === priorQuantity ? priorCost : roundDiv(priorCost * quantity, priorQuantity)
  return {
    notional,
    costBasis,
    realizedPnl: notional - costBasis,
    quantityDelta: -quantity,
    costBasisDelta: -costBasis,
    cashDelta: notional - fee,
  }
}

const makeLedgerPlan = (
  transactionId: string,
  brokerEventId: string,
  fill: LedgerFill,
  amounts: Amounts,
  ledger: number,
): LedgerPlan => {
  const accounts = new Map<string, Account>()
  const getAccount = (name: string, code: AccountCodeValue): Account => {
    const existing = accounts.get(name)
    if (existing !== undefined) return existing
    const created = makeAccount(fill.accountId, ledger, name, code)
    accounts.set(name, created)
    return created
  }
  const transfers: Transfer[] = []
  const addTransfer = (
    leg: string,
    debitName: string,
    debitCode: AccountCodeValue,
    creditName: string,
    creditCode: AccountCodeValue,
    amount: bigint,
    code: TransferCodeValue,
  ): void => {
    if (amount === 0n) return
    const debit = getAccount(debitName, debitCode)
    const credit = getAccount(creditName, creditCode)
    transfers.push(
      makeTransfer(transactionId, brokerEventId, fill.accountId, ledger, leg, debit.id, credit.id, amount, code),
    )
  }

  const inventory = `inventory:${fill.symbol}`
  if (fill.side === OrderSide.Buy) {
    addTransfer('buy', inventory, AccountCode.inventory, 'cash', AccountCode.cash, amounts.notional, TransferCode.buy)
  } else if (amounts.realizedPnl >= 0n) {
    addTransfer(
      'sell-basis',
      'cash',
      AccountCode.cash,
      inventory,
      AccountCode.inventory,
      amounts.costBasis,
      TransferCode.sellBasis,
    )
    addTransfer(
      'realized-gain',
      'cash',
      AccountCode.cash,
      'realized-gain',
      AccountCode.realizedGain,
      amounts.realizedPnl,
      TransferCode.realizedGain,
    )
  } else {
    addTransfer(
      'sell-proceeds',
      'cash',
      AccountCode.cash,
      inventory,
      AccountCode.inventory,
      amounts.notional,
      TransferCode.sellBasis,
    )
    addTransfer(
      'realized-loss',
      'realized-loss',
      AccountCode.realizedLoss,
      inventory,
      AccountCode.inventory,
      -amounts.realizedPnl,
      TransferCode.realizedLoss,
    )
  }
  addTransfer(
    'fee',
    'fee-expense',
    AccountCode.feeExpense,
    'cash',
    AccountCode.cash,
    BigInt(fill.feeMicros),
    TransferCode.fee,
  )
  if (transfers.length === 0) throw new Error('accounting transaction contains no positive transfer')

  return {
    runKey: stableU128('bayn-paper-account-v1', fill.accountId),
    runTag: stableU64('bayn-paper-account-v1', fill.accountId),
    accounts: [...accounts.values()].sort((left, right) => (left.id < right.id ? -1 : 1)),
    transfers: transfers.sort((left, right) => (left.id < right.id ? -1 : 1)),
  }
}

export const rebuildAccountingLedger = (transaction: AccountingTransaction, ledger: number): LedgerPlan => {
  const decoded = decodeTransaction(transaction)
  const { contentHash, ...material } = decoded
  if (canonicalHashV1(material) !== contentHash) {
    throw new Error('accounting transaction content hash does not match its immutable fields')
  }
  const plan = makeLedgerPlan(
    decoded.transactionId,
    decoded.brokerEventId,
    {
      accountId: decoded.accountId,
      symbol: decoded.symbol,
      side: decoded.side,
      feeMicros: decoded.feeMicros,
    },
    {
      notional: BigInt(decoded.notionalMicros),
      costBasis: BigInt(decoded.costBasisMicros),
      realizedPnl: BigInt(decoded.realizedPnlMicros),
      quantityDelta: BigInt(decoded.quantityDeltaMicros),
      costBasisDelta: BigInt(decoded.costBasisDeltaMicros),
      cashDelta: BigInt(decoded.cashDeltaMicros),
    },
    ledger,
  )
  if (hashLedgerPlan(plan) !== decoded.ledgerPlanHash) {
    throw new Error('accounting transaction ledger plan hash does not match its immutable fields')
  }
  return plan
}

export const prepareAccounting = (
  brokerEventId: string,
  fill: Fill,
  prior: PositionCost,
  ledger: number,
): PreparedAccounting => {
  const amounts = calculateAmounts(fill, prior)
  const transactionId = canonicalHashV1({
    schemaVersion: 'bayn.paper-accounting-transaction-id.v1',
    brokerEventId,
  })
  const ledgerPlan = makeLedgerPlan(transactionId, brokerEventId, fill, amounts, ledger)
  const material = {
    schemaVersion: 'bayn.paper-accounting-transaction.v1' as const,
    transactionId,
    brokerEventId,
    ...(fill.intentId === undefined ? {} : { intentId: fill.intentId }),
    accountId: fill.accountId,
    symbol: fill.symbol,
    side: fill.side,
    quantityMicros: fill.quantityMicros,
    priceMicros: fill.priceMicros,
    notionalMicros: amounts.notional.toString(),
    feeMicros: fill.feeMicros,
    costBasisMicros: amounts.costBasis.toString(),
    realizedPnlMicros: amounts.realizedPnl.toString(),
    quantityDeltaMicros: amounts.quantityDelta.toString(),
    costBasisDeltaMicros: amounts.costBasisDelta.toString(),
    cashDeltaMicros: amounts.cashDelta.toString(),
    ledgerPlanHash: hashLedgerPlan(ledgerPlan),
    occurredAt: fill.occurredAt,
  }
  return {
    transaction: decodeTransaction({ ...material, contentHash: canonicalHashV1(material) }),
    ledger: ledgerPlan,
  }
}
