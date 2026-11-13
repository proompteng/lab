import { pipe, Result } from 'effect'

import { canonicalHashV1Result, stableU128, stableU64 } from '../hash'
import {
  AccountCode,
  hashLedgerPlanResult,
  LEDGER_ACCOUNT_HISTORY_FLAG,
  LEDGER_SCHEMA_VERSION,
  TransferCode,
  type LedgerAccountRecord,
  type LedgerPlan,
  type LedgerTransferRecord,
} from '../ledger-plan'
import { OrderSide, type Fill } from '../execution/contracts'
import {
  legacyAccountingTransactionIdSchemaVersion,
  legacyAccountingTransactionSchemaVersion,
} from '../execution/legacy-wire'
import { roundUnsignedHalfUp } from '../unsigned-round-half-up'
import { type AccountingFailure, type AccountingHashOperation, type AccountingMicrosField } from './failure'
import type { PositionCost, PreparedAccounting } from './model'
import { decodeAccountingTransaction, equityShortAccountingSchemaVersion, type AccountingTransaction } from './schema'

export enum AccountingInventorySide {
  Long = 'LONG',
  Short = 'SHORT',
}

const NOTIONAL_DIVISOR = 1_000_000_000_000n
type AccountCodeValue = (typeof AccountCode)[keyof typeof AccountCode]
type TransferCodeValue = (typeof TransferCode)[keyof typeof TransferCode]

interface AccountingAmounts {
  readonly fee: bigint
  readonly notional: bigint
  readonly costBasis: bigint
  readonly realizedPnl: bigint
  readonly quantityDelta: bigint
  readonly costBasisDelta: bigint
  readonly cashDelta: bigint
}

interface AccountingLeg {
  readonly leg: string
  readonly debitName: string
  readonly debitCode: AccountCodeValue
  readonly creditName: string
  readonly creditCode: AccountCodeValue
  readonly amount: bigint
  readonly code: TransferCodeValue
}

interface AccountIdentity {
  readonly accountId: string
  readonly ledger: number
  readonly runKey: bigint
  readonly runTag: bigint
}

type ParsedAccountingInput = {
  readonly quantity: bigint
  readonly price: bigint
  readonly fee: bigint
  readonly priorQuantity: bigint
  readonly priorCost: bigint
}

type LedgerFill = Pick<Fill, 'accountId' | 'symbol' | 'side'>

type AccountSpec = {
  readonly name: string
  readonly code: AccountCodeValue
}

const failAccounting = (failure: AccountingFailure): Result.Result<never, AccountingFailure> => Result.fail(failure)

const canonicalIntegerPattern = /^(?:0|-?[1-9][0-9]*)$/

const parseMicros = (field: AccountingMicrosField, value: string): Result.Result<bigint, AccountingFailure> =>
  canonicalIntegerPattern.test(value)
    ? Result.succeed(BigInt(value))
    : failAccounting({ _tag: 'AccountingMicrosParseFailed', field, value })

const parseAccountingInput = (
  fill: Fill,
  prior: PositionCost,
): Result.Result<ParsedAccountingInput, AccountingFailure> =>
  Result.all({
    quantity: parseMicros('fill.quantityAtoms', fill.quantityAtoms),
    price: parseMicros('fill.priceAtoms', fill.priceAtoms),
    fee: parseMicros('fill.feeMicros', fill.feeMicros),
    priorQuantity: parseMicros('position.quantityAtoms', prior.quantityAtoms),
    priorCost: parseMicros('position.costMicros', prior.costMicros),
  })

const roundDiv = (numerator: bigint, denominator: bigint): Result.Result<bigint, AccountingFailure> =>
  Result.mapError(roundUnsignedHalfUp(numerator, denominator), (cause) => ({
    _tag: 'AccountingUnsignedDivisionFailed',
    numerator,
    denominator,
    cause,
  }))

