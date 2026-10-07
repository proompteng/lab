import { Effect } from 'effect'

import { stableU128, stableU64 } from './hash'
import { InferenceCostError } from './inference-costs'
import {
  buildInferenceExpensePlan,
  inferenceExpenseLedger,
  inferenceExpenseScope,
  type InferenceExpensePlan,
  type InferenceExpenseQuote,
} from './inference-expense'
import { createAndVerifyAccounts, createAndVerifyTransfers } from './ledger'
import { verifyExactAccounts, verifyExactTransfers } from './ledger-plan/verification'
import { LEDGER_BATCH_MAX, type LedgerTransferRecord } from './ledger-plan/model'
import type { TigerBeetleRequestClient } from './tigerbeetle-client'

export const postInferenceExpenses = (client: TigerBeetleRequestClient, plan: InferenceExpensePlan) =>
  Effect.gen(function* () {
    if (plan.accounts.length > 0) yield* createAndVerifyAccounts(client, plan.accounts)
    if (plan.transfers.length > 0) {
      yield* createAndVerifyTransfers(client, plan.transfers)
      const actual = yield* client.request('verify-inference-expense-transfers', (active) =>
        active.lookupTransfers(plan.transfers.map((transfer) => transfer.id)),
      )
      yield* Effect.fromResult(
        verifyExactTransfers('verify-posted-plan', 'inference expense transfer', actual, plan.transfers),
      )
    }
    if (plan.accounts.length > 0) {
      const actual = yield* client.request('verify-inference-expense-accounts', (active) =>
        active.lookupAccounts(plan.accounts.map((account) => account.id)),
      )
      yield* Effect.fromResult(
        verifyExactAccounts('verify-posted-plan', 'inference expense account', actual, plan.accounts),
      )
    }
  })

/** Read the entire scoped ledger. A matching subset never proves reconciliation. */
export const readInferenceExpenseLedger = (
  client: TigerBeetleRequestClient,
  accountBindingHash: string,
  sessionDate: string,
  quotes: readonly InferenceExpenseQuote[],
) =>
  Effect.gen(function* () {
    if (quotes.some((quote) => quote.accountBindingHash !== accountBindingHash || quote.sessionDate !== sessionDate))
      return yield* new InferenceCostError({ message: 'Inference expense read mixes account or session scopes' })
    const plan = yield* Effect.fromResult(buildInferenceExpensePlan(quotes))
    const scope = inferenceExpenseScope(accountBindingHash, sessionDate)
    const base = {
      user_data_128: 0n,
      user_data_64: stableU64(scope),
      user_data_32: 0,
      ledger: inferenceExpenseLedger,
      code: 0,
      timestamp_min: 0n,
      timestamp_max: 0n,
      limit: LEDGER_BATCH_MAX,
      flags: 0,
    }
    const accounts = yield* client.request('read-inference-expense-session-accounts', (active) =>
      active.queryAccounts({ ...base, user_data_128: stableU128(scope), limit: plan.accounts.length + 1 }),
    )
    const transfers: LedgerTransferRecord[] = []
    let minimum = 0n
    while (true) {
      const limit = Math.min(LEDGER_BATCH_MAX, 10_001 - transfers.length)
      const page = yield* client.request('read-inference-expense-session-transfers', (active) =>
        active.queryTransfers({ ...base, timestamp_min: minimum, limit }),
      )
      if (page.length > limit)
        return yield* new InferenceCostError({ message: 'Inference expense ledger returned an oversized page' })
      let prior = minimum - 1n
      for (const transfer of page) {
        if (transfer.timestamp <= prior || transfer.timestamp < minimum || transfer.timestamp === 0n)
          return yield* new InferenceCostError({ message: 'Inference expense ledger pagination is not ordered' })
        prior = transfer.timestamp
        transfers.push(transfer)
      }
      if (transfers.length > 10_000)
        return yield* new InferenceCostError({ message: 'Inference expense ledger exceeds the complete-report limit' })
      if (page.length < limit) break
      minimum = prior + 1n
    }
    yield* Effect.fromResult(
      verifyExactAccounts('verify-account', 'inference expense session account', accounts, plan.accounts),
    )
    yield* Effect.fromResult(
      verifyExactTransfers('verify-account', 'inference expense session transfer', transfers, plan.transfers),
    )
    for (const account of accounts) {
      let debit = 0n
      let credit = 0n
      for (const transfer of transfers) {
        if (transfer.debit_account_id === account.id) debit += transfer.amount
        if (transfer.credit_account_id === account.id) credit += transfer.amount
      }
      if (
        account.debits_pending !== 0n ||
        account.credits_pending !== 0n ||
        account.debits_posted !== debit ||
        account.credits_posted !== credit
      )
        return yield* new InferenceCostError({
          message: 'Inference expense session balances differ from its exact transfers',
        })
    }
    const byRequest = new Map<string, InferenceExpenseQuote>()
    for (const quote of quotes) {
      const prior = byRequest.get(quote.line.requestId)
      if (prior === undefined || quote.line.receiptHash !== null) byRequest.set(quote.line.requestId, quote)
    }
    const current = [...byRequest.values()]
    return {
      schemaVersion: 'bayn.inference-expense-ledger-report.v1' as const,
      accountBindingHash,
      sessionDate,
      ledger: inferenceExpenseLedger,
      unit: 'USD_PICO' as const,
      invoiceReconciled: false as const,
      exactQuotedLedger: true as const,
      quotedRequestCount: current.length,
      pricedRequestCount: current.filter((quote) => quote.line.estimatedCostPicoUsd !== null).length,
      gapRequestCount: current.filter((quote) => quote.line.estimatedCostPicoUsd === null).length,
      transferCount: transfers.length,
      knownEstimatedCostPicoUsd: transfers.reduce((total, transfer) => total + transfer.amount, 0n).toString(),
    }
  })
