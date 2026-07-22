import { AccountFlags, type Account, type Transfer } from 'tigerbeetle-node'

import { canonicalHashV1, stableU128, stableU64 } from './hash'
import type { CashYieldEvent, EvaluationEvent, FeeEvent, FillEvent, InputManifest } from './types'

export const LEDGER_SCHEMA_VERSION = 2
export const LEDGER_BATCH_MAX = 8_189

export const AccountCode = {
  cash: 110,
  inventory: 120,
  equity: 310,
  realizedGain: 410,
  cashYieldIncome: 420,
  feeExpense: 510,
  realizedLoss: 520,
} as const

export const TransferCode = {
  funding: 1,
  buy: 2,
  sellBasis: 3,
  realizedGain: 4,
  realizedLoss: 5,
  fee: 6,
  cashYield: 7,
} as const

export interface LedgerPlan {
  readonly runKey: bigint
  readonly runTag: bigint
  readonly accounts: readonly Account[]
  readonly transfers: readonly Transfer[]
}

export interface LedgerInput {
  readonly runId: string
  readonly initialCapitalMicros: string
  readonly inputManifest: InputManifest
  readonly events: readonly EvaluationEvent[]
}

const account = (
  runId: string,
  runKey: bigint,
  runTag: bigint,
  ledger: number,
  name: string,
  code: number,
): Account => ({
  id: stableU128('bayn-account-v1', runId, name),
  debits_pending: 0n,
  debits_posted: 0n,
  credits_pending: 0n,
  credits_posted: 0n,
  user_data_128: runKey,
  user_data_64: runTag,
  user_data_32: LEDGER_SCHEMA_VERSION,
  reserved: 0,
  ledger,
  code,
  flags: AccountFlags.history,
  timestamp: 0n,
})

const transfer = (
  runId: string,
  runTag: bigint,
  ledger: number,
  eventId: string,
  leg: string,
  debitAccountId: bigint,
  creditAccountId: bigint,
  amount: bigint,
  code: number,
  event: unknown,
): Transfer => ({
  id: stableU128('bayn-transfer-v1', runId, eventId, leg),
  debit_account_id: debitAccountId,
  credit_account_id: creditAccountId,
  amount,
  pending_id: 0n,
  user_data_128: stableU128('bayn-event-v1', canonicalHashV1(event)),
  user_data_64: runTag,
  user_data_32: LEDGER_SCHEMA_VERSION,
  timeout: 0,
  ledger,
  code,
  flags: 0,
  timestamp: 0n,
})

const positiveAmount = (value: string, name: string): bigint => {
  const parsed = BigInt(value)
  if (parsed < 0n) throw new Error(`${name} must not be negative`)
  return parsed
}

export const buildLedgerPlan = (result: LedgerInput, ledger: number): LedgerPlan => {
  const runKey = stableU128('bayn-run-v1', result.runId)
  const runTag = stableU64('bayn-run-v1', result.runId)
  const accountsByName = new Map<string, Account>()
  const addAccount = (name: string, code: number): Account => {
    const created = account(result.runId, runKey, runTag, ledger, name, code)
    accountsByName.set(name, created)
    return created
  }
  const cash = addAccount('cash', AccountCode.cash)
  const equity = addAccount('equity', AccountCode.equity)
  const fees = addAccount('fee-expense', AccountCode.feeExpense)
  const cashYieldIncome = addAccount('cash-yield-income', AccountCode.cashYieldIncome)
  const realizedGain = addAccount('realized-gain', AccountCode.realizedGain)
  const realizedLoss = addAccount('realized-loss', AccountCode.realizedLoss)
  for (const symbol of result.inputManifest.symbols.map((coverage) => coverage.symbol).sort()) {
    addAccount(`inventory:${symbol}`, AccountCode.inventory)
  }

  const transfers: Transfer[] = []
  const fillEvents = result.events.filter((event): event is FillEvent => event.kind === 'fill')
  if (fillEvents.length === 0) throw new Error('evaluation produced no fill events to journal')
  const startingCapital = BigInt(result.initialCapitalMicros)
  if (startingCapital <= 0n) throw new Error('initial capital must be positive')
  transfers.push(
    transfer(
      result.runId,
      runTag,
      ledger,
      'funding',
      'principal',
      cash.id,
      equity.id,
      startingCapital,
      TransferCode.funding,
      { kind: 'funding', runId: result.runId, amountMicros: startingCapital.toString() },
    ),
  )

  for (const fill of fillEvents) {
    const inventory = accountsByName.get(`inventory:${fill.symbol}`)
    if (!inventory) throw new Error(`missing inventory account for ${fill.symbol}`)
    const notional = positiveAmount(fill.notionalMicros, 'fill notional')
    const costBasis = positiveAmount(fill.costBasisMicros, 'fill cost basis')
    if (notional === 0n) continue

    if (fill.side === 'buy') {
      transfers.push(
        transfer(result.runId, runTag, ledger, fill.id, 'buy', inventory.id, cash.id, notional, TransferCode.buy, fill),
      )
    } else if (notional >= costBasis) {
      if (costBasis > 0n) {
        transfers.push(
          transfer(
            result.runId,
            runTag,
            ledger,
            fill.id,
            'sell-basis',
            cash.id,
            inventory.id,
            costBasis,
            TransferCode.sellBasis,
            fill,
          ),
        )
      }
      if (notional > costBasis) {
        transfers.push(
          transfer(
            result.runId,
            runTag,
            ledger,
            fill.id,
            'realized-gain',
            cash.id,
            realizedGain.id,
            notional - costBasis,
            TransferCode.realizedGain,
            fill,
          ),
        )
      }
    } else {
      transfers.push(
        transfer(
          result.runId,
          runTag,
          ledger,
          fill.id,
          'sell-proceeds',
          cash.id,
          inventory.id,
          notional,
          TransferCode.sellBasis,
          fill,
        ),
      )
      transfers.push(
        transfer(
          result.runId,
          runTag,
          ledger,
          fill.id,
          'realized-loss',
          realizedLoss.id,
          inventory.id,
          costBasis - notional,
          TransferCode.realizedLoss,
          fill,
        ),
      )
    }
  }
  const feeEvents = result.events.filter((event): event is FeeEvent => event.kind === 'fee')
  for (const fee of feeEvents) {
    const amount = positiveAmount(fee.totalMicros, 'fee total')
    if (amount > 0n) {
      transfers.push(
        transfer(result.runId, runTag, ledger, fee.id, 'fee', fees.id, cash.id, amount, TransferCode.fee, fee),
      )
    }
  }
  const cashYieldEvents = result.events.filter((event): event is CashYieldEvent => event.kind === 'cash-yield')
  for (const cashYield of cashYieldEvents) {
    const amount = positiveAmount(cashYield.amountMicros, 'cash yield')
    if (amount > 0n) {
      transfers.push(
        transfer(
          result.runId,
          runTag,
          ledger,
          cashYield.id,
          'cash-yield',
          cash.id,
          cashYieldIncome.id,
          amount,
          TransferCode.cashYield,
          cashYield,
        ),
      )
    }
  }

  if (accountsByName.size >= LEDGER_BATCH_MAX || transfers.length >= LEDGER_BATCH_MAX) {
    throw new Error('Bayn ledger run exceeds the exact single-query reconciliation limit')
  }
  return {
    runKey,
    runTag,
    accounts: [...accountsByName.values()].sort((left, right) => (left.id < right.id ? -1 : 1)),
    transfers: transfers.sort((left, right) => (left.id < right.id ? -1 : 1)),
  }
}

