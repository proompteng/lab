import { Data, Result } from 'effect'
import { AccountFlags, type Account, type Transfer } from 'tigerbeetle-node'

import {
  canonicalHashV1,
  canonicalHashV1Result,
  renderCanonicalJsonFailure,
  stableU128,
  stableU64,
  type CanonicalJsonFailure,
} from './hash'
import type { CashYieldEvent, EvaluationEvent, FeeEvent, FillEvent, InputManifest, ReconciliationResult } from './types'

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

export type LedgerValidationOperation =
  | 'build-account-reconciliation'
  | 'build-plan'
  | 'build-transaction-transfer-query'
  | 'check-run'
  | 'post'
  | 'preflight-transfers'
  | 'reconcile'
  | 'verify-account'
  | 'verify-account-results'
  | 'verify-existing-accounts'
  | 'verify-existing-transfers'
  | 'verify-posted-plan'
  | 'verify-transfer-results'

export type LedgerValidationReason =
  | 'batch-limit'
  | 'batch-result-count'
  | 'create-rejected'
  | 'duplicate-account'
  | 'duplicate-transfer'
  | 'empty-plan'
  | 'invalid-account-metadata'
  | 'invalid-balance'
  | 'invalid-transaction'
  | 'invalid-transfer-metadata'
  | 'ledger-plan-failure'
  | 'missing-balance'
  | 'record-mismatch'
  | 'record-set-mismatch'
  | 'run-count-mismatch'
  | 'unknown-account-reference'
  | 'wrong-account'

export class LedgerValidationError extends Data.TaggedError('LedgerValidationError')<{
  readonly operation: LedgerValidationOperation
  readonly reason: LedgerValidationReason
  readonly message: string
  readonly material: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}> {}

export const ledgerValidationError = (
  operation: LedgerValidationOperation,
  reason: LedgerValidationReason,
  message: string,
  material: Readonly<Record<string, unknown>>,
  cause?: unknown,
): LedgerValidationError => new LedgerValidationError({ operation, reason, message, material, cause })

export const failLedgerValidation = (
  operation: LedgerValidationOperation,
  reason: LedgerValidationReason,
  detail: string,
  material: Readonly<Record<string, unknown>>,
  cause?: unknown,
): Result.Result<never, LedgerValidationError> =>
  Result.fail(ledgerValidationError(operation, reason, `TigerBeetle ${operation} failed: ${detail}`, material, cause))

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

export type LedgerPlanAmountField =
  | 'cashYield.amountMicros'
  | 'fee.totalMicros'
  | 'fill.costBasisMicros'
  | 'fill.notionalMicros'
  | 'initialCapitalMicros'

export type LedgerPlanFailureDetail =
  | {
      readonly kind: 'no-fill-events'
      readonly runId: string
      readonly eventCount: number
    }
  | {
      readonly kind: 'amount-parse-failed'
      readonly field: LedgerPlanAmountField
      readonly value: string
      readonly eventId?: string
      readonly cause: unknown
    }
  | {
      readonly kind: 'negative-amount'
      readonly field: Exclude<LedgerPlanAmountField, 'initialCapitalMicros'>
      readonly value: bigint
      readonly eventId: string
    }
  | {
      readonly kind: 'initial-capital-not-positive'
      readonly value: bigint
    }
  | {
      readonly kind: 'inventory-account-missing'
      readonly runId: string
      readonly eventId: string
      readonly symbol: string
    }
  | {
      readonly kind: 'canonicalization-failed'
      readonly operation: 'event-transfer'
      readonly eventId: string
      readonly leg: string
      readonly cause: CanonicalJsonFailure
    }
  | {
      readonly kind: 'input-access-failed'
      readonly field: 'inputManifest.symbols'
      readonly cause: unknown
    }
  | {
      readonly kind: 'single-query-limit-exceeded'
      readonly runId: string
      readonly accountCount: number
      readonly transferCount: number
      readonly limit: number
    }

export type LedgerPlanFailure = LedgerValidationError &
  LedgerPlanFailureDetail & {
    readonly detail: LedgerPlanFailureDetail
  }

