import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Cause, Effect, Exit, Redacted, Result } from 'effect'
import { CreateAccountStatus, CreateTransferStatus, type Account, type Transfer } from 'tigerbeetle-node'

import { prepareAccounting, rebuildAccountingLedger, type LedgerPlan } from './accounting'
import type { RuntimeConfig } from './config'
import { Authority, OrderSide, type Fill } from './paper'
import {
  assembleAccountPlan,
  buildLedgerPlan,
  classifyAccountCreateBatch,
  classifyTransferCreateBatch,
  hashLedgerPlan,
  Journal,
  JournalLive,
  LedgerValidationError,
  reconcileLedgerPlan,
  resolveReplicaAddresses,
  transactionTransferQuery,
  validatePersistedRunEvidence,
  type JournalService,
  type TigerBeetleClient,
} from './ledger'
import { LEDGER_BATCH_MAX } from './ledger-plan'
import { evaluateRiskBalancedTrend } from './risk-balanced-trend'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

const assertSuccess = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result), 'strategy evaluation fixture must succeed')
  return result.success
}

const assertFailure = <A, E>(result: Result.Result<A, E>): E => {
  assert(Result.isFailure(result), 'ledger decision fixture must fail')
  return result.failure
}

const materializeAccounts = (plan: ReturnType<typeof buildLedgerPlan>): Account[] => {
  const balances = new Map(plan.accounts.map((account) => [account.id, { debits: 0n, credits: 0n }]))
  const balance = (accountId: bigint) => {
    const value = balances.get(accountId)
    if (value === undefined) throw new Error(`ledger fixture has no account ${accountId}`)
    return value
  }
  for (const transfer of plan.transfers) {
    balance(transfer.debit_account_id).debits += transfer.amount
    balance(transfer.credit_account_id).credits += transfer.amount
  }
  return plan.accounts.map((account) => ({
    ...account,
    debits_posted: balance(account.id).debits,
    credits_posted: balance(account.id).credits,
    timestamp: 1n,
  }))
}

const materializeTransfers = (plan: ReturnType<typeof buildLedgerPlan>): Transfer[] =>
  plan.transfers.map((transfer) => ({ ...transfer, timestamp: 1n }))

const journalConfig = {
  operationTimeoutMs: 1_000,
  tigerBeetle: { clusterId: 222397790944575595450310052784555675227n, replicaAddresses: ['3000'], ledger: 7_001 },
} satisfies Pick<RuntimeConfig, 'operationTimeoutMs' | 'tigerBeetle'>

const paperFill = (fillId: string, accountId = 'paper-account'): Fill => ({
  schemaVersion: 'bayn.paper-fill.v1',
  accountId,
  fillId,
  brokerOrderId: `broker-${fillId}`,
  clientOrderId: `client-${fillId}`,
  symbol: 'NVDA',
  side: OrderSide.Buy,
  quantityMicros: '1000000',
  priceMicros: '100000000',
  feeMicros: '100',
  occurredAt: '2026-07-22T15:30:00.000Z',
})

const paperPlan = (fillId: string, accountId = 'paper-account'): LedgerPlan => {
  const result = prepareAccounting(
    fillId.padEnd(64, fillId[0] ?? 'a').slice(0, 64),
    paperFill(fillId, accountId),
    { quantityMicros: '0', costMicros: '0' },
    journalConfig.tigerBeetle.ledger,
  )
  if (Result.isFailure(result)) throw new Error(`paperPlan failed: ${JSON.stringify(result.failure)}`)
  return result.success.ledger
}

const evaluationPlan = () => {
  const snapshot = makeSnapshot()
  const result = assertSuccess(
    evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, makeTestProvenance()),
  )
  return { result, plan: buildLedgerPlan(result, journalConfig.tigerBeetle.ledger) }
}

const makeTigerBeetleClient = (overrides: Partial<TigerBeetleClient> = {}): TigerBeetleClient => ({
  createAccounts: async () => [],
  createTransfers: async () => [],
  lookupAccounts: async () => [],
  lookupTransfers: async () => [],
  queryAccounts: async () => [],
  queryTransfers: async () => [],
  destroy: () => undefined,
  ...overrides,
})

