import { Result } from 'effect'

import { canonicalHashV1Result, stableU128, stableU64 } from '../hash'
import type { DecodedLedgerInput } from './input'
import {
  AccountCode,
  failLedgerPlan,
  LEDGER_ACCOUNT_HISTORY_FLAG,
  LEDGER_BATCH_MAX,
  LEDGER_SCHEMA_VERSION,
  TransferCode,
  type EvaluationLedgerPlan,
  type LedgerAccountRecord,
  type LedgerPlanAmountField,
  type LedgerPlanFailureDetail,
  type LedgerTransferRecord,
} from './model'

const makeAccount = (
  runId: string,
  runKey: bigint,
  runTag: bigint,
  ledger: number,
  name: string,
  code: number,
): LedgerAccountRecord => ({
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
  flags: LEDGER_ACCOUNT_HISTORY_FLAG,
  timestamp: 0n,
})

const makeTransfer = (
  runId: string,
  runTag: bigint,
  ledger: number,
  eventId: string,
  leg: string,
  debitAccountId: bigint,
  creditAccountId: bigint,
  amount: bigint,
  code: number,
  eventHash: string,
): LedgerTransferRecord => ({
  id: stableU128('bayn-transfer-v1', runId, eventId, leg),
  debit_account_id: debitAccountId,
  credit_account_id: creditAccountId,
  amount,
  pending_id: 0n,
  user_data_128: stableU128('bayn-event-v1', eventHash),
  user_data_64: runTag,
  user_data_32: LEDGER_SCHEMA_VERSION,
  timeout: 0,
  ledger,
  code,
  flags: 0,
  timestamp: 0n,
})

const hashTransferEvent = (
  eventId: string,
  leg: string,
  event: unknown,
): Result.Result<string, LedgerPlanFailureDetail> =>
  Result.mapError(
    canonicalHashV1Result(event),
    (cause): LedgerPlanFailureDetail => ({
      kind: 'canonicalization-failed',
      canonicalizationOperation: 'event-transfer',
      eventId,
      leg,
      cause,
    }),
  )

const requireNonNegative = (
  field: Exclude<LedgerPlanAmountField, 'initialCapitalMicros'>,
  value: bigint,
  eventId: string,
): Result.Result<bigint, LedgerPlanFailureDetail> =>
  value < 0n ? failLedgerPlan({ kind: 'negative-amount', field, value, eventId }) : Result.succeed(value)