export const renderLedgerPlanFailure = (failure: LedgerPlanFailureDetail): string => {
  switch (failure.kind) {
    case 'no-fill-events':
      return 'evaluation produced no fill events to journal'
    case 'amount-parse-failed':
      return `${failure.field} is not an integer micros value: ${failure.value}`
    case 'negative-amount':
      return `${failure.field} must not be negative`
    case 'initial-capital-not-positive':
      return 'initial capital must be positive'
    case 'inventory-account-missing':
      return `missing inventory account for ${failure.symbol}`
    case 'canonicalization-failed':
      return `event ${failure.eventId} ${failure.leg} material is not canonicalizable: ${renderCanonicalJsonFailure(failure.cause)}`
    case 'input-access-failed':
      return `${failure.field} is unavailable`
    case 'single-query-limit-exceeded':
      return 'Bayn ledger run exceeds the exact single-query reconciliation limit'
  }
}

const ledgerPlanCause = (failure: LedgerPlanFailureDetail): unknown => {
  switch (failure.kind) {
    case 'amount-parse-failed':
    case 'canonicalization-failed':
    case 'input-access-failed':
      return failure.cause
    default:
      return failure
  }
}

const makeLedgerPlanFailure = (ledger: number, detail: LedgerPlanFailureDetail): LedgerPlanFailure =>
  Object.assign(
    ledgerValidationError(
      'build-plan',
      'ledger-plan-failure',
      `TigerBeetle build-plan failed: ${renderLedgerPlanFailure(detail)}`,
      { ledger, failure: detail },
      ledgerPlanCause(detail),
    ),
    detail,
    { detail },
  ) as LedgerPlanFailure

const failLedgerPlan = (failure: LedgerPlanFailureDetail): Result.Result<never, LedgerPlanFailureDetail> =>
  Result.fail(failure)

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
): Result.Result<Transfer, LedgerPlanFailureDetail> => {
  const eventHash = canonicalHashV1Result(event)
  if (Result.isFailure(eventHash)) {
    return failLedgerPlan({
      kind: 'canonicalization-failed',
      operation: 'event-transfer',
      eventId,
      leg,
      cause: eventHash.failure,
    })
  }
  return Result.succeed({
    id: stableU128('bayn-transfer-v1', runId, eventId, leg),
    debit_account_id: debitAccountId,
    credit_account_id: creditAccountId,
    amount,
    pending_id: 0n,
    user_data_128: stableU128('bayn-event-v1', eventHash.success),
    user_data_64: runTag,
    user_data_32: LEDGER_SCHEMA_VERSION,
    timeout: 0,
    ledger,
    code,
    flags: 0,
    timestamp: 0n,
  })
}

const parseAmount = (
  field: LedgerPlanAmountField,
  value: string,
  eventId?: string,
): Result.Result<bigint, LedgerPlanFailureDetail> =>
  Result.mapError(
    Result.try(() => BigInt(value)),
    (cause): LedgerPlanFailureDetail => ({
      kind: 'amount-parse-failed',
      field,
      value,
      ...(eventId === undefined ? {} : { eventId }),
      cause,
    }),
  )

const nonNegativeAmount = (
  field: Exclude<LedgerPlanAmountField, 'initialCapitalMicros'>,
  value: string,
  eventId: string,
): Result.Result<bigint, LedgerPlanFailureDetail> =>
  Result.flatMap(parseAmount(field, value, eventId), (parsed) =>
    parsed < 0n ? failLedgerPlan({ kind: 'negative-amount', field, value: parsed, eventId }) : Result.succeed(parsed),
  )