const validatePositionCost = (
  input: ParsedAccountingInput,
): Result.Result<ParsedAccountingInput, AccountingFailure> => {
  if (input.priorQuantity < 0n || input.priorCost < 0n) {
    return failAccounting({
      _tag: 'AccountingNegativePositionCost',
      quantityAtoms: input.priorQuantity,
      costMicros: input.priorCost,
    })
  }
  if (input.priorQuantity === 0n && input.priorCost !== 0n) {
    return failAccounting({
      _tag: 'AccountingEmptyPositionRetainsCost',
      costMicros: input.priorCost,
    })
  }
  return Result.succeed(input)
}

const buyAmounts = (input: ParsedAccountingInput, notional: bigint): AccountingAmounts => ({
  fee: input.fee,
  notional,
  costBasis: notional,
  realizedPnl: 0n,
  quantityDelta: input.quantity,
  costBasisDelta: notional,
  cashDelta: -(notional + input.fee),
})

const sellAmounts = (
  input: ParsedAccountingInput,
  notional: bigint,
): Result.Result<AccountingAmounts, AccountingFailure> => {
  if (input.quantity > input.priorQuantity) {
    return failAccounting({
      _tag: 'AccountingSellQuantityExceedsPosition',
      saleQuantityAtoms: input.quantity,
      positionQuantityAtoms: input.priorQuantity,
    })
  }
  return pipe(
    input.quantity === input.priorQuantity
      ? Result.succeed(input.priorCost)
      : roundDiv(input.priorCost * input.quantity, input.priorQuantity),
    Result.map((costBasis) => ({
      fee: input.fee,
      notional,
      costBasis,
      realizedPnl: notional - costBasis,
      quantityDelta: -input.quantity,
      costBasisDelta: -costBasis,
      cashDelta: notional - input.fee,
    })),
  )
}

const calculateAmounts = (fill: Fill, prior: PositionCost): Result.Result<AccountingAmounts, AccountingFailure> =>
  pipe(
    parseAccountingInput(fill, prior),
    Result.flatMap(validatePositionCost),
    Result.flatMap((input) =>
      pipe(
        roundDiv(input.quantity * input.price, NOTIONAL_DIVISOR),
        Result.flatMap((notional) =>
          notional <= 0n
            ? failAccounting({
                _tag: 'AccountingFillNotionalRoundedToZero',
                quantityAtoms: input.quantity,
                priceAtoms: input.price,
              })
            : fill.side === OrderSide.Buy
              ? Result.succeed(buyAmounts(input, notional))
              : sellAmounts(input, notional),
        ),
      ),
    ),
  )

const calculateShortAmounts = (fill: Fill, prior: PositionCost): Result.Result<AccountingAmounts, AccountingFailure> =>
  Result.gen(function* () {
    if (fill.symbol.includes('/'))
      return yield* failAccounting({ _tag: 'AccountingInvalidShortPosition', reason: 'EQUITY_REQUIRED' })
    const input = yield* parseAccountingInput(fill, prior)
    if (input.priorQuantity > 0n || input.priorCost > 0n || (input.priorQuantity === 0n && input.priorCost !== 0n))
      return yield* failAccounting({ _tag: 'AccountingInvalidShortPosition', reason: 'INCOHERENT_POSITION' })
    const notional = yield* roundDiv(input.quantity * input.price, NOTIONAL_DIVISOR)
    if (notional <= 0n)
      return yield* failAccounting({
        _tag: 'AccountingFillNotionalRoundedToZero',
        quantityAtoms: input.quantity,
        priceAtoms: input.price,
      })
    if (fill.side === OrderSide.Sell)
      return {
        fee: input.fee,
        notional,
        costBasis: notional,
        realizedPnl: 0n,
        quantityDelta: -input.quantity,
        costBasisDelta: -notional,
        cashDelta: notional - input.fee,
      }
    const outstanding = -input.priorQuantity
    if (input.quantity > outstanding || outstanding === 0n)
      return yield* failAccounting({ _tag: 'AccountingInvalidShortPosition', reason: 'COVER_EXCEEDS_POSITION' })
    // The final cover consumes the exact remaining liability, including prior rounding residuals.
    const basis =
      input.quantity === outstanding
        ? -input.priorCost
        : yield* roundDiv(-input.priorCost * input.quantity, outstanding)
    return {
      fee: input.fee,
      notional,
      costBasis: basis,
      realizedPnl: basis - notional,
      quantityDelta: input.quantity,
      costBasisDelta: basis,
      cashDelta: -(notional + input.fee),
    }
  })