const makeLedgerClient = () => {
  const accounts = new Map<bigint, Account>()
  const transfers = new Map<bigint, Transfer>()
  const client: TigerBeetleClient = {
    createAccounts: async (batch) =>
      batch.map((account) => {
        if (accounts.has(account.id)) return { timestamp: 1n, status: CreateAccountStatus.exists }
        accounts.set(account.id, { ...account, timestamp: 1n })
        return { timestamp: 1n, status: CreateAccountStatus.created }
      }),
    createTransfers: async (batch) =>
      batch.map((transfer) => {
        if (transfers.has(transfer.id)) return { timestamp: 1n, status: CreateTransferStatus.exists }
        const debit = accounts.get(transfer.debit_account_id)
        const credit = accounts.get(transfer.credit_account_id)
        if (debit === undefined || credit === undefined) throw new Error('transfer references an unknown account')
        accounts.set(debit.id, { ...debit, debits_posted: debit.debits_posted + transfer.amount })
        accounts.set(credit.id, { ...credit, credits_posted: credit.credits_posted + transfer.amount })
        transfers.set(transfer.id, { ...transfer, timestamp: 1n })
        return { timestamp: 1n, status: CreateTransferStatus.created }
      }),
    lookupAccounts: async (ids) =>
      ids.flatMap((id) => {
        const account = accounts.get(id)
        return account === undefined ? [] : [account]
      }),
    lookupTransfers: async (ids) =>
      ids.flatMap((id) => {
        const transfer = transfers.get(id)
        return transfer === undefined ? [] : [transfer]
      }),
    queryAccounts: async (filter) =>
      [...accounts.values()]
        .filter(
          (account) =>
            account.ledger === filter.ledger &&
            (filter.user_data_128 === 0n || account.user_data_128 === filter.user_data_128),
        )
        .slice(0, filter.limit),
    queryTransfers: async (filter) =>
      [...transfers.values()]
        .filter(
          (transfer) =>
            transfer.ledger === filter.ledger &&
            (filter.user_data_128 === 0n || transfer.user_data_128 === filter.user_data_128) &&
            (filter.user_data_64 === 0n || transfer.user_data_64 === filter.user_data_64),
        )
        .slice(0, filter.limit),
    destroy: () => undefined,
  }
  return { accounts, transfers, client }
}

const withJournal = <A, E>(client: TigerBeetleClient, use: (journal: JournalService) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      return yield* use(yield* Journal)
    }).pipe(
      Effect.provide(
        JournalLive(journalConfig, {
          createClient: () => client,
          resolveReplicaAddresses: () => Effect.succeed(['3000']),
        }),
      ),
    ),
  )

