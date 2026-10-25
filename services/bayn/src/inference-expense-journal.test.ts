import { describe, expect, test } from 'bun:test'
import { Cause, Effect, Exit, Result } from 'effect'
import { ConnectionError, SqlError } from 'effect/sql/SqlError'
import { CreateAccountStatus, CreateTransferStatus } from 'tigerbeetle-node'

import { buildInferenceExpensePlan, makeInferenceExpenseQuote, type InferenceExpenseQuote } from './inference-expense'
import { postInferenceExpenses, readInferenceExpenseLedger } from './inference-expense-journal'
import { runInferenceExpensePass } from './inference-expense-runtime'
import { expenseRateFixture, expenseSourceFixture } from './inference-expense.test-support'
import { TigerBeetleTransportError, type TigerBeetleClient, type TigerBeetleRequestClient } from './tigerbeetle-client'
import {
  LedgerAccountFilterFlag,
  type LedgerAccountBalance,
  type LedgerAccountRecord,
  type LedgerQueryFilter,
  type LedgerTransferRecord,
} from './ledger-plan/model'

const quote = Result.getOrThrow(makeInferenceExpenseQuote(expenseSourceFixture(), expenseRateFixture))
const plan = Result.getOrThrow(buildInferenceExpensePlan([quote]))
const rows = (quotes: readonly InferenceExpenseQuote[]) =>
  quotes.map((quote) => ({ quote, verifiedAt: '1970-01-01T00:01:00.000Z' }))
const snapshot = (quotes: readonly InferenceExpenseQuote[]) => ({
  evidence: {
    accountBindingHash: quote.accountBindingHash,
    sessionDate: quote.sessionDate,
    asOf: '1970-01-01T00:02:00.000Z',
  },
  quotes: rows(quotes),
})
const expectFailure = async <A, E>(operation: Effect.Effect<A, E>, message: string) => {
  const exit = await Effect.runPromiseExit(operation)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(message)
}
const memoryLedger = () => {
  const accounts = new Map<bigint, LedgerAccountRecord>()
  const transfers = new Map<bigint, LedgerTransferRecord>()
  const history = new Map<bigint, LedgerAccountBalance[]>()
  let timestamp = 0n
  let loseAck = false
  const match = (record: LedgerAccountRecord | LedgerTransferRecord, filter: LedgerQueryFilter) =>
    record.ledger === filter.ledger &&
    record.timestamp >= filter.timestamp_min &&
    (filter.timestamp_max === 0n || record.timestamp <= filter.timestamp_max) &&
    (filter.user_data_128 === 0n || record.user_data_128 === filter.user_data_128) &&
    (filter.user_data_64 === 0n || record.user_data_64 === filter.user_data_64) &&
    (filter.user_data_32 === 0 || record.user_data_32 === filter.user_data_32) &&
    (filter.code === 0 || record.code === filter.code)
  const native: TigerBeetleClient = {
    createAccounts: async (batch) =>
      batch.map((account) => {
        const existing = accounts.has(account.id)
        if (!existing) accounts.set(account.id, { ...account, timestamp: ++timestamp })
        return {
          outcome: existing ? 'exists' : 'created',
          status: existing ? CreateAccountStatus.exists : CreateAccountStatus.created,
          timestamp,
        }
      }),
    createTransfers: async (batch) => {
      const results = batch.map((transfer) => {
        const existing = transfers.has(transfer.id)
        if (!existing) {
          const debit = accounts.get(transfer.debit_account_id)
          const credit = accounts.get(transfer.credit_account_id)
          if (debit === undefined || credit === undefined) throw new Error('synthetic missing account')
          accounts.set(debit.id, { ...debit, debits_posted: debit.debits_posted + transfer.amount })
          accounts.set(credit.id, { ...credit, credits_posted: credit.credits_posted + transfer.amount })
          transfers.set(transfer.id, { ...transfer, timestamp: ++timestamp })
          for (const id of [debit.id, credit.id]) {
            const updated = accounts.get(id)
            if (updated === undefined) throw new Error('synthetic account is absent')
            history.set(id, [...(history.get(id) ?? []), { ...updated, timestamp }])
          }
        }
        return {
          outcome: existing ? ('exists' as const) : ('created' as const),
          status: existing ? CreateTransferStatus.exists : CreateTransferStatus.created,
          timestamp,
        }
      })
      if (loseAck) {
        loseAck = false
        throw new Error('synthetic acknowledgement lost after commit')
      }
      return results
    },
    lookupAccounts: async (ids) =>
      ids.flatMap((id) => {
        const value = accounts.get(id)
        return value === undefined ? [] : [value]
      }),
    lookupTransfers: async (ids) =>
      ids.flatMap((id) => {
        const value = transfers.get(id)
        return value === undefined ? [] : [value]
      }),
    queryAccounts: async (filter) =>
      [...accounts.values()].filter((account) => match(account, filter)).slice(0, filter.limit),
    queryTransfers: async (filter) =>
      [...transfers.values()].filter((transfer) => match(transfer, filter)).slice(0, filter.limit),
    getAccountTransfers: async (filter) => {
      const found = [...transfers.values()]
        .filter(
          (row) =>
            (((filter.flags & LedgerAccountFilterFlag.Debits) !== 0 && row.debit_account_id === filter.account_id) ||
              ((filter.flags & LedgerAccountFilterFlag.Credits) !== 0 &&
                row.credit_account_id === filter.account_id)) &&
            row.timestamp >= filter.timestamp_min &&
            (filter.timestamp_max === 0n || row.timestamp <= filter.timestamp_max),
        )
        .toSorted((a, b) => (a.timestamp < b.timestamp ? -1 : 1))
      return ((filter.flags & LedgerAccountFilterFlag.Reversed) !== 0 ? found.reverse() : found).slice(0, filter.limit)
    },
    getAccountBalances: async (filter) => {
      const found = (history.get(filter.account_id) ?? []).filter(
        (row) =>
          row.timestamp >= filter.timestamp_min &&
          (filter.timestamp_max === 0n || row.timestamp <= filter.timestamp_max),
      )
      return ((filter.flags & LedgerAccountFilterFlag.Reversed) !== 0 ? found.toReversed() : found).slice(
        0,
        filter.limit,
      )
    },
    destroy: () => undefined,
  }
  const client: TigerBeetleRequestClient = {
    request: (operation, execute) =>
      Effect.tryPromise({
        try: () => execute(native),
        catch: (cause) => new TigerBeetleTransportError(operation, 'synthetic ledger failure', cause),
      }),
  }
  return {
    native,
    client,
    accounts,
    transfers,
    loseNextAck: () => {
      loseAck = true
    },
  }
}