const makeAccount = (identity: AccountIdentity, spec: AccountSpec): LedgerAccountRecord => ({
  id: stableU128('bayn-paper-ledger-account-v1', identity.accountId, spec.name),
  debits_pending: 0n,
  debits_posted: 0n,
  credits_pending: 0n,
  credits_posted: 0n,
  user_data_128: identity.runKey,
  user_data_64: identity.runTag,
  user_data_32: LEDGER_SCHEMA_VERSION,
  reserved: 0,
  ledger: identity.ledger,
  code: spec.code,
  flags: LEDGER_ACCOUNT_HISTORY_FLAG,
  timestamp: 0n,
})

const makeTransfer = (
  brokerEventId: string,
  transactionKey: bigint,
  identity: AccountIdentity,
  accountingLeg: AccountingLeg,
  account: (spec: AccountSpec) => LedgerAccountRecord,
): LedgerTransferRecord => ({
  id: stableU128('bayn-paper-transfer-v1', brokerEventId, accountingLeg.leg),
  debit_account_id: account({
    name: accountingLeg.debitName,
    code: accountingLeg.debitCode,
  }).id,
  credit_account_id: account({
    name: accountingLeg.creditName,
    code: accountingLeg.creditCode,
  }).id,
  amount: accountingLeg.amount,
  pending_id: 0n,
  user_data_128: transactionKey,
  user_data_64: identity.runTag,
  user_data_32: LEDGER_SCHEMA_VERSION,
  timeout: 0,
  ledger: identity.ledger,
  code: accountingLeg.code,
  flags: 0,
  timestamp: 0n,
})

const feeLeg = (amount: bigint): AccountingLeg => ({
  leg: 'fee',
  debitName: 'fee-expense',
  debitCode: AccountCode.feeExpense,
  creditName: 'cash',
  creditCode: AccountCode.cash,
  amount,
  code: TransferCode.fee,
})

const buyLegs = (symbol: string, amounts: AccountingAmounts): readonly AccountingLeg[] => [
  {
    leg: 'buy',
    debitName: `inventory:${symbol}`,
    debitCode: AccountCode.inventory,
    creditName: 'cash',
    creditCode: AccountCode.cash,
    amount: amounts.notional,
    code: TransferCode.buy,
  },
  feeLeg(amounts.fee),
]

const profitableSaleLegs = (symbol: string, amounts: AccountingAmounts): readonly AccountingLeg[] => [
  {
    leg: 'sell-basis',
    debitName: 'cash',
    debitCode: AccountCode.cash,
    creditName: `inventory:${symbol}`,
    creditCode: AccountCode.inventory,
    amount: amounts.costBasis,
    code: TransferCode.sellBasis,
  },
  {
    leg: 'realized-gain',
    debitName: 'cash',
    debitCode: AccountCode.cash,
    creditName: 'realized-gain',
    creditCode: AccountCode.realizedGain,
    amount: amounts.realizedPnl,
    code: TransferCode.realizedGain,
  },
  feeLeg(amounts.fee),
]

const losingSaleLegs = (symbol: string, amounts: AccountingAmounts): readonly AccountingLeg[] => [
  {
    leg: 'sell-proceeds',
    debitName: 'cash',
    debitCode: AccountCode.cash,
    creditName: `inventory:${symbol}`,
    creditCode: AccountCode.inventory,
    amount: amounts.notional,
    code: TransferCode.sellBasis,
  },
  {
    leg: 'realized-loss',
    debitName: 'realized-loss',
    debitCode: AccountCode.realizedLoss,
    creditName: `inventory:${symbol}`,
    creditCode: AccountCode.inventory,
    amount: -amounts.realizedPnl,
    code: TransferCode.realizedLoss,
  },
  feeLeg(amounts.fee),
]