export const planDecodedLedgerInput = (
  input: DecodedLedgerInput,
  ledger: number,
): Result.Result<EvaluationLedgerPlan, LedgerPlanFailureDetail> =>
  Result.gen(function* () {
    const runKey = stableU128('bayn-run-v1', input.runId)
    const runTag = stableU64('bayn-run-v1', input.runId)
    const accountsByName = new Map<string, LedgerAccountRecord>()
    const addAccount = (name: string, code: number): LedgerAccountRecord => {
      const account = makeAccount(input.runId, runKey, runTag, ledger, name, code)
      accountsByName.set(name, account)
      return account
    }
    const cash = addAccount('cash', AccountCode.cash)
    const equity = addAccount('equity', AccountCode.equity)
    const fees = addAccount('fee-expense', AccountCode.feeExpense)
    const cashYieldIncome = addAccount('cash-yield-income', AccountCode.cashYieldIncome)
    const realizedGain = addAccount('realized-gain', AccountCode.realizedGain)
    const realizedLoss = addAccount('realized-loss', AccountCode.realizedLoss)
    for (const symbol of input.inventorySymbols.toSorted()) addAccount(`inventory:${symbol}`, AccountCode.inventory)

    if (input.fills.length === 0) {
      return yield* failLedgerPlan({ kind: 'no-fill-events', runId: input.runId, eventCount: input.eventCount })
    }
    if (input.initialCapitalMicros <= 0n) {
      return yield* failLedgerPlan({ kind: 'initial-capital-not-positive', value: input.initialCapitalMicros })
    }

    const fundingEventHash = yield* hashTransferEvent('funding', 'principal', {
      kind: 'funding',
      runId: input.runId,
      amountMicros: input.initialCapitalMicros.toString(),
    })
    const transfers: LedgerTransferRecord[] = [
      makeTransfer(
        input.runId,
        runTag,
        ledger,
        'funding',
        'principal',
        cash.id,
        equity.id,
        input.initialCapitalMicros,
        TransferCode.funding,
        fundingEventHash,
      ),
    ]

    for (const fill of input.fills) {
      const inventory = accountsByName.get(`inventory:${fill.symbol}`)
      if (inventory === undefined) {
        return yield* failLedgerPlan({
          kind: 'inventory-account-missing',
          runId: input.runId,
          eventId: fill.id,
          symbol: fill.symbol,
        })
      }
      const notional = yield* requireNonNegative('fill.notionalMicros', fill.notionalMicros, fill.id)
      const costBasis = yield* requireNonNegative('fill.costBasisMicros', fill.costBasisMicros, fill.id)
      if (notional === 0n) continue
      const firstLeg =
        fill.side === 'buy'
          ? 'buy'
          : notional < costBasis
            ? 'sell-proceeds'
            : costBasis > 0n
              ? 'sell-basis'
              : 'realized-gain'
      const eventHash = yield* hashTransferEvent(fill.id, firstLeg, fill.event)

      if (fill.side === 'buy') {
        transfers.push(
          makeTransfer(
            input.runId,
            runTag,
            ledger,
            fill.id,
            'buy',
            inventory.id,
            cash.id,
            notional,
            TransferCode.buy,
            eventHash,
          ),
        )
      } else if (notional >= costBasis) {
        if (costBasis > 0n) {
          transfers.push(
            makeTransfer(
              input.runId,
              runTag,
              ledger,
              fill.id,
              'sell-basis',
              cash.id,
              inventory.id,
              costBasis,
              TransferCode.sellBasis,
              eventHash,
            ),
          )
        }
        if (notional > costBasis) {
          transfers.push(
            makeTransfer(
              input.runId,
              runTag,
              ledger,
              fill.id,
              'realized-gain',
              cash.id,
              realizedGain.id,
              notional - costBasis,
              TransferCode.realizedGain,
              eventHash,
            ),
          )
        }
      } else {
        transfers.push(
          makeTransfer(
            input.runId,
            runTag,
            ledger,
            fill.id,
            'sell-proceeds',
            cash.id,
            inventory.id,
            notional,
            TransferCode.sellBasis,
            eventHash,
          ),
        )
        transfers.push(
          makeTransfer(
            input.runId,
            runTag,
            ledger,
            fill.id,
            'realized-loss',
            realizedLoss.id,
            inventory.id,
            costBasis - notional,
            TransferCode.realizedLoss,
            eventHash,
          ),
        )
      }
    }

    for (const fee of input.fees) {
      const amount = yield* requireNonNegative('fee.totalMicros', fee.totalMicros, fee.id)
      if (amount > 0n) {
        const eventHash = yield* hashTransferEvent(fee.id, 'fee', fee.event)
        transfers.push(
          makeTransfer(
            input.runId,
            runTag,
            ledger,
            fee.id,
            'fee',
            fees.id,
            cash.id,
            amount,
            TransferCode.fee,
            eventHash,
          ),
        )
      }
    }
    for (const cashYield of input.cashYields) {
      const amount = yield* requireNonNegative('cashYield.amountMicros', cashYield.amountMicros, cashYield.id)
      if (amount > 0n) {
        const eventHash = yield* hashTransferEvent(cashYield.id, 'cash-yield', cashYield.event)
        transfers.push(
          makeTransfer(
            input.runId,
            runTag,
            ledger,
            cashYield.id,
            'cash-yield',
            cash.id,
            cashYieldIncome.id,
            amount,
            TransferCode.cashYield,
            eventHash,
          ),
        )
      }
    }

    if (accountsByName.size >= LEDGER_BATCH_MAX || transfers.length >= LEDGER_BATCH_MAX) {
      return yield* failLedgerPlan({
        kind: 'single-query-limit-exceeded',
        runId: input.runId,
        accountCount: accountsByName.size,
        transferCount: transfers.length,
        limit: LEDGER_BATCH_MAX,
      })
    }
    return {
      runId: input.runId,
      runKey,
      runTag,
      accounts: [...accountsByName.values()].sort((left, right) => (left.id < right.id ? -1 : 1)),
      transfers: transfers.sort((left, right) => (left.id < right.id ? -1 : 1)),
    }
  })