describe('inference expense TigerBeetle posting and reconciliation', () => {
  test('reports a captured quote set while later valid requests extend the session ledger', async () => {
    const ledger = memoryLedger()
    const later = Result.getOrThrow(makeInferenceExpenseQuote(expenseSourceFixture({ key: 'b' }), expenseRateFixture))
    await Effect.runPromise(
      postInferenceExpenses(ledger.client, Result.getOrThrow(buildInferenceExpensePlan([quote, later]))),
    )
    const report = await Effect.runPromise(
      readInferenceExpenseLedger(ledger.client, snapshot([quote]), Effect.succeed(rows([quote, later]))),
    )
    expect(report.transferCount).toBe(1)
    expect(report.knownEstimatedCostPicoUsd).toBe('42000')
    expect(report.verifiedSessionTransferCount).toBe(2)
    expect(report.sourceAsOf).toBe(snapshot([quote]).evidence.asOf)
    expect(report.ledgerTimestampMax).toBe('4')
  })

  test('pins transfers and historical balances while a valid charge commits during the read', async () => {
    const ledger = memoryLedger()
    const later = Result.getOrThrow(makeInferenceExpenseQuote(expenseSourceFixture({ key: 'b' }), expenseRateFixture))
    const laterPlan = Result.getOrThrow(buildInferenceExpensePlan([later]))
    await Effect.runPromise(postInferenceExpenses(ledger.client, plan))
    const query = ledger.native.queryTransfers
    Object.assign(ledger.native, {
      queryTransfers: async (filter: LedgerQueryFilter) => {
        const page = await query(filter)
        await ledger.native.createTransfers(laterPlan.transfers)
        return page
      },
    })
    const report = await Effect.runPromise(
      readInferenceExpenseLedger(ledger.client, snapshot([quote]), Effect.succeed(rows([quote, later]))),
    )
    expect(ledger.transfers.size).toBe(2)
    expect(report.ledgerTimestampMax).toBe('3')
    expect(report.verifiedSessionTransferCount).toBe(1)
    expect(report.transferCount).toBe(1)
    expect(report.knownEstimatedCostPicoUsd).toBe('42000')
  })

  test('rejects a charge hidden under another scope through native account balance history', async () => {
    const ledger = memoryLedger()
    await Effect.runPromise(postInferenceExpenses(ledger.client, plan))
    const original = plan.transfers[0]
    if (original === undefined) throw new Error('synthetic transfer is absent')
    await ledger.native.createTransfers([
      { ...original, id: original.id + 1n, user_data_64: original.user_data_64 + 1n },
    ])
    await expectFailure(
      readInferenceExpenseLedger(ledger.client, snapshot([quote]), Effect.succeed(rows([quote]))),
      'balances differ',
    )
  })

  test('rejects a missing acknowledged transfer and a changed owner record', async () => {
    const ledger = memoryLedger()
    await Effect.runPromise(postInferenceExpenses(ledger.client, plan))
    const original = [...ledger.transfers.values()][0]
    if (original === undefined) throw new Error('synthetic transfer is absent')
    ledger.transfers.delete(original.id)
    await expectFailure(
      readInferenceExpenseLedger(ledger.client, snapshot([quote]), Effect.succeed(rows([quote]))),
      'set mismatch',
    )
    ledger.transfers.set(original.id, { ...original, amount: original.amount + 1n })
    await expectFailure(
      readInferenceExpenseLedger(ledger.client, snapshot([quote]), Effect.succeed(rows([quote]))),
      'does not match',
    )
  })

  test('retains a pending quote as unverified when it has not reached the native ledger', async () => {
    const ledger = memoryLedger()
    const pending = [{ quote, verifiedAt: null }]
    const report = await Effect.runPromise(
      readInferenceExpenseLedger(ledger.client, { ...snapshot([quote]), quotes: pending }, Effect.succeed(pending)),
    )
    expect(report.transferCount).toBe(0)
    expect(report.knownEstimatedCostPicoUsd).toBe('0')
    expect(report.quotedRequestCount).toBe(1)
  })

  test('rejects an acknowledged zero-price quote whose accounts are absent', async () => {
    const ledger = memoryLedger()
    const free = Result.getOrThrow(
      makeInferenceExpenseQuote(expenseSourceFixture({ inputTokens: 0 }), expenseRateFixture),
    )
    await expectFailure(
      readInferenceExpenseLedger(ledger.client, snapshot([free]), Effect.succeed(rows([free]))),
      'set mismatch',
    )
  })

  test('rejects unordered and oversized native transfer pages', async () => {
    for (const oversized of [false, true]) {
      const ledger = memoryLedger()
      await Effect.runPromise(postInferenceExpenses(ledger.client, plan))
      const original = [...ledger.transfers.values()][0]
      if (original === undefined) throw new Error('synthetic transfer is absent')
      Object.assign(ledger.native, {
        queryTransfers: async (filter: LedgerQueryFilter) =>
          Array.from({ length: oversized ? filter.limit + 1 : 2 }, () => original),
      })
      await expectFailure(
        readInferenceExpenseLedger(ledger.client, snapshot([quote]), Effect.succeed(rows([quote]))),
        oversized ? 'oversized page' : 'not ordered',
      )
    }
  })

  test('recovers a committed transfer with a lost acknowledgement before marking the quote verified', async () => {
    const ledger = memoryLedger()
    let verified = false
    const store = {
      newSources: Effect.succeed([]),
      freeze: () => Effect.void,
      pending: Effect.sync(() => (verified ? [] : [quote])),
      acknowledge: () =>
        Effect.sync(() => {
          verified = true
        }),
      session: () => Effect.succeed([{ quote, verifiedAt: null }]),
    }
    ledger.loseNextAck()
    await expectFailure(runInferenceExpensePass(store, ledger.client), 'synthetic ledger failure')
    expect(verified).toBe(false)
    expect(ledger.transfers.size).toBe(1)
    await Effect.runPromise(runInferenceExpensePass(store, ledger.client))
    expect(verified).toBe(true)
    expect(ledger.transfers.size).toBe(1)
    const result = await Effect.runPromise(
      readInferenceExpenseLedger(ledger.client, snapshot([quote]), Effect.succeed(rows([quote]))),
    )
    expect(result.knownEstimatedCostPicoUsd).toBe('42000')
    expect(result.exactLedgerPrefix).toBe(true)
    expect(result.invoiceReconciled).toBe(false)
  })

  test('replays posting and also recovers a PostgreSQL verification acknowledgement failure', async () => {
    const ledger = memoryLedger()
    let attempts = 0
    const store = {
      newSources: Effect.succeed([]),
      freeze: () => Effect.void,
      pending: Effect.succeed([quote]),
      acknowledge: () =>
        Effect.suspend(() =>
          ++attempts === 1
            ? Effect.fail(
                new SqlError({
                  reason: new ConnectionError({
                    cause: new Error('synthetic PostgreSQL acknowledgement lost'),
                    message: 'synthetic PostgreSQL acknowledgement lost',
                    operation: 'verify inference expense',
                  }),
                }),
              )
            : Effect.void,
        ),
      session: () => Effect.succeed([{ quote, verifiedAt: null }]),
    }
    await expectFailure(runInferenceExpensePass(store, ledger.client), 'synthetic PostgreSQL acknowledgement lost')
    await Effect.runPromise(runInferenceExpensePass(store, ledger.client))
    await Effect.runPromise(postInferenceExpenses(ledger.client, plan))
    expect(ledger.transfers.size).toBe(1)
    expect([...ledger.accounts.values()].find((account) => account.code === 510)?.debits_posted).toBe(42000n)
  })

  test('rejects an existing conflicting transfer and leaves the quote pending', async () => {
    const ledger = memoryLedger()
    await Effect.runPromise(postInferenceExpenses(ledger.client, plan))
    for (const [id, transfer] of ledger.transfers)
      ledger.transfers.set(id, { ...transfer, amount: transfer.amount + 1n })
    await expectFailure(postInferenceExpenses(ledger.client, plan), 'does not match')
    expect(ledger.transfers.size).toBe(1)
  })

  test('reads the entire scoped set and rejects extra records and changed balances', async () => {
    const ledger = memoryLedger()
    await Effect.runPromise(postInferenceExpenses(ledger.client, plan))
    const original = [...ledger.transfers.values()][0]
    if (original === undefined) throw new Error('synthetic transfer is absent')
    ledger.transfers.set(original.id + 1n, {
      ...original,
      id: original.id + 1n,
      timestamp: original.timestamp + 1n,
      code: 2,
      user_data_32: 3,
    })
    await expectFailure(
      readInferenceExpenseLedger(ledger.client, snapshot([quote]), Effect.succeed(rows([quote]))),
      'set mismatch',
    )
    ledger.transfers.delete(original.id + 1n)
    for (const [id, account] of ledger.accounts)
      if (account.code === 510) ledger.accounts.set(id, { ...account, debits_posted: account.debits_posted + 1n })
    await expectFailure(
      readInferenceExpenseLedger(ledger.client, snapshot([quote]), Effect.succeed(rows([quote]))),
      'balances differ',
    )
  })

  test('keeps gap coverage explicit even when there are no ledger transfers', async () => {
    const ledger = memoryLedger()
    const gap = Result.getOrThrow(
      makeInferenceExpenseQuote(expenseSourceFixture({ missing: true }), expenseRateFixture),
    )
    const result = await Effect.runPromise(
      readInferenceExpenseLedger(ledger.client, snapshot([gap]), Effect.succeed(rows([gap]))),
    )
    expect(result.gapRequestCount).toBe(1)
    expect(result.pricedRequestCount).toBe(0)
    expect(result.knownEstimatedCostPicoUsd).toBe('0')
    expect(result.invoiceReconciled).toBe(false)
  })
})