const shortLedgerLegs = (fill: LedgerFill, amounts: AccountingAmounts): readonly AccountingLeg[] => {
  if (fill.side === OrderSide.Sell) return profitableSaleLegs(fill.symbol, amounts)
  const gain = amounts.realizedPnl >= 0n
  return [
    {
      leg: 'short-cover',
      debitName: `inventory:${fill.symbol}`,
      debitCode: AccountCode.inventory,
      creditName: 'cash',
      creditCode: AccountCode.cash,
      amount: gain ? amounts.notional : amounts.costBasis,
      code: TransferCode.buy,
    },
    gain
      ? {
          leg: 'short-realized-gain',
          debitName: `inventory:${fill.symbol}`,
          debitCode: AccountCode.inventory,
          creditName: 'realized-gain',
          creditCode: AccountCode.realizedGain,
          amount: amounts.realizedPnl,
          code: TransferCode.realizedGain,
        }
      : {
          leg: 'short-realized-loss',
          debitName: 'realized-loss',
          debitCode: AccountCode.realizedLoss,
          creditName: 'cash',
          creditCode: AccountCode.cash,
          amount: -amounts.realizedPnl,
          code: TransferCode.realizedLoss,
        },
    feeLeg(amounts.fee),
  ]
}

const ledgerLegs = (fill: LedgerFill, amounts: AccountingAmounts): readonly AccountingLeg[] =>
  (fill.side === OrderSide.Buy
    ? buyLegs(fill.symbol, amounts)
    : amounts.realizedPnl >= 0n
      ? profitableSaleLegs(fill.symbol, amounts)
      : losingSaleLegs(fill.symbol, amounts)
  ).filter(({ amount }) => amount !== 0n)

const makeLegPlan = (
  transactionId: string,
  brokerEventId: string,
  accountId: string,
  legs: readonly AccountingLeg[],
  ledger: number,
): LedgerPlan => {
  const identity = {
    accountId,
    ledger,
    runKey: stableU128('bayn-paper-account-v1', accountId),
    runTag: stableU64('bayn-paper-account-v1', accountId),
  }
  const transactionKey = stableU128('bayn-paper-transaction-v1', transactionId)
  // Reuse deterministic identities only within this construction. Every reconciliation still
  // reconstructs and verifies the complete plan, and independent plans never share mutable records.
  const accounts = new Map<string, LedgerAccountRecord>()
  const account = (spec: AccountSpec): LedgerAccountRecord => {
    const existing = accounts.get(spec.name)
    if (existing !== undefined) return existing
    const created = makeAccount(identity, spec)
    accounts.set(spec.name, created)
    return created
  }
  const transfers = legs
    .map((leg) => makeTransfer(brokerEventId, transactionKey, identity, leg, account))
    .toSorted((left, right) => (left.id < right.id ? -1 : 1))
  return {
    runKey: identity.runKey,
    runTag: identity.runTag,
    accounts: [...accounts.values()].toSorted((left, right) => (left.id < right.id ? -1 : 1)),
    transfers,
  }
}

const makeLedgerPlan = (
  transactionId: string,
  brokerEventId: string,
  fill: LedgerFill,
  amounts: AccountingAmounts,
  ledger: number,
  inventorySide = AccountingInventorySide.Long,
): LedgerPlan =>
  makeLegPlan(
    transactionId,
    brokerEventId,
    fill.accountId,
    inventorySide === AccountingInventorySide.Short
      ? shortLedgerLegs(fill, amounts).filter(({ amount }) => amount !== 0n)
      : ledgerLegs(fill, amounts),
    ledger,
  )

const hashAccountingMaterial = (
  operation: AccountingHashOperation,
  material: unknown,
): Result.Result<string, AccountingFailure> =>
  Result.mapError(canonicalHashV1Result(material), (cause) => ({
    _tag: 'AccountingCanonicalizationFailed',
    operation,
    cause,
  }))

const hashAccountingLedgerPlan = (plan: LedgerPlan): Result.Result<string, AccountingFailure> =>
  Result.mapError(hashLedgerPlanResult(plan), (cause) => ({
    _tag: 'AccountingCanonicalizationFailed',
    operation: 'ledger-plan',
    cause,
  }))

