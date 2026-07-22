import { describe, expect, test } from 'bun:test'
import { Effect, Redacted } from 'effect'
import { CreateAccountStatus, CreateTransferStatus, type Account, type Transfer } from 'tigerbeetle-node'

import type { RuntimeConfig } from './config'
import { Authority } from './paper'
import {
  assertReconciled,
  buildLedgerPlan,
  hashLedgerPlan,
  Journal,
  JournalLive,
  resolveReplicaAddresses,
  type JournalService,
  type TigerBeetleClient,
} from './ledger'
import { evaluateRiskBalancedTrend } from './risk-balanced-trend'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

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

describe('TigerBeetle simulation journal', () => {
  test('plans deterministic double-entry transfers and reconciles exact sets and balances', () => {
    const snapshot = makeSnapshot()
    const result = evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, makeTestProvenance())
    const first = buildLedgerPlan(result, 7001)
    const second = buildLedgerPlan(result, 7001)
    expect(first).toEqual(second)
    expect(hashLedgerPlan(first)).toMatch(/^[a-f0-9]{64}$/)
    expect(hashLedgerPlan(first)).toBe(hashLedgerPlan(second))
    expect(hashLedgerPlan(first)).not.toBe(hashLedgerPlan(buildLedgerPlan(result, 7002)))
    expect(first.accounts).toHaveLength(fixtureProtocol.universe.length + 6)
    expect(first.transfers.length).toBeGreaterThan(1)
    expect(() => assertReconciled(first, materializeAccounts(first), materializeTransfers(first))).not.toThrow()
  })

  test('fails closed on extra transfers or mismatched balances', () => {
    const snapshot = makeSnapshot()
    const result = evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, makeTestProvenance())
    const plan = buildLedgerPlan(result, 7001)
    const accounts = materializeAccounts(plan)
    const transfers = materializeTransfers(plan)
    expect(() =>
      assertReconciled(plan, accounts, [...transfers, { ...transfers[0], id: transfers[0].id + 1n }]),
    ).toThrow('transfer set mismatch')
    expect(() =>
      assertReconciled(
        plan,
        [{ ...accounts[0], debits_posted: accounts[0].debits_posted + 1n }, ...accounts.slice(1)],
        transfers,
      ),
    ).toThrow('balance does not reconcile exactly')
  })

  test('creates an empty target exactly once and verifies an idempotent replay', async () => {
    const snapshot = makeSnapshot()
    const result = evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, makeTestProvenance())
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

  test('rejects a mismatched existing account before creating transfers', async () => {
    const snapshot = makeSnapshot()
    const result = evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, makeTestProvenance())
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
    const result = evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance)
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
    expect(error.message).toContain('balance does not reconcile exactly')
    expect(writes).toBe(0)
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