describe('TigerBeetle ledger decisions', () => {
  test('classifies account and transfer create batches without losing request order or rejection material', () => {
    const plan = paperPlan('a')
    const accounts = plan.accounts.slice(0, 2)
    const accountDecision = classifyAccountCreateBatch(accounts, [
      { timestamp: 1n, status: CreateAccountStatus.exists },
      { timestamp: 2n, status: CreateAccountStatus.created },
    ])
    expect(assertSuccess(accountDecision)).toEqual([accounts[0]])

    const rejectedAccount = assertFailure(
      classifyAccountCreateBatch(accounts, [
        { timestamp: 1n, status: CreateAccountStatus.created },
        { timestamp: 2n, status: CreateAccountStatus.exists_with_different_code },
      ]),
    )
    expect(rejectedAccount).toBeInstanceOf(LedgerValidationError)
    expect(rejectedAccount).toMatchObject({
      operation: 'verify-account-results',
      reason: 'create-rejected',
      material: {
        kind: 'account',
        id: accounts[1].id,
        status: CreateAccountStatus.exists_with_different_code,
      },
    })

    const transfers = plan.transfers.slice(0, 2)
    expect(
      assertSuccess(
        classifyTransferCreateBatch(transfers, [
          { timestamp: 1n, status: CreateTransferStatus.created },
          { timestamp: 2n, status: CreateTransferStatus.exists },
        ]),
      ),
    ).toEqual([transfers[1]])

    const incomplete = assertFailure(classifyTransferCreateBatch(transfers, []))
    expect(incomplete).toMatchObject({
      operation: 'verify-transfer-results',
      reason: 'batch-result-count',
      material: { kind: 'transfer', expectedCount: transfers.length, actualCount: 0 },
    })
  })

  test('builds one exact transaction query and rejects empty or mixed transaction plans', () => {
    const plan = paperPlan('a')
    const query = assertSuccess(transactionTransferQuery(plan))
    expect(query).toEqual({
      user_data_128: plan.transfers[0].user_data_128,
      user_data_64: 0n,
      user_data_32: 0,
      ledger: journalConfig.tigerBeetle.ledger,
      code: 0,
      timestamp_min: 0n,
      timestamp_max: 0n,
      limit: plan.transfers.length + 1,
      flags: 0,
    })

    const empty = assertFailure(transactionTransferQuery({ ...plan, accounts: [], transfers: [] }))
    expect(empty).toMatchObject({ operation: 'post', reason: 'empty-plan' })

    const atLimit = assertFailure(
      transactionTransferQuery({
        ...plan,
        accounts: Array.from({ length: LEDGER_BATCH_MAX }, () => plan.accounts[0]),
      }),
    )
    expect(atLimit).toMatchObject({
      operation: 'post',
      reason: 'batch-limit',
      material: { accountCount: LEDGER_BATCH_MAX, limit: LEDGER_BATCH_MAX },
    })

    const mixed = assertFailure(
      transactionTransferQuery({
        ...plan,
        transfers: [plan.transfers[0], { ...plan.transfers[1], user_data_128: plan.transfers[0].user_data_128 + 1n }],
      }),
    )
    expect(mixed).toMatchObject({
      operation: 'build-transaction-transfer-query',
      reason: 'invalid-transaction',
    })
  })

  test('assembles paper account plans with exact deduplication and duplicate-transfer rejection', () => {
    const first = paperPlan('a')
    const second = paperPlan('b')
    const assembled = assertSuccess(assembleAccountPlan('paper-account', [first, second]))

    expect(assembled.runKey).toBe(first.runKey)
    expect(assembled.runTag).toBe(first.runTag)
    expect(assembled.accounts).toEqual(first.accounts)
    expect(assembled.transfers.map((transfer) => transfer.id)).toEqual(
      [...first.transfers, ...second.transfers]
        .map((transfer) => transfer.id)
        .sort((left, right) => (left < right ? -1 : 1)),
    )

    const duplicate = assertFailure(assembleAccountPlan('paper-account', [first, first]))
    expect(duplicate).toMatchObject({
      operation: 'build-account-reconciliation',
      reason: 'duplicate-transfer',
      material: { accountId: 'paper-account', transferId: first.transfers[0].id },
    })

    const wrongAccount = assertFailure(assembleAccountPlan('paper-account', [paperPlan('c', 'other-account')]))
    expect(wrongAccount).toMatchObject({
      operation: 'build-account-reconciliation',
      reason: 'wrong-account',
      material: { accountId: 'paper-account' },
    })
  })

  test('folds exact plan and locally verifiable persisted-run balances into Result failures', () => {
    const { result, plan } = evaluationPlan()
    const accounts = materializeAccounts(plan)
    const transfers = materializeTransfers(plan)

    expect(Result.isSuccess(reconcileLedgerPlan(plan, accounts, transfers))).toBeTrue()
    expect(
      Result.isSuccess(
        validatePersistedRunEvidence(
          {
            runId: result.runId,
            accountCount: accounts.length,
            transferCount: transfers.length,
            exact: true,
          },
          journalConfig.tigerBeetle.ledger,
          accounts,
          transfers,
        ),
      ),
    ).toBeTrue()

    const drifted = [{ ...accounts[0], debits_posted: accounts[0].debits_posted + 1n }, ...accounts.slice(1)]
    const reconciliationFailure = assertFailure(reconcileLedgerPlan(plan, drifted, transfers))
    expect(reconciliationFailure).toMatchObject({
      operation: 'reconcile',
      reason: 'invalid-balance',
      material: { account: drifted[0] },
    })

    const duplicateAccounts = [...accounts.slice(0, -1), accounts[0]]
    const persistedFailure = assertFailure(
      validatePersistedRunEvidence(
        {
          runId: result.runId,
          accountCount: accounts.length,
          transferCount: transfers.length,
          exact: true,
        },
        journalConfig.tigerBeetle.ledger,
        duplicateAccounts,
        transfers,
      ),
    )
    expect(persistedFailure).toMatchObject({
      operation: 'check-run',
      reason: 'duplicate-account',
      material: { runId: result.runId, accountId: accounts[0].id },
    })
  })
})