const requireContentHash = (
  transaction: AccountingTransaction,
): Result.Result<AccountingTransaction, AccountingFailure> => {
  const { contentHash, ...material } = transaction
  return pipe(
    hashAccountingMaterial('transaction-content', material),
    Result.flatMap((expectedContentHash) =>
      expectedContentHash === contentHash
        ? Result.succeed(transaction)
        : failAccounting({
            _tag: 'AccountingTransactionContentHashMismatch',
            transactionId: transaction.transactionId,
            observedContentHash: contentHash,
            expectedContentHash,
          }),
    ),
  )
}

const requireLedgerPlanHash = (
  transaction: AccountingTransaction,
  plan: LedgerPlan,
): Result.Result<LedgerPlan, AccountingFailure> =>
  pipe(
    hashAccountingLedgerPlan(plan),
    Result.flatMap((expectedLedgerPlanHash) =>
      expectedLedgerPlanHash === transaction.ledgerPlanHash
        ? Result.succeed(plan)
        : failAccounting({
            _tag: 'AccountingLedgerPlanHashMismatch',
            transactionId: transaction.transactionId,
            observedLedgerPlanHash: transaction.ledgerPlanHash,
            expectedLedgerPlanHash,
          }),
    ),
  )

export const rebuildAccountingLedger = (input: unknown, ledger: number): Result.Result<LedgerPlan, AccountingFailure> =>
  pipe(
    decodeAccountingTransaction(input),
    Result.mapError((cause): AccountingFailure => ({ _tag: 'AccountingTransactionDecodeFailed', cause })),
    Result.flatMap(requireContentHash),
    Result.flatMap((transaction) =>
      requireLedgerPlanHash(
        transaction,
        makeLedgerPlan(
          transaction.transactionId,
          transaction.brokerEventId,
          {
            accountId: transaction.accountId,
            symbol: transaction.symbol,
            side: transaction.side,
          },
          {
            fee: BigInt(transaction.feeMicros),
            notional: BigInt(transaction.notionalMicros),
            costBasis: BigInt(transaction.costBasisMicros),
            realizedPnl: BigInt(transaction.realizedPnlMicros),
            quantityDelta: BigInt(transaction.quantityDeltaAtoms),
            costBasisDelta: BigInt(transaction.costBasisDeltaMicros),
            cashDelta: BigInt(transaction.cashDeltaMicros),
          },
          ledger,
          transaction.schemaVersion === equityShortAccountingSchemaVersion
            ? AccountingInventorySide.Short
            : AccountingInventorySide.Long,
        ),
      ),
    ),
  )

export const prepareAccounting = (
  brokerEventId: string,
  fill: Fill,
  prior: PositionCost,
  ledger: number,
  inventorySide = AccountingInventorySide.Long,
): Result.Result<PreparedAccounting, AccountingFailure> =>
  pipe(
    inventorySide === AccountingInventorySide.Short
      ? calculateShortAmounts(fill, prior)
      : calculateAmounts(fill, prior),
    Result.flatMap((amounts) =>
      pipe(
        hashAccountingMaterial('transaction-id', {
          schemaVersion:
            inventorySide === AccountingInventorySide.Short
              ? 'bayn.equity-short-accounting-transaction-id.v1'
              : legacyAccountingTransactionIdSchemaVersion,
          brokerEventId,
        }),
        Result.flatMap((transactionId) => {
          const ledgerPlan = makeLedgerPlan(transactionId, brokerEventId, fill, amounts, ledger, inventorySide)
          return pipe(
            hashAccountingLedgerPlan(ledgerPlan),
            Result.flatMap((ledgerPlanHash) => {
              const material = {
                schemaVersion:
                  inventorySide === AccountingInventorySide.Short
                    ? equityShortAccountingSchemaVersion
                    : legacyAccountingTransactionSchemaVersion,
                transactionId,
                brokerEventId,
                ...(fill.intentId === undefined ? {} : { intentId: fill.intentId }),
                accountId: fill.accountId,
                symbol: fill.symbol,
                side: fill.side,
                quantityAtoms: fill.quantityAtoms,
                priceAtoms: fill.priceAtoms,
                notionalMicros: amounts.notional.toString(),
                feeMicros: fill.feeMicros,
                costBasisMicros: amounts.costBasis.toString(),
                realizedPnlMicros: amounts.realizedPnl.toString(),
                quantityDeltaAtoms: amounts.quantityDelta.toString(),
                costBasisDeltaMicros: amounts.costBasisDelta.toString(),
                cashDeltaMicros: amounts.cashDelta.toString(),
                ledgerPlanHash,
                occurredAt: fill.occurredAt,
              }
              return pipe(
                hashAccountingMaterial('transaction-content', material),
                Result.flatMap((contentHash) =>
                  pipe(
                    decodeAccountingTransaction({ ...material, contentHash }),
                    Result.mapError(
                      (cause): AccountingFailure => ({ _tag: 'AccountingTransactionDecodeFailed', cause }),
                    ),
                    Result.map((transaction) => ({ transaction, ledger: ledgerPlan })),
                  ),
                ),
              )
            }),
          )
        }),
      ),
    ),
  )