const serializeRecord = (record: Account | Transfer): Record<string, number | string> =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value]),
  )

export const hashLedgerPlan = (plan: LedgerPlan): string =>
  canonicalHashV1({
    schemaVersion: 'bayn.ledger-plan.v1',
    runKey: plan.runKey.toString(),
    runTag: plan.runTag.toString(),
    accounts: plan.accounts.map(serializeRecord),
    transfers: plan.transfers.map(serializeRecord),
  })

const accountMetadataMatches = (actual: Account, expected: Account): boolean =>
  actual.id === expected.id &&
  actual.user_data_128 === expected.user_data_128 &&
  actual.user_data_64 === expected.user_data_64 &&
  actual.user_data_32 === expected.user_data_32 &&
  actual.ledger === expected.ledger &&
  actual.code === expected.code &&
  actual.flags === expected.flags

const transferMatches = (actual: Transfer, expected: Transfer): boolean =>
  actual.id === expected.id &&
  actual.debit_account_id === expected.debit_account_id &&
  actual.credit_account_id === expected.credit_account_id &&
  actual.amount === expected.amount &&
  actual.pending_id === expected.pending_id &&
  actual.user_data_128 === expected.user_data_128 &&
  actual.user_data_64 === expected.user_data_64 &&
  actual.user_data_32 === expected.user_data_32 &&
  actual.timeout === expected.timeout &&
  actual.ledger === expected.ledger &&
  actual.code === expected.code &&
  actual.flags === expected.flags

const assertUniqueExact = <T extends { readonly id: bigint }>(
  kind: string,
  actual: readonly T[],
  expected: readonly T[],
  matches: (actualValue: T, expectedValue: T) => boolean,
): void => {
  const expectedById = new Map(expected.map((value) => [value.id, value]))
  if (actual.length !== expected.length || new Set(actual.map((value) => value.id)).size !== actual.length) {
    throw new Error(`${kind} set mismatch: expected ${expected.length}, received ${actual.length}`)
  }
  for (const value of actual) {
    const expectedValue = expectedById.get(value.id)
    if (!expectedValue || !matches(value, expectedValue)) throw new Error(`${kind} ${value.id} does not match its plan`)
  }
}

export const assertAccountsMatch = (kind: string, actual: readonly Account[], expected: readonly Account[]): void =>
  assertUniqueExact(kind, actual, expected, accountMetadataMatches)

export const assertTransfersMatch = (kind: string, actual: readonly Transfer[], expected: readonly Transfer[]): void =>
  assertUniqueExact(kind, actual, expected, transferMatches)

export const assertReconciled = (
  plan: LedgerPlan,
  actualAccounts: readonly Account[],
  actualTransfers: readonly Transfer[],
): void => {
  assertAccountsMatch('account', actualAccounts, plan.accounts)
  assertTransfersMatch('transfer', actualTransfers, plan.transfers)

  const expectedBalances = new Map(plan.accounts.map((value) => [value.id, { debits: 0n, credits: 0n }]))
  for (const value of plan.transfers) {
    const debit = expectedBalances.get(value.debit_account_id)
    const credit = expectedBalances.get(value.credit_account_id)
    if (debit === undefined || credit === undefined) {
      throw new Error(`transfer ${value.id} references an unknown account`)
    }
    debit.debits += value.amount
    credit.credits += value.amount
  }
  for (const value of actualAccounts) {
    const balance = expectedBalances.get(value.id)
    if (balance === undefined) throw new Error(`unexpected account ${value.id}`)
    if (
      value.debits_pending !== 0n ||
      value.credits_pending !== 0n ||
      value.debits_posted !== balance.debits ||
      value.credits_posted !== balance.credits
    ) {
      throw new Error(`account ${value.id} balance does not reconcile exactly`)
    }
  }
}