describe('TigerBeetle simulation journal', () => {
  test('plans deterministic double-entry transfers and reconciles exact sets and balances', () => {
    const snapshot = makeSnapshot()
    const result = assertSuccess(
      evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, makeTestProvenance()),
    )
    const first = buildLedgerPlan(result, 7001)
    const second = buildLedgerPlan(result, 7001)
    expect(first).toEqual(second)
    expect(hashLedgerPlan(first)).toMatch(/^[a-f0-9]{64}$/)
    expect(hashLedgerPlan(first)).toBe(hashLedgerPlan(second))
    expect(hashLedgerPlan(first)).not.toBe(hashLedgerPlan(buildLedgerPlan(result, 7002)))
    expect(first.accounts).toHaveLength(fixtureProtocol.universe.length + 6)
    expect(first.transfers.length).toBeGreaterThan(1)
    expect(
      Result.isSuccess(reconcileLedgerPlan(first, materializeAccounts(first), materializeTransfers(first))),
    ).toBeTrue()
  })

  test('fails closed on extra transfers or mismatched balances', () => {
    const snapshot = makeSnapshot()
    const result = assertSuccess(
      evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, makeTestProvenance()),
    )
    const plan = buildLedgerPlan(result, 7001)
    const accounts = materializeAccounts(plan)
    const transfers = materializeTransfers(plan)
    expect(
      assertFailure(reconcileLedgerPlan(plan, accounts, [...transfers, { ...transfers[0], id: transfers[0].id + 1n }])),
    ).toMatchObject({ reason: 'record-set-mismatch' })
    expect(
      assertFailure(
        reconcileLedgerPlan(
          plan,
          [{ ...accounts[0], debits_posted: accounts[0].debits_posted + 1n }, ...accounts.slice(1)],
          transfers,
        ),
      ),
    ).toMatchObject({ reason: 'invalid-balance' })
  })

  test('creates an empty target exactly once and verifies an idempotent replay', async () => {
    const snapshot = makeSnapshot()
    const result = assertSuccess(
      evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, makeTestProvenance()),
    )
    const plan = buildLedgerPlan(result, journalConfig.tigerBeetle.ledger)
    const target = makeLedgerClient()

    const reconciliations = await Effect.runPromise(
      withJournal(target.client, (journal) =>
        Effect.all([journal.journalAndReconcile(result), journal.journalAndReconcile(result)]),
      ),
    )

    expect(reconciliations[0]).toEqual(reconciliations[1])
    expect(reconciliations[0]).toEqual({
      runId: result.runId,
      accountCount: plan.accounts.length,
      transferCount: plan.transfers.length,
      exact: true,
    })
    expect(target.accounts.size).toBe(plan.accounts.length)
    expect(target.transfers.size).toBe(plan.transfers.length)
  })

  test('keeps pure validation failures separate from retryable TigerBeetle I/O failures', async () => {
    const plan = paperPlan('d')
    let transferCreates = 0
    const rejectedClient = makeTigerBeetleClient({
      createAccounts: async (accounts) =>
        accounts.map((_, index) => ({
          timestamp: 1n,
          status: index === 0 ? CreateAccountStatus.exists_with_different_code : CreateAccountStatus.created,
        })),
      createTransfers: async () => {
        transferCreates += 1
        return []
      },
    })

    const rejected = await Effect.runPromise(Effect.flip(withJournal(rejectedClient, (journal) => journal.post(plan))))
    expect(rejected.retryable).toBeFalse()
    expect(rejected.cause).toBeInstanceOf(LedgerValidationError)
    expect(rejected.cause).toMatchObject({
      operation: 'verify-account-results',
      reason: 'create-rejected',
      material: { kind: 'account', id: plan.accounts[0].id },
    })
    expect(transferCreates).toBe(0)

    const ioCause = new Error('TigerBeetle transport unavailable')
    const unavailableClient = makeTigerBeetleClient({
      createAccounts: async () => {
        throw ioCause
      },
      createTransfers: async () => {
        transferCreates += 1
        return []
      },
    })
    const unavailable = await Effect.runPromise(
      Effect.flip(withJournal(unavailableClient, (journal) => journal.post(plan))),
    )
    expect(unavailable.retryable).toBeTrue()
    expect(unavailable.cause).toBe(ioCause)
    expect(transferCreates).toBe(0)
  })

  test('retains the exact throwing ledger-plan cause without starting TigerBeetle writes', async () => {
    const { result } = evaluationPlan()
    let writes = 0
    const client = makeTigerBeetleClient({
      createAccounts: async () => {
        writes += 1
        return []
      },
      createTransfers: async () => {
        writes += 1
        return []
      },
    })

    const error = await Effect.runPromise(
      Effect.flip(
        withJournal(client, (journal) =>
          journal.journalAndReconcile({
            ...result,
            events: [],
          }),
        ),
      ),
    )

    expect(error.retryable).toBeFalse()
    expect(error.cause).toBeInstanceOf(LedgerValidationError)
    if (error.cause instanceof LedgerValidationError) {
      expect(error.cause).toMatchObject({
        operation: 'build-plan',
        reason: 'ledger-plan-failure',
        material: { ledger: journalConfig.tigerBeetle.ledger },
      })
      expect(error.cause.cause).toBeInstanceOf(Error)
      expect(String(error.cause.cause)).toContain('no fill events')
    }
    expect(writes).toBe(0)
  })

  test('does not turn an unexpected account-reconciliation defect into a false verification result', async () => {
    const plan = paperPlan('e')
    const accounts = materializeAccounts(plan)
    const defect = new Error('account reconciliation accessor defect')
    const defectiveAccount = new Proxy(accounts[0], {
      get: (target, property, receiver) => {
        if (property === 'code') throw defect
        return Reflect.get(target, property, receiver)
      },
    })
    const client = makeTigerBeetleClient({
      queryAccounts: async () => [defectiveAccount, ...accounts.slice(1)],
      queryTransfers: async () => materializeTransfers(plan),
    })

    const exit = await Effect.runPromiseExit(
      withJournal(client, (journal) => journal.verifyAccount('paper-account', [plan])),
    )
    expect(Exit.isFailure(exit)).toBeTrue()
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect)
  })

  test('replays a committed transfer batch after an unknown result without another transfer mutation', async () => {
    const plan = paperPlan('f')
    const target = makeLedgerClient()
    const unknownCause = new Error('connection rejected after TigerBeetle committed the transfer batch')
    let transferMutationCalls = 0
    const committedThenUnknownClient: TigerBeetleClient = {
      ...target.client,
      createTransfers: async (batch) => {
        transferMutationCalls += 1
        await target.client.createTransfers(batch)
        throw unknownCause
      },
    }

    const unknown = await Effect.runPromise(
      Effect.flip(withJournal(committedThenUnknownClient, (journal) => journal.post(plan))),
    )
    expect(unknown.retryable).toBeTrue()
    expect(unknown.cause).toBe(unknownCause)
    expect(transferMutationCalls).toBe(1)
    expect(target.transfers.size).toBe(plan.transfers.length)

    let replayTransferMutationCalls = 0
    const replayClient: TigerBeetleClient = {
      ...target.client,
      createTransfers: async (batch) => {
        replayTransferMutationCalls += 1
        return target.client.createTransfers(batch)
      },
    }
    const reconciled = await Effect.runPromise(
      withJournal(replayClient, (journal) =>
        journal.post(plan).pipe(Effect.andThen(journal.verifyAccount('paper-account', [plan]))),
      ),
    )

    expect(reconciled).toBeTrue()
    expect(replayTransferMutationCalls).toBe(0)
    expect(transferMutationCalls).toBe(1)
    expect(target.transfers.size).toBe(plan.transfers.length)
  })

  test('preflights every deterministic transfer and creates only missing records in request order', async () => {
    const plan = paperPlan('1')
    const target = makeLedgerClient()
    const existing = plan.transfers.at(-1)
    assert(existing, 'paper ledger fixture must contain a transfer')
    for (const account of plan.accounts) target.accounts.set(account.id, { ...account, timestamp: 1n })
    await target.client.createTransfers([existing])

    const lookupBatches: bigint[][] = []
    const createBatches: bigint[][] = []
    const client: TigerBeetleClient = {
      ...target.client,
      lookupTransfers: async (ids) => {
        lookupBatches.push([...ids])
        return target.client.lookupTransfers(ids)
      },
      createTransfers: async (batch) => {
        createBatches.push(batch.map((transfer) => transfer.id))
        return target.client.createTransfers(batch)
      },
    }

    await Effect.runPromise(withJournal(client, (journal) => journal.post(plan)))

    expect(lookupBatches[0]).toEqual(plan.transfers.map((transfer) => transfer.id))
    expect(createBatches).toEqual([
      plan.transfers.filter((transfer) => transfer.id !== existing.id).map((transfer) => transfer.id),
    ])

    const conflict = makeLedgerClient()
    conflict.transfers.set(plan.transfers[0].id, {
      ...plan.transfers[0],
      amount: plan.transfers[0].amount + 1n,
      timestamp: 1n,
    })
    let conflictingCreates = 0
    let conflictingLookup: readonly bigint[] = []
    const conflictingClient: TigerBeetleClient = {
      ...conflict.client,
      lookupTransfers: async (ids) => {
        conflictingLookup = [...ids]
        return conflict.client.lookupTransfers(ids)
      },
      createTransfers: async (batch) => {
        conflictingCreates += 1
        return conflict.client.createTransfers(batch)
      },
    }
    const mismatch = await Effect.runPromise(
      Effect.flip(withJournal(conflictingClient, (journal) => journal.post(plan))),
    )

    expect(mismatch.message).toContain('does not match its plan')
    expect(conflictingLookup).toEqual(plan.transfers.map((transfer) => transfer.id))
    expect(conflictingCreates).toBe(0)
  })

  test('posts one paper fill idempotently and rejects a conflicting transfer', async () => {
    const fill: Fill = {
      schemaVersion: 'bayn.paper-fill.v1',
      accountId: 'paper-account',
      fillId: 'activity-1',
      brokerOrderId: 'broker-order-1',
      clientOrderId: 'client-order-1',
      symbol: 'NVDA',
      side: OrderSide.Buy,
      quantityMicros: '1000000',
      priceMicros: '100000000',
      feeMicros: '100',
      occurredAt: '2026-07-22T15:30:00.000Z',
    }
    const planResult = prepareAccounting(
      'a'.repeat(64),
      fill,
      { quantityMicros: '0', costMicros: '0' },
      journalConfig.tigerBeetle.ledger,
    )
    expect(Result.isSuccess(planResult)).toBe(true)
    if (Result.isFailure(planResult)) throw new Error('plan should succeed')
    const plan = planResult.success.ledger
    const invalidTarget = makeLedgerClient()
    const invalidPlan = {
      ...plan,
      transfers: plan.transfers.map((transfer: Transfer, index: number) =>
        index === 0 ? { ...transfer, user_data_128: 0n } : transfer,
      ),
    }
    const invalid = await Effect.runPromise(
      Effect.flip(withJournal(invalidTarget.client, (journal) => journal.post(invalidPlan))),
    )
    expect(invalid.message).toContain('nonzero transaction tag')
    expect(invalidTarget.accounts.size).toBe(0)
    expect(invalidTarget.transfers.size).toBe(0)

    const target = makeLedgerClient()

    const exact = await Effect.runPromise(
      withJournal(target.client, (journal) =>
        journal
          .post(plan)
          .pipe(Effect.andThen(journal.post(plan)), Effect.andThen(journal.verifyAccount(fill.accountId, [plan]))),
      ),
    )
    expect(exact).toBeTrue()
    expect(target.accounts.size).toBe(plan.accounts.length)
    expect(target.transfers.size).toBe(plan.transfers.length)

    const conflict = makeLedgerClient()
    conflict.transfers.set(plan.transfers[0].id, {
      ...plan.transfers[0],
      amount: plan.transfers[0].amount + 1n,
      timestamp: 1n,
    })
    const error = await Effect.runPromise(Effect.flip(withJournal(conflict.client, (journal) => journal.post(plan))))
    expect(error.message).toContain('does not match its plan')

    target.transfers.set(plan.transfers[0].id + 1n, { ...plan.transfers[0], id: plan.transfers[0].id + 1n })
    const postWithExtra = await Effect.runPromise(
      Effect.flip(withJournal(target.client, (journal) => journal.post(plan))),
    )
    expect(postWithExtra.message).toContain('transfer set mismatch')
    const extra = await Effect.runPromise(
      withJournal(target.client, (journal) => journal.verifyAccount(fill.accountId, [plan])),
    )
    expect(extra).toBeFalse()

    const unavailable = makeTigerBeetleClient({
      queryAccounts: async () => {
        throw new Error('unavailable')
      },
    })
    const failure = await Effect.runPromise(
      Effect.flip(withJournal(unavailable, (journal) => journal.verifyAccount(fill.accountId, [plan]))),
    )
    expect(failure.message).toContain('TigerBeetle verify-account-accounts failed')
  })

  test('rebuilds a paper transaction into the exact read-only ledger plan', () => {
    const fill: Fill = {
      schemaVersion: 'bayn.paper-fill.v1',
      accountId: 'paper-account',
      fillId: 'activity-2',
      brokerOrderId: 'broker-order-2',
      clientOrderId: 'client-order-2',
      symbol: 'AMD',
      side: OrderSide.Buy,
      quantityMicros: '2000000',
      priceMicros: '50000000',
      feeMicros: '0',
      occurredAt: '2026-07-22T15:31:00.000Z',
    }
    const preparedResult = prepareAccounting(
      'b'.repeat(64),
      fill,
      { quantityMicros: '0', costMicros: '0' },
      journalConfig.tigerBeetle.ledger,
    )
    expect(Result.isSuccess(preparedResult)).toBe(true)
    if (Result.isFailure(preparedResult)) throw new Error('prepared should succeed')
    const prepared = preparedResult.success

    const planResult = rebuildAccountingLedger(prepared.transaction, journalConfig.tigerBeetle.ledger)
    expect(Result.isSuccess(planResult)).toBe(true)
    if (Result.isFailure(planResult)) throw new Error('should succeed')
    expect(planResult.success).toEqual(prepared.ledger)
    expect(() =>
      rebuildAccountingLedger(
        { ...prepared.transaction, contentHash: 'c'.repeat(64) },
        journalConfig.tigerBeetle.ledger,
      ),
    ).toThrow('content hash')
  })

  test('rejects a mismatched existing account before creating transfers', async () => {
    const snapshot = makeSnapshot()
    const result = assertSuccess(
      evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, makeTestProvenance()),
    )
    const plan = buildLedgerPlan(result, journalConfig.tigerBeetle.ledger)
    const target = makeLedgerClient()
    target.accounts.set(plan.accounts[0].id, { ...plan.accounts[0], code: plan.accounts[0].code + 1, timestamp: 1n })

    const error = await Effect.runPromise(
      Effect.flip(withJournal(target.client, (journal) => journal.journalAndReconcile(result))),
    )

    expect(error.message).toContain('does not match its plan')
    expect(target.transfers.size).toBe(0)
  })

  test('checks the persisted run read-only and rejects changed TigerBeetle balances', async () => {
    const snapshot = makeSnapshot()
    const provenance = makeTestProvenance()
    const result = assertSuccess(
      evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance),
    )
    const plan = buildLedgerPlan(result, 7001)
    let accounts = materializeAccounts(plan)
    const transfers = materializeTransfers(plan)
    let writes = 0
    const client = makeTigerBeetleClient({
      queryAccounts: async () => accounts,
      queryTransfers: async () => transfers,
      createAccounts: async () => {
        writes += 1
        return []
      },
      createTransfers: async () => {
        writes += 1
        return []
      },
      destroy: () => undefined,
    })
    const config: RuntimeConfig = {
      host: '127.0.0.1',
      port: 0,
      maximumAuthority: Authority.Observe,
      build: {
        sourceRevision: provenance.sourceRevision,
        imageRepository: provenance.image.repository,
        imageDigest: provenance.image.digest,
        strategyBehaviorHash: provenance.strategy.behaviorHash,
        strategyParameterHash: provenance.strategy.parameterHash,
        verification: 'embedded',
      },
      healthIntervalMs: 30_000,
      operationTimeoutMs: 1_000,
      cycleStallThresholdMs: 300_000,
      reconciliationStaleThresholdMs: 120_000,
      unknownMutationThresholdMs: 300_000,
      clickhouse: {
        url: 'http://clickhouse.test',
        username: 'bayn',
        password: Redacted.make('unused'),
        snapshotId: snapshot.manifest.finalizedSnapshot.snapshotId,
        publicationAsOf: snapshot.manifest.finalizedSnapshot.asOfSession,
        calendarVersion: snapshot.manifest.finalizedSnapshot.calendarVersion,
        bounds: snapshot.manifest.bounds,
      },
      postgres: { url: Redacted.make('postgresql://unused'), tls: false, caPath: '/unused' },
      tigerBeetle: { clusterId: 2001n, replicaAddresses: ['3000'], ledger: 7001 },
    }
    const check = (journal: JournalService) =>
      journal.checkRun({
        runId: result.runId,
        accountCount: accounts.length,
        transferCount: transfers.length,
        exact: true,
      })
    const useJournal = <A, E>(body: (journal: JournalService) => Effect.Effect<A, E>) =>
      Effect.scoped(
        Effect.gen(function* () {
          return yield* body(yield* Journal)
        }).pipe(
          Effect.provide(
            JournalLive(config, {
              createClient: () => client,
              resolveReplicaAddresses: () => Effect.succeed(['3000']),
            }),
          ),
        ),
      )

    await Effect.runPromise(useJournal(check))
    expect(writes).toBe(0)

    accounts = [{ ...accounts[0], debits_posted: accounts[0].debits_posted + 1n }, ...accounts.slice(1)]
    const error = await Effect.runPromise(Effect.flip(useJournal(check)))
    expect(error.message).toContain('balance does not reconcile locally')
    expect(writes).toBe(0)
  })

  test('rejects exact query-limit ceilings before issuing TigerBeetle reads', async () => {
    const plan = paperPlan('0')
    const atLimit = {
      ...plan,
      accounts: Array.from({ length: LEDGER_BATCH_MAX }, (_, index) => ({
        ...plan.accounts[0],
        id: BigInt(index + 1),
      })),
      transfers: [],
    }
    let reads = 0
    const client = makeTigerBeetleClient({
      queryAccounts: async () => {
        reads += 1
        return []
      },
      queryTransfers: async () => {
        reads += 1
        return []
      },
    })

    const [runError, accountError] = await Effect.runPromise(
      withJournal(client, (journal) =>
        Effect.all([
          Effect.flip(
            journal.checkRun({
              runId: 'a'.repeat(64),
              accountCount: LEDGER_BATCH_MAX,
              transferCount: 0,
              exact: true,
            }),
          ),
          Effect.flip(journal.verifyAccount('paper-account', [atLimit])),
        ]),
      ),
    )

    expect(runError).toMatchObject({
      operation: 'check-run',
      retryable: false,
      cause: { _tag: 'LedgerValidationError', reason: 'batch-limit' },
    })
    expect(accountError).toMatchObject({
      operation: 'verify-account',
      retryable: false,
      cause: { _tag: 'LedgerValidationError', reason: 'batch-limit' },
    })
    expect(reads).toBe(0)
  })
})