export const brokerFeeLedgerPlan = (
  accountId: string,
  activityId: string,
  netAmountMicros: string,
  ledger: number,
): LedgerPlan => {
  const net = BigInt(netAmountMicros)
  const eventId = stableU128('bayn.broker-fee-event.v1', accountId, activityId).toString()
  const transactionId = stableU128('bayn.broker-fee-transaction.v1', accountId, activityId).toString()
  const debit =
    net < 0n ? { name: 'fee-expense', code: AccountCode.feeExpense } : { name: 'cash', code: AccountCode.cash }
  const credit =
    net < 0n ? { name: 'cash', code: AccountCode.cash } : { name: 'fee-expense', code: AccountCode.feeExpense }
  return makeLegPlan(
    transactionId,
    eventId,
    accountId,
    net === 0n
      ? []
      : [
          {
            leg: 'broker-fee',
            debitName: debit.name,
            debitCode: debit.code,
            creditName: credit.name,
            creditCode: credit.code,
            amount: net < 0n ? -net : net,
            code: TransferCode.fee,
          },
        ],
    ledger,
  )
}

export const cashSettlementLedgerPlan = (
  accountId: string,
  settlementId: string,
  roundingDeltaMicros: string,
  ledger: number,
): LedgerPlan => {
  const net = BigInt(roundingDeltaMicros)
  const eventId = `cash-settlement:${settlementId}`
  const leg: AccountingLeg =
    net >= 0n
      ? {
          leg: 'cash-rounding-income',
          debitName: 'cash',
          debitCode: AccountCode.cash,
          creditName: 'cash-rounding-income',
          creditCode: AccountCode.cashRoundingIncome,
          amount: net,
          code: TransferCode.cashRoundingIncome,
        }
      : {
          leg: 'cash-rounding-expense',
          debitName: 'cash-rounding-expense',
          debitCode: AccountCode.cashRoundingExpense,
          creditName: 'cash',
          creditCode: AccountCode.cash,
          amount: -net,
          code: TransferCode.cashRoundingExpense,
        }
  const legs = net === 0n ? [] : [leg]
  return makeLegPlan(eventId, eventId, accountId, legs, ledger)
}

export const coinFeeLedgerPlan = (
  accountId: string,
  activityId: string,
  symbol: string,
  costBasisMicros: string,
  ledger: number,
): LedgerPlan => {
  const amount = BigInt(costBasisMicros)
  const eventId = `coin-fee:${activityId}`
  const leg: AccountingLeg = {
    leg: 'coin-fee',
    debitName: 'fee-expense',
    debitCode: AccountCode.feeExpense,
    creditName: `inventory:${symbol}`,
    creditCode: AccountCode.inventory,
    amount,
    code: TransferCode.fee,
  }
  const legs = amount === 0n ? [] : [leg]
  return makeLegPlan(eventId, eventId, accountId, legs, ledger)
}