const buildLedgerPlanDecision = (
  result: LedgerInput,
  ledger: number,
): Result.Result<LedgerPlan, LedgerPlanFailureDetail> =>
  Result.gen(function* () {
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
    const inventorySymbols = yield* Result.mapError(
      Result.try(() => result.inputManifest.symbols.map((coverage) => coverage.symbol).sort()),
      (cause): LedgerPlanFailureDetail => ({
        kind: 'input-access-failed',
        field: 'inputManifest.symbols',
        cause,
      }),
    )
    for (const symbol of inventorySymbols) {
      addAccount(`inventory:${symbol}`, AccountCode.inventory)
    }

    const transfers: Transfer[] = []
    const fillEvents = result.events.filter((event): event is FillEvent => event.kind === 'fill')
    if (fillEvents.length === 0) {
      return yield* failLedgerPlan({
        kind: 'no-fill-events',
        runId: result.runId,
        eventCount: result.events.length,
      })
    }
    const startingCapital = yield* parseAmount('initialCapitalMicros', result.initialCapitalMicros)
    if (startingCapital <= 0n) {
      return yield* failLedgerPlan({ kind: 'initial-capital-not-positive', value: startingCapital })
    }
    transfers.push(
      yield* transfer(
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
      if (inventory === undefined) {
        return yield* failLedgerPlan({
          kind: 'inventory-account-missing',
          runId: result.runId,
          eventId: fill.id,
          symbol: fill.symbol,
        })
      }
      const notional = yield* nonNegativeAmount('fill.notionalMicros', fill.notionalMicros, fill.id)
      const costBasis = yield* nonNegativeAmount('fill.costBasisMicros', fill.costBasisMicros, fill.id)
      if (notional === 0n) continue

      if (fill.side === 'buy') {
        transfers.push(
          yield* transfer(
            result.runId,
            runTag,
            ledger,
            fill.id,
            'buy',
            inventory.id,
            cash.id,
            notional,
            TransferCode.buy,
            fill,
          ),
        )
      } else if (notional >= costBasis) {
        if (costBasis > 0n) {
          transfers.push(
            yield* transfer(
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
            yield* transfer(
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
          yield* transfer(
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
          yield* transfer(
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
      const amount = yield* nonNegativeAmount('fee.totalMicros', fee.totalMicros, fee.id)
      if (amount > 0n) {
        transfers.push(
          yield* transfer(result.runId, runTag, ledger, fee.id, 'fee', fees.id, cash.id, amount, TransferCode.fee, fee),
        )
      }
    }
    const cashYieldEvents = result.events.filter((event): event is CashYieldEvent => event.kind === 'cash-yield')
    for (const cashYield of cashYieldEvents) {
      const amount = yield* nonNegativeAmount('cashYield.amountMicros', cashYield.amountMicros, cashYield.id)
      if (amount > 0n) {
        transfers.push(
          yield* transfer(
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
      return yield* failLedgerPlan({
        kind: 'single-query-limit-exceeded',
        runId: result.runId,
        accountCount: accountsByName.size,
        transferCount: transfers.length,
        limit: LEDGER_BATCH_MAX,
      })
    }
    return {
      runKey,
      runTag,
      accounts: [...accountsByName.values()].sort((left, right) => (left.id < right.id ? -1 : 1)),
      transfers: transfers.sort((left, right) => (left.id < right.id ? -1 : 1)),
    }
  })

export const buildLedgerPlan = (result: LedgerInput, ledger: number): Result.Result<LedgerPlan, LedgerPlanFailure> =>
  Result.mapError(buildLedgerPlanDecision(result, ledger), (failure) => makeLedgerPlanFailure(ledger, failure))

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

export const accountMetadataMatches = (actual: Account, expected: Account): boolean =>
  actual.id === expected.id &&
  actual.user_data_128 === expected.user_data_128 &&
  actual.user_data_64 === expected.user_data_64 &&
  actual.user_data_32 === expected.user_data_32 &&
  actual.reserved === expected.reserved &&
  actual.ledger === expected.ledger &&
  actual.code === expected.code &&
  actual.flags === expected.flags

export const transferMetadataMatches = (actual: Transfer, expected: Transfer): boolean =>
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

const duplicateRecordId = <Record extends { readonly id: bigint }>(records: readonly Record[]): bigint | undefined => {
  const ids = new Set<bigint>()
  for (const record of records) {
    if (ids.has(record.id)) return record.id
    ids.add(record.id)
  }
  return undefined
}

const verifyUniqueExact = <Record extends { readonly id: bigint }>(
  operation: LedgerValidationOperation,
  kind: string,
  actual: readonly Record[],
  expected: readonly Record[],
  matches: (actualValue: Record, expectedValue: Record) => boolean,
): Result.Result<void, LedgerValidationError> => {
  const actualDuplicateId = duplicateRecordId(actual)
  const expectedDuplicateId = duplicateRecordId(expected)
  if (actual.length !== expected.length || actualDuplicateId !== undefined || expectedDuplicateId !== undefined) {
    return failLedgerValidation(
      operation,
      'record-set-mismatch',
      `${kind} set mismatch: expected ${expected.length}, received ${actual.length}`,
      {
        kind,
        expectedCount: expected.length,
        actualCount: actual.length,
        ...(actualDuplicateId === undefined ? {} : { duplicateId: actualDuplicateId }),
        ...(expectedDuplicateId === undefined ? {} : { duplicateExpectedId: expectedDuplicateId }),
      },
    )
  }

  const expectedById = new Map(expected.map((value) => [value.id, value]))
  for (const value of actual) {
    const expectedValue = expectedById.get(value.id)
    if (expectedValue === undefined || !matches(value, expectedValue)) {
      return failLedgerValidation(operation, 'record-mismatch', `${kind} ${value.id} does not match its plan`, {
        kind,
        id: value.id,
        actual: value,
        expected: expectedValue,
      })
    }
  }
  return Result.succeed(undefined)
}

export const verifyExactAccounts = (
  operation: LedgerValidationOperation,
  kind: string,
  actual: readonly Account[],
  expected: readonly Account[],
): Result.Result<void, LedgerValidationError> =>
  verifyUniqueExact(operation, kind, actual, expected, accountMetadataMatches)

export const verifyExactTransfers = (
  operation: LedgerValidationOperation,
  kind: string,
  actual: readonly Transfer[],
  expected: readonly Transfer[],
): Result.Result<void, LedgerValidationError> =>
  verifyUniqueExact(operation, kind, actual, expected, transferMetadataMatches)

export const verifyLedgerPlanRecords = (
  operation: LedgerValidationOperation,
  accountKind: string,
  transferKind: string,
  plan: LedgerPlan,
  actualAccounts: readonly Account[],
  actualTransfers: readonly Transfer[],
): Result.Result<void, LedgerValidationError> =>
  Result.gen(function* () {
    yield* verifyExactAccounts(operation, accountKind, actualAccounts, plan.accounts)
    yield* verifyExactTransfers(operation, transferKind, actualTransfers, plan.transfers)
  })

export const preflightTransfers = (
  expected: readonly Transfer[],
  existing: readonly Transfer[],
): Result.Result<readonly Transfer[], LedgerValidationError> => {
  const expectedDuplicateId = duplicateRecordId(expected)
  const existingDuplicateId = duplicateRecordId(existing)
  if (expectedDuplicateId !== undefined || existingDuplicateId !== undefined) {
    return failLedgerValidation(
      'preflight-transfers',
      'record-set-mismatch',
      'transfer preflight contains duplicate deterministic IDs',
      {
        expectedCount: expected.length,
        actualCount: existing.length,
        ...(expectedDuplicateId === undefined ? {} : { duplicateExpectedId: expectedDuplicateId }),
        ...(existingDuplicateId === undefined ? {} : { duplicateId: existingDuplicateId }),
      },
    )
  }

  const expectedById = new Map(expected.map((transfer) => [transfer.id, transfer]))
  const existingIds = new Set<bigint>()
  for (const transfer of existing) {
    const expectedTransfer = expectedById.get(transfer.id)
    if (expectedTransfer === undefined || !transferMetadataMatches(transfer, expectedTransfer)) {
      return failLedgerValidation(
        'preflight-transfers',
        'record-mismatch',
        `existing transfer ${transfer.id} does not match its plan`,
        {
          kind: 'existing transfer',
          id: transfer.id,
          actual: transfer,
          expected: expectedTransfer,
        },
      )
    }
    existingIds.add(transfer.id)
  }

  return Result.succeed(expected.filter((transfer) => !existingIds.has(transfer.id)))
}

interface LedgerBalances {
  readonly accountsById: ReadonlyMap<bigint, Account>
  readonly transfersById: ReadonlyMap<bigint, Transfer>
}

const reconcileBalances = (
  operation: 'check-run' | 'reconcile' | 'verify-account',
  accounts: readonly Account[],
  transfers: readonly Transfer[],
  runId?: string,
): Result.Result<LedgerBalances, LedgerValidationError> => {
  const accountDuplicateId = duplicateRecordId(accounts)
  if (accountDuplicateId !== undefined) {
    return failLedgerValidation(
      operation,
      'duplicate-account',
      runId === undefined
        ? `ledger contains duplicate account ${accountDuplicateId}`
        : `run ${runId} contains duplicate account ${accountDuplicateId}`,
      { ...(runId === undefined ? {} : { runId }), accountId: accountDuplicateId },
    )
  }
  const transferDuplicateId = duplicateRecordId(transfers)
  if (transferDuplicateId !== undefined) {
    return failLedgerValidation(
      operation,
      'duplicate-transfer',
      runId === undefined
        ? `ledger contains duplicate transfer ${transferDuplicateId}`
        : `run ${runId} contains duplicate transfer ${transferDuplicateId}`,
      { ...(runId === undefined ? {} : { runId }), transferId: transferDuplicateId },
    )
  }

  const accountsById = new Map(accounts.map((account) => [account.id, account]))
  const transfersById = new Map(transfers.map((transfer) => [transfer.id, transfer]))
  const balances = new Map(accounts.map((account) => [account.id, { debits: 0n, credits: 0n }]))
  for (const transfer of transfers) {
    const debit = balances.get(transfer.debit_account_id)
    const credit = balances.get(transfer.credit_account_id)
    if (debit === undefined || credit === undefined) {
      return failLedgerValidation(
        operation,
        'unknown-account-reference',
        runId === undefined
          ? `transfer ${transfer.id} references an unknown account`
          : `run ${runId} transfer ${transfer.id} references an account outside the run`,
        {
          ...(runId === undefined ? {} : { runId }),
          transferId: transfer.id,
          debitAccountId: transfer.debit_account_id,
          creditAccountId: transfer.credit_account_id,
        },
      )
    }
    if (transfer.debit_account_id === transfer.credit_account_id) {
      balances.set(transfer.debit_account_id, {
        debits: debit.debits + transfer.amount,
        credits: debit.credits + transfer.amount,
      })
    } else {
      balances.set(transfer.debit_account_id, {
        debits: debit.debits + transfer.amount,
        credits: debit.credits,
      })
      balances.set(transfer.credit_account_id, {
        debits: credit.debits,
        credits: credit.credits + transfer.amount,
      })
    }
  }

  for (const account of accounts) {
    const balance = balances.get(account.id)
    if (balance === undefined) {
      return failLedgerValidation(
        operation,
        'missing-balance',
        runId === undefined
          ? `unexpected account ${account.id}`
          : `run ${runId} has no balance for account ${account.id}`,
        { ...(runId === undefined ? {} : { runId }), accountId: account.id },
      )
    }
    if (
      account.debits_pending !== 0n ||
      account.credits_pending !== 0n ||
      account.debits_posted !== balance.debits ||
      account.credits_posted !== balance.credits
    ) {
      return failLedgerValidation(
        operation,
        'invalid-balance',
        runId === undefined
          ? `account ${account.id} balance does not reconcile exactly`
          : `run ${runId} account ${account.id} balance does not reconcile locally`,
        { ...(runId === undefined ? {} : { runId }), account, expected: balance },
      )
    }
  }
  return Result.succeed({ accountsById, transfersById })
}

export const reconcileLedgerPlan = (
  plan: LedgerPlan,
  actualAccounts: readonly Account[],
  actualTransfers: readonly Transfer[],
  operation: 'reconcile' | 'verify-account' = 'reconcile',
): Result.Result<void, LedgerValidationError> =>
  Result.gen(function* () {
    yield* verifyLedgerPlanRecords(operation, 'account', 'transfer', plan, actualAccounts, actualTransfers)
    yield* reconcileBalances(operation, actualAccounts, actualTransfers)
  })

const fixedAccountNames = new Map<number, string>([
  [AccountCode.cash, 'cash'],
  [AccountCode.equity, 'equity'],
  [AccountCode.realizedGain, 'realized-gain'],
  [AccountCode.cashYieldIncome, 'cash-yield-income'],
  [AccountCode.feeExpense, 'fee-expense'],
  [AccountCode.realizedLoss, 'realized-loss'],
])
const accountCodes = new Set<number>(Object.values(AccountCode))
const transferCodes = new Set<number>(Object.values(TransferCode))
const transferAccountCodes = new Map<number, readonly [number, number]>([
  [TransferCode.funding, [AccountCode.cash, AccountCode.equity]],
  [TransferCode.buy, [AccountCode.inventory, AccountCode.cash]],
  [TransferCode.sellBasis, [AccountCode.cash, AccountCode.inventory]],
  [TransferCode.realizedGain, [AccountCode.cash, AccountCode.realizedGain]],
  [TransferCode.realizedLoss, [AccountCode.realizedLoss, AccountCode.inventory]],
  [TransferCode.fee, [AccountCode.feeExpense, AccountCode.cash]],
  [TransferCode.cashYield, [AccountCode.cash, AccountCode.cashYieldIncome]],
])

const verifyPersistedAccount = (
  result: ReconciliationResult,
  ledger: number,
  runKey: bigint,
  runTag: bigint,
  value: Account,
): Result.Result<void, LedgerValidationError> => {
  const fixedName = fixedAccountNames.get(value.code)
  const expectedId = fixedName === undefined ? undefined : stableU128('bayn-account-v1', result.runId, fixedName)
  if (
    value.id === 0n ||
    value.user_data_128 !== runKey ||
    value.user_data_64 !== runTag ||
    value.user_data_32 !== LEDGER_SCHEMA_VERSION ||
    value.reserved !== 0 ||
    value.ledger !== ledger ||
    !accountCodes.has(value.code) ||
    value.flags !== AccountFlags.history ||
    value.timestamp <= 0n ||
    (expectedId !== undefined && value.id !== expectedId)
  ) {
    return failLedgerValidation(
      'check-run',
      'invalid-account-metadata',
      `run ${result.runId} account ${value.id} has invalid locally verifiable metadata`,
      {
        runId: result.runId,
        account: value,
        expected: {
          runKey,
          runTag,
          schemaVersion: LEDGER_SCHEMA_VERSION,
          reserved: 0,
          ledger,
          accountCodes: [...accountCodes],
          flags: AccountFlags.history,
          positiveTimestamp: true,
          ...(expectedId === undefined ? {} : { deterministicId: expectedId }),
        },
      },
    )
  }
  return Result.succeed(undefined)
}

const verifyPersistedTransfer = (
  result: ReconciliationResult,
  ledger: number,
  runTag: bigint,
  accountsById: ReadonlyMap<bigint, Account>,
  value: Transfer,
): Result.Result<void, LedgerValidationError> => {
  const debit = accountsById.get(value.debit_account_id)
  const credit = accountsById.get(value.credit_account_id)
  const accountCodePair = transferAccountCodes.get(value.code)
  const fundingId = stableU128('bayn-transfer-v1', result.runId, 'funding', 'principal')
  const fundingEventId = stableU128(
    'bayn-event-v1',
    canonicalHashV1({ kind: 'funding', runId: result.runId, amountMicros: value.amount.toString() }),
  )
  if (
    value.id === 0n ||
    value.debit_account_id === value.credit_account_id ||
    value.amount <= 0n ||
    value.pending_id !== 0n ||
    value.user_data_128 === 0n ||
    value.user_data_64 !== runTag ||
    value.user_data_32 !== LEDGER_SCHEMA_VERSION ||
    value.timeout !== 0 ||
    value.ledger !== ledger ||
    !transferCodes.has(value.code) ||
    value.flags !== 0 ||
    value.timestamp <= 0n ||
    debit === undefined ||
    credit === undefined ||
    accountCodePair === undefined ||
    debit.code !== accountCodePair[0] ||
    credit.code !== accountCodePair[1] ||
    (value.code === TransferCode.funding && (value.id !== fundingId || value.user_data_128 !== fundingEventId))
  ) {
    return failLedgerValidation(
      'check-run',
      'invalid-transfer-metadata',
      `run ${result.runId} transfer ${value.id} has invalid locally verifiable metadata`,
      {
        runId: result.runId,
        transfer: value,
        expected: {
          runTag,
          schemaVersion: LEDGER_SCHEMA_VERSION,
          pendingId: 0n,
          timeout: 0,
          ledger,
          transferCodes: [...transferCodes],
          flags: 0,
          positiveTimestamp: true,
          accountCodePair,
          ...(value.code === TransferCode.funding
            ? { deterministicId: fundingId, deterministicEventId: fundingEventId }
            : {}),
        },
      },
    )
  }
  return Result.succeed(undefined)
}

/**
 * Validates only invariants recoverable from a persisted reconciliation receipt and TigerBeetle records.
 * Inventory symbols and event-derived IDs and hashes other than funding are not persisted in those inputs; they require
 * the original expected plan and are checked by reconcileLedgerPlan instead.
 */
export const validatePersistedRunEvidence = (
  result: ReconciliationResult,
  ledger: number,
  accounts: readonly Account[],
  transfers: readonly Transfer[],
): Result.Result<void, LedgerValidationError> =>
  Result.gen(function* () {
    if (accounts.length !== result.accountCount) {
      return yield* failLedgerValidation(
        'check-run',
        'run-count-mismatch',
        `run ${result.runId} has ${accounts.length} accounts; expected ${result.accountCount}`,
        {
          runId: result.runId,
          kind: 'account',
          actualCount: accounts.length,
          expectedCount: result.accountCount,
        },
      )
    }
    if (transfers.length !== result.transferCount) {
      return yield* failLedgerValidation(
        'check-run',
        'run-count-mismatch',
        `run ${result.runId} has ${transfers.length} transfers; expected ${result.transferCount}`,
        {
          runId: result.runId,
          kind: 'transfer',
          actualCount: transfers.length,
          expectedCount: result.transferCount,
        },
      )
    }

    const runKey = stableU128('bayn-run-v1', result.runId)
    const runTag = stableU64('bayn-run-v1', result.runId)
    const reconciled = yield* reconcileBalances('check-run', accounts, transfers, result.runId)
    for (const account of accounts) {
      yield* verifyPersistedAccount(result, ledger, runKey, runTag, account)
    }
    if (accounts.length > 0) {
      for (const [code, name] of fixedAccountNames) {
        const expectedId = stableU128('bayn-account-v1', result.runId, name)
        const persistedAccount = reconciled.accountsById.get(expectedId)
        if (persistedAccount === undefined) {
          return yield* failLedgerValidation(
            'check-run',
            'record-set-mismatch',
            `run ${result.runId} is missing required ${name} account`,
            { runId: result.runId, kind: 'account', code, expectedId },
          )
        }
        if (persistedAccount.code !== code) {
          return yield* failLedgerValidation(
            'check-run',
            'invalid-account-metadata',
            `run ${result.runId} required ${name} account has code ${persistedAccount.code}; expected ${code}`,
            {
              runId: result.runId,
              account: persistedAccount,
              expected: { deterministicId: expectedId, code },
            },
          )
        }
      }
    }
    for (const transfer of transfers) {
      yield* verifyPersistedTransfer(result, ledger, runTag, reconciled.accountsById, transfer)
    }
    const fundingId = stableU128('bayn-transfer-v1', result.runId, 'funding', 'principal')
    if (transfers.length > 0 && !reconciled.transfersById.has(fundingId)) {
      return yield* failLedgerValidation(
        'check-run',
        'record-set-mismatch',
        `run ${result.runId} is missing its deterministic funding transfer`,
        { runId: result.runId, kind: 'transfer', code: TransferCode.funding, expectedId: fundingId },
      )
    }
  })
