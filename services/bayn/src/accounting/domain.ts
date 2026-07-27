import type { Account, Transfer } from 'tigerbeetle-node'
import { AccountFlags } from 'tigerbeetle-node'
import { pipe, Result } from 'effect'

import { canonicalHashV1Result, stableU128, stableU64 } from '../hash'
import { AccountCode, hashLedgerPlanResult, LEDGER_SCHEMA_VERSION, TransferCode, type LedgerPlan } from '../ledger-plan'
import { OrderSide, type Fill } from '../paper'
import { roundUnsignedHalfUp } from '../unsigned-round-half-up'
import { type AccountingFailure, type AccountingHashOperation, type AccountingMicrosField } from './failure'
import type { PositionCost, PreparedAccounting } from './model'
import { decodeAccountingTransaction, type AccountingTransaction } from './schema'

const MICROS = 1_000_000n
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
    quantity: parseMicros('fill.quantityMicros', fill.quantityMicros),
    price: parseMicros('fill.priceMicros', fill.priceMicros),
    fee: parseMicros('fill.feeMicros', fill.feeMicros),
    priorQuantity: parseMicros('position.quantityMicros', prior.quantityMicros),
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
      quantityMicros: input.priorQuantity,
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
      saleQuantityMicros: input.quantity,
      positionQuantityMicros: input.priorQuantity,
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
        roundDiv(input.quantity * input.price, MICROS),
        Result.flatMap((notional) =>
          notional <= 0n
            ? failAccounting({
                _tag: 'AccountingFillNotionalRoundedToZero',
                quantityMicros: input.quantity,
                priceMicros: input.price,
              })
            : fill.side === OrderSide.Buy
              ? Result.succeed(buyAmounts(input, notional))
              : sellAmounts(input, notional),
        ),
      ),
    ),
  )

const makeAccount = (brokerAccountId: string, ledger: number, spec: AccountSpec): Account => ({
  id: stableU128('bayn-paper-ledger-account-v1', brokerAccountId, spec.name),
  debits_pending: 0n,
  debits_posted: 0n,
  credits_pending: 0n,
  credits_posted: 0n,
  user_data_128: stableU128('bayn-paper-account-v1', brokerAccountId),
  user_data_64: stableU64('bayn-paper-account-v1', brokerAccountId),
  user_data_32: LEDGER_SCHEMA_VERSION,
  reserved: 0,
  ledger,
  code: spec.code,
  flags: AccountFlags.history,
  timestamp: 0n,
})

const makeTransfer = (
  transactionId: string,
  brokerEventId: string,
  brokerAccountId: string,
  ledger: number,
  accountingLeg: AccountingLeg,
): Transfer => ({
  id: stableU128('bayn-paper-transfer-v1', brokerEventId, accountingLeg.leg),
  debit_account_id: makeAccount(brokerAccountId, ledger, {
    name: accountingLeg.debitName,
    code: accountingLeg.debitCode,
  }).id,
  credit_account_id: makeAccount(brokerAccountId, ledger, {
    name: accountingLeg.creditName,
    code: accountingLeg.creditCode,
  }).id,
  amount: accountingLeg.amount,
  pending_id: 0n,
  user_data_128: stableU128('bayn-paper-transaction-v1', transactionId),
  user_data_64: stableU64('bayn-paper-account-v1', brokerAccountId),
  user_data_32: LEDGER_SCHEMA_VERSION,
  timeout: 0,
  ledger,
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

const ledgerLegs = (fill: LedgerFill, amounts: AccountingAmounts): readonly AccountingLeg[] =>
  (fill.side === OrderSide.Buy
    ? buyLegs(fill.symbol, amounts)
    : amounts.realizedPnl >= 0n
      ? profitableSaleLegs(fill.symbol, amounts)
      : losingSaleLegs(fill.symbol, amounts)
  ).filter(({ amount }) => amount !== 0n)

const uniqueAccountSpecs = (legs: readonly AccountingLeg[]): readonly AccountSpec[] =>
  legs
    .flatMap((leg) => [
      { name: leg.debitName, code: leg.debitCode },
      { name: leg.creditName, code: leg.creditCode },
    ])
    .reduce<readonly AccountSpec[]>(
      (specs, candidate) => (specs.some(({ name }) => name === candidate.name) ? specs : [...specs, candidate]),
      [],
    )

const makeLedgerPlan = (
  transactionId: string,
  brokerEventId: string,
  fill: LedgerFill,
  amounts: AccountingAmounts,
  ledger: number,
): LedgerPlan => {
  const legs = ledgerLegs(fill, amounts)
  return {
    runKey: stableU128('bayn-paper-account-v1', fill.accountId),
    runTag: stableU64('bayn-paper-account-v1', fill.accountId),
    accounts: uniqueAccountSpecs(legs)
      .map((spec) => makeAccount(fill.accountId, ledger, spec))
      .toSorted((left, right) => (left.id < right.id ? -1 : 1)),
    transfers: legs
      .map((leg) => makeTransfer(transactionId, brokerEventId, fill.accountId, ledger, leg))
      .toSorted((left, right) => (left.id < right.id ? -1 : 1)),
  }
}

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
            quantityDelta: BigInt(transaction.quantityDeltaMicros),
            costBasisDelta: BigInt(transaction.costBasisDeltaMicros),
            cashDelta: BigInt(transaction.cashDeltaMicros),
          },
          ledger,
        ),
      ),
    ),
  )

export const prepareAccounting = (
  brokerEventId: string,
  fill: Fill,
  prior: PositionCost,
  ledger: number,
): Result.Result<PreparedAccounting, AccountingFailure> =>
  pipe(
    calculateAmounts(fill, prior),
    Result.flatMap((amounts) =>
      pipe(
        hashAccountingMaterial('transaction-id', {
          schemaVersion: 'bayn.paper-accounting-transaction-id.v1',
          brokerEventId,
        }),
        Result.flatMap((transactionId) => {
          const ledgerPlan = makeLedgerPlan(transactionId, brokerEventId, fill, amounts, ledger)
          return pipe(
            hashAccountingLedgerPlan(ledgerPlan),
            Result.flatMap((ledgerPlanHash) => {
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