describe('TigerBeetle replica addresses', () => {
  test('resolves ordinal hostnames in configured order and preserves numeric addresses', async () => {
    const lookups: string[] = []
    const addresses = await Effect.runPromise(
      resolveReplicaAddresses(
        [
          'bayn-tigerbeetle-0.bayn-tigerbeetle-headless.bayn.svc.cluster.local:3000',
          'bayn-tigerbeetle-1.bayn-tigerbeetle-headless.bayn.svc.cluster.local:3000',
          '10.244.5.236:3000',
          '127.0.0.1',
          '3001',
        ],
        (hostname) =>
          Effect.sync(() => {
            lookups.push(hostname)
            return [hostname.includes('-0.') ? '10.244.5.234' : '10.244.5.235']
          }),
      ),
    )

    expect(lookups).toEqual([
      'bayn-tigerbeetle-0.bayn-tigerbeetle-headless.bayn.svc.cluster.local',
      'bayn-tigerbeetle-1.bayn-tigerbeetle-headless.bayn.svc.cluster.local',
    ])
    expect(addresses).toEqual(['10.244.5.234:3000', '10.244.5.235:3000', '10.244.5.236:3000', '127.0.0.1', '3001'])
  })

  test('rejects malformed, out-of-range, and IPv6-only endpoints', async () => {
    expect(
      Effect.runPromise(resolveReplicaAddresses(['missing-port'], () => Effect.succeed(['10.0.0.1']))),
    ).rejects.toThrow('invalid TigerBeetle replica address')
    expect(
      Effect.runPromise(resolveReplicaAddresses(['replica:70000'], () => Effect.succeed(['10.0.0.1']))),
    ).rejects.toThrow('invalid TigerBeetle replica port')
    expect(Effect.runPromise(resolveReplicaAddresses(['replica:3000'], () => Effect.succeed(['::1'])))).rejects.toThrow(
      'has no IPv4 address',
    )
    expect(Effect.runPromise(resolveReplicaAddresses(['::1']))).rejects.toThrow(
      'IPv6 TigerBeetle replica addresses are not supported',
    )
    expect(
      Effect.runPromise(
        resolveReplicaAddresses(['unordered-headless-service:3000'], () => Effect.succeed(['10.0.0.1', '10.0.0.2'])),
      ),
    ).rejects.toThrow('must resolve to exactly one IPv4 address')
    expect(
      Effect.runPromise(
        resolveReplicaAddresses(['replica-0:3000', 'replica-1:3000'], () => Effect.succeed(['10.0.0.1'])),
      ),
    ).rejects.toThrow('resolved to duplicate IPv4 addresses')
  })
})
