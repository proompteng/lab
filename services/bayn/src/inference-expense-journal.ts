import { Effect } from 'effect'

import { stableU128, stableU64 } from './hash'
import { InferenceCostError } from './inference-costs'
import {
  buildInferenceExpensePlan,
  inferenceExpenseLedger,
  inferenceExpenseScope,
  type InferenceExpensePlan,
  type InferenceExpenseQuote,
  type InferenceExpenseRecord,
  type InferenceExpenseSnapshot,
} from './inference-expense'
import { createAndVerifyAccounts, createAndVerifyTransfers } from './ledger'
import { verifyExactAccounts, verifyExactTransfers } from './ledger-plan/verification'
import {
  LEDGER_BATCH_MAX,
  LedgerAccountFilterFlag,
  type LedgerAccountFilter,
  type LedgerTransferRecord,
} from './ledger-plan/model'
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

/** Verify a complete native ledger prefix, then attribute only the captured source quotes. */
export const readInferenceExpenseLedger = <E, R>(
  client: TigerBeetleRequestClient,
  snapshot: InferenceExpenseSnapshot,
  readCurrentQuotes: Effect.Effect<readonly InferenceExpenseRecord[], E, R>,
) =>
  Effect.gen(function* () {
    const { accountBindingHash, sessionDate, asOf } = snapshot.evidence
    const quotes = snapshot.quotes.map((row) => row.quote)
    if (quotes.some((quote) => quote.accountBindingHash !== accountBindingHash || quote.sessionDate !== sessionDate))
      return yield* new InferenceCostError({ message: 'Inference expense read mixes account or session scopes' })
    const sourcePlan = yield* Effect.fromResult(buildInferenceExpensePlan(quotes))
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
    const accountQuery = { ...base, user_data_128: stableU128(scope), limit: 3 }
    const initialAccounts = yield* client.request('read-inference-expense-session-accounts', (active) =>
      active.queryAccounts(accountQuery),
    )
    const accountFilter = (id: bigint, timestampMax: bigint): LedgerAccountFilter => ({
      account_id: id,
      user_data_128: 0n,
      user_data_64: 0n,
      user_data_32: 0,
      code: 0,
      timestamp_min: 0n,
      timestamp_max: timestampMax,
      limit: 1,
      flags: LedgerAccountFilterFlag.Debits | LedgerAccountFilterFlag.Credits | LedgerAccountFilterFlag.Reversed,
    })
    const lastTransfer = (id: bigint) =>
      client
        .request('read-inference-expense-account-head', (active) => active.getAccountTransfers(accountFilter(id, 0n)))
        .pipe(
          Effect.flatMap((rows) =>
            rows.length > 1 || rows.some((row) => row.timestamp === 0n)
              ? Effect.fail(new InferenceCostError({ message: 'Inference expense account head is invalid' }))
              : Effect.succeed(rows[0]),
          ),
        )
    let timestampMax = 1n
    for (const account of initialAccounts) {
      if (account.timestamp === 0n)
        return yield* new InferenceCostError({ message: 'Inference expense account timestamp is invalid' })
      if (account.timestamp > timestampMax) timestampMax = account.timestamp
      const head = yield* lastTransfer(account.id)
      if (head !== undefined && head.timestamp > timestampMax) timestampMax = head.timestamp
    }
    const transfers: LedgerTransferRecord[] = []
    let minimum = 0n
    while (true) {
      const limit = Math.min(LEDGER_BATCH_MAX, 10_001 - transfers.length)
      const page = yield* client.request('read-inference-expense-session-transfers', (active) =>
        active.queryTransfers({ ...base, timestamp_min: minimum, timestamp_max: timestampMax, limit }),
      )
      if (page.length > limit)
        return yield* new InferenceCostError({ message: 'Inference expense ledger returned an oversized page' })
      let prior = minimum - 1n
      for (const transfer of page) {
        if (
          transfer.timestamp <= prior ||
          transfer.timestamp < minimum ||
          transfer.timestamp > timestampMax ||
          transfer.timestamp === 0n
        )
          return yield* new InferenceCostError({ message: 'Inference expense ledger pagination is not ordered' })
        prior = transfer.timestamp
        transfers.push(transfer)
      }
      if (transfers.length > 10_000)
        return yield* new InferenceCostError({ message: 'Inference expense ledger exceeds the complete-report limit' })
      if (page.length < limit) break
      minimum = prior + 1n
    }
    // Quotes commit before posting. A later read can identify every owner at the pinned native cut.
    const current = yield* readCurrentQuotes
    if (
      current.some(({ quote }) => quote.accountBindingHash !== accountBindingHash || quote.sessionDate !== sessionDate)
    )
      return yield* new InferenceCostError({ message: 'Inference expense owners mix account or session scopes' })
    const currentHashes = new Set(current.map(({ quote }) => quote.quoteHash))
    if (quotes.some((quote) => !currentHashes.has(quote.quoteHash)))
      return yield* new InferenceCostError({ message: 'Captured inference expense quote is no longer present' })
    const plan = yield* Effect.fromResult(buildInferenceExpensePlan(current.map(({ quote }) => quote)))
    const acknowledged = yield* Effect.fromResult(
      buildInferenceExpensePlan(current.filter((row) => row.verifiedAt !== null).map((row) => row.quote)),
    )
    const lookedUpTransfers: LedgerTransferRecord[] = []
    for (let offset = 0; offset < plan.transfers.length; offset += LEDGER_BATCH_MAX) {
      const batch = plan.transfers.slice(offset, offset + LEDGER_BATCH_MAX)
      const actual = yield* client.request('read-inference-expense-owner-transfers', (active) =>
        active.lookupTransfers(batch.map((row) => row.id)),
      )
      lookedUpTransfers.push(...actual)
    }
    const lookedUpIds = new Set(lookedUpTransfers.map((row) => row.id))
    yield* Effect.fromResult(
      verifyExactTransfers(
        'verify-account',
        'inference expense owner transfer',
        lookedUpTransfers,
        plan.transfers.filter((row) => lookedUpIds.has(row.id)),
      ),
    )
    const acknowledgedIds = new Set(acknowledged.transfers.map((row) => row.id))
    yield* Effect.fromResult(
      verifyExactTransfers(
        'verify-account',
        'acknowledged inference expense transfer',
        lookedUpTransfers.filter((row) => acknowledgedIds.has(row.id)),
        acknowledged.transfers,
      ),
    )
    if (lookedUpTransfers.some((row) => row.timestamp === 0n))
      return yield* new InferenceCostError({ message: 'Inference expense transfer timestamp is invalid' })
    yield* Effect.fromResult(
      verifyExactTransfers(
        'verify-account',
        'inference expense session transfer',
        transfers,
        lookedUpTransfers.filter((row) => row.timestamp <= timestampMax),
      ),
    )
    const lookupAccounts = yield* client.request('read-inference-expense-owner-accounts', (active) =>
      active.lookupAccounts(plan.accounts.map((row) => row.id)),
    )
    const lookupAccountIds = new Set(lookupAccounts.map((row) => row.id))
    yield* Effect.fromResult(
      verifyExactAccounts(
        'verify-account',
        'inference expense owner account',
        lookupAccounts,
        plan.accounts.filter((row) => lookupAccountIds.has(row.id)),
      ),
    )
    const acknowledgedAccountIds = new Set(acknowledged.accounts.map((row) => row.id))
    yield* Effect.fromResult(
      verifyExactAccounts(
        'verify-account',
        'acknowledged inference expense account',
        lookupAccounts.filter((row) => acknowledgedAccountIds.has(row.id)),
        acknowledged.accounts,
      ),
    )
    if (lookupAccounts.some((row) => row.timestamp === 0n))
      return yield* new InferenceCostError({ message: 'Inference expense account timestamp is invalid' })
    const accounts = yield* client.request('read-inference-expense-cut-accounts', (active) =>
      active.queryAccounts({ ...accountQuery, timestamp_max: timestampMax }),
    )
    const expectedAccountIds = new Set(
      lookupAccounts.filter((row) => row.timestamp <= timestampMax).map((row) => row.id),
    )
    yield* Effect.fromResult(
      verifyExactAccounts(
        'verify-account',
        'inference expense session account',
        accounts,
        plan.accounts.filter((row) => expectedAccountIds.has(row.id)),
      ),
    )
    for (const account of accounts) {
      let debit = 0n
      let credit = 0n
      let latest = 0n
      for (const transfer of transfers) {
        if (transfer.debit_account_id === account.id) {
          debit += transfer.amount
          latest = transfer.timestamp
        }
        if (transfer.credit_account_id === account.id) {
          credit += transfer.amount
          latest = transfer.timestamp
        }
      }
      const balances = yield* client.request('read-inference-expense-cut-balances', (active) =>
        active.getAccountBalances(accountFilter(account.id, timestampMax)),
      )
      const balance = balances[0]
      if (
        balances.length > 1 ||
        (latest === 0n ? balances.length !== 0 : balance === undefined || balance.timestamp !== latest) ||
        (balance !== undefined &&
          (balance.debits_pending !== 0n ||
            balance.credits_pending !== 0n ||
            balance.debits_posted !== debit ||
            balance.credits_posted !== credit))
      )
        return yield* new InferenceCostError({
          message: 'Inference expense session balances differ from its exact transfer cut',
        })
      const currentAccount = lookupAccounts.find((row) => row.id === account.id)
      const head = yield* lastTransfer(account.id)
      if (
        currentAccount !== undefined &&
        (head === undefined || head.timestamp <= timestampMax) &&
        (currentAccount.debits_pending !== 0n ||
          currentAccount.credits_pending !== 0n ||
          currentAccount.debits_posted !== debit ||
          currentAccount.credits_posted !== credit)
      )
        return yield* new InferenceCostError({
          message: 'Inference expense current balances differ from the unchanged cut',
        })
    }
    const byId = new Map(transfers.map((row) => [row.id, row]))
    const sourceAcknowledged = yield* Effect.fromResult(
      buildInferenceExpensePlan(snapshot.quotes.filter((row) => row.verifiedAt !== null).map((row) => row.quote)),
    )
    const sourceAcknowledgedIds = new Set(sourceAcknowledged.transfers.map((row) => row.id))
    const sourceAcknowledgedAccountIds = new Set(sourceAcknowledged.accounts.map((row) => row.id))
    yield* Effect.fromResult(
      verifyExactAccounts(
        'verify-account',
        'captured acknowledged inference expense account',
        accounts.filter((row) => sourceAcknowledgedAccountIds.has(row.id)),
        sourceAcknowledged.accounts,
      ),
    )
    yield* Effect.fromResult(
      verifyExactTransfers(
        'verify-account',
        'captured acknowledged inference expense transfer',
        transfers.filter((row) => sourceAcknowledgedIds.has(row.id)),
        sourceAcknowledged.transfers,
      ),
    )
    const sourceTransfers = sourcePlan.transfers.flatMap((row) => {
      const actual = byId.get(row.id)
      return actual === undefined ? [] : [actual]
    })
    const byRequest = new Map<string, InferenceExpenseQuote>()
    for (const quote of quotes) {
      const prior = byRequest.get(quote.line.requestId)
      if (prior === undefined || quote.line.receiptHash !== null) byRequest.set(quote.line.requestId, quote)
    }
    const selected = [...byRequest.values()]
    return {
      schemaVersion: 'bayn.inference-expense-ledger-report.v2' as const,
      accountBindingHash,
      sessionDate,
      sourceAsOf: asOf,
      ledgerTimestampMax: timestampMax.toString(),
      verifiedSessionTransferCount: transfers.length,
      ledger: inferenceExpenseLedger,
      unit: 'USD_PICO' as const,
      invoiceReconciled: false as const,
      exactLedgerPrefix: true as const,
      quotedRequestCount: selected.length,
      pricedRequestCount: selected.filter((quote) => quote.line.estimatedCostPicoUsd !== null).length,
      gapRequestCount: selected.filter((quote) => quote.line.estimatedCostPicoUsd === null).length,
      transferCount: sourceTransfers.length,
      knownEstimatedCostPicoUsd: sourceTransfers.reduce((total, transfer) => total + transfer.amount, 0n).toString(),
    }
  })
