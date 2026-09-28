import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'
import { createClient, CreateAccountStatus, CreateTransferStatus } from 'tigerbeetle-node'

import { prepareAccounting } from '../accounting/domain'
import { OrderSide, type Fill } from '../execution/contracts'
import { readForwardPerformanceLedger } from '../forward-performance/tigerbeetle'
import { Journal, JournalLive } from '../ledger'
import { LEDGER_BATCH_MAX, type LedgerPlan, type LedgerQueryFilter } from '../ledger-plan'
import type { JournalDependencies, TigerBeetleClient } from '../tigerbeetle-client'
import { assembleAccountPlan } from './decisions'

const accountId = 'cumulative-account'
const config = {
  operationTimeoutMs: 1_000,
  tigerBeetle: { clusterId: 2_001n, replicaAddresses: ['3000'], ledger: 7_001 },
}

const success = <A, E>(value: Result.Result<A, E>): A => {
  assert(Result.isSuccess(value), Result.isFailure(value) ? String(value.failure) : undefined)
  return value.success
}

const history = () => {
  const plans: LedgerPlan[] = []
  for (let index = 0; index < 2_100; index += 1) {
    for (const side of [OrderSide.Buy, OrderSide.Sell]) {
      const identity = `${index}-${side}`
      const fill: Fill = {
        schemaVersion: 'bayn.paper-fill.v1',
        accountId,
        fillId: identity,
        brokerOrderId: `broker-${identity}`,
        clientOrderId: `client-${identity}`,
        symbol: 'NVDA',
        side,
        quantityMicros: '1000000',
        priceMicros: side === OrderSide.Buy ? '100000000' : '110000000',
        feeMicros: '100',
        occurredAt: '2026-09-18T15:30:00.000Z',
      }
      plans.push(
        success(
          prepareAccounting(
            (index * 2 + (side === OrderSide.Buy ? 1 : 2)).toString(16).padStart(64, '0'),
            fill,
            side === OrderSide.Buy
              ? { quantityMicros: '0', costMicros: '0' }
              : { quantityMicros: '1000000', costMicros: '100000000' },
            config.tigerBeetle.ledger,
          ),
        ).ledger,
      )
    }
  }
  const plan = success(assembleAccountPlan(accountId, plans))
  const accounts = plan.accounts.map((account, index) => ({ ...account, timestamp: BigInt(index + 1) }))
  const accountsById = new Map(accounts.map((account) => [account.id, account]))
  const transfers = plan.transfers.map((transfer, index) => ({ ...transfer, timestamp: BigInt(index + 1) }))
  for (const transfer of transfers) {
    const debit = accountsById.get(transfer.debit_account_id)
    const credit = accountsById.get(transfer.credit_account_id)
    assert(debit !== undefined && credit !== undefined)
    debit.debits_posted += transfer.amount
    credit.credits_posted += transfer.amount
  }
  return { plan, plans, accounts, transfers }
}

const fixture = history()

const queryPage = <A extends { readonly timestamp: bigint }>(records: readonly A[], filter: LedgerQueryFilter) => {
  expect(filter.limit).toBeGreaterThan(0)
  expect(filter.limit).toBeLessThanOrEqual(LEDGER_BATCH_MAX)
  return records.filter((record) => record.timestamp >= filter.timestamp_min).slice(0, filter.limit)
}

const reader = (overrides: Partial<TigerBeetleClient> = {}) => {
  const queries: LedgerQueryFilter[] = []
  let closed = 0
  const dependencies: JournalDependencies = {
    resolveReplicaAddresses: () => Effect.succeed(['3000']),
    createClient: () => ({
      createAccounts: async () => {
        throw new Error('read-only verification must not post accounts')
      },
      createTransfers: async () => {
        throw new Error('read-only verification must not post transfers')
      },
      lookupAccounts: async () => [],
      lookupTransfers: async () => [],
      queryAccounts: async (filter) => queryPage(fixture.accounts, filter),
      queryTransfers: async (filter) => {
        queries.push(filter)
        return queryPage(fixture.transfers, filter)
      },
      destroy: () => {
        closed += 1
      },
      ...overrides,
    }),
  }
  return { dependencies, queries, closed: () => closed }
}

const verify = (dependencies: JournalDependencies) =>
  Effect.gen(function* () {
    const journal = yield* Journal
    return yield* journal.verifyAccount(accountId, fixture.plans)
  }).pipe(Effect.provide(JournalLive(config, dependencies)))

describe('cumulative account history', () => {
  test.skipIf(process.env['BAYN_TEST_TIGERBEETLE_ADDRESS'] === undefined)(
    'reconciles cumulative history through the pinned TigerBeetle server',
    async () => {
      const address = process.env['BAYN_TEST_TIGERBEETLE_ADDRESS']
      assert(address !== undefined && /^127\.0\.0\.1:[0-9]{1,5}$/.test(address), 'use an isolated loopback test server')
      const client = createClient({ cluster_id: config.tigerBeetle.clusterId, replica_addresses: [address] })
      try {
        const accounts = await client.createAccounts([...fixture.plan.accounts])
        expect(
          accounts.every(
            (result) => result.status === CreateAccountStatus.created || result.status === CreateAccountStatus.exists,
          ),
        ).toBe(true)
        for (let offset = 0; offset < fixture.plan.transfers.length; offset += 128) {
          const transfers = await client.createTransfers(fixture.plan.transfers.slice(offset, offset + 128))
          expect(
            transfers.every(
              (result) =>
                result.status === CreateTransferStatus.created || result.status === CreateTransferStatus.exists,
            ),
          ).toBe(true)
        }
      } finally {
        client.destroy()
      }
      const liveConfig = { ...config, tigerBeetle: { ...config.tigerBeetle, replicaAddresses: [address] } }
      const verifyLive = Effect.gen(function* () {
        return yield* (yield* Journal).verifyAccount(accountId, fixture.plans)
      }).pipe(Effect.provide(JournalLive(liveConfig)))
      expect(await Effect.runPromise(verifyLive)).toBe(true)
      expect(await Effect.runPromise(verifyLive)).toBe(true)
      const evidence = await Effect.runPromise(
        Effect.scoped(readForwardPerformanceLedger(liveConfig, accountId, fixture.plans)),
      )
      expect(evidence.ledgerExact).toBe(true)
      expect(evidence.totals.brokerExecutionFeesMicros).toBe('420000')
    },
    15_000,
  )

  test('reconciles more than 10,000 transfers including fees after reopening the reader', async () => {
    expect(fixture.transfers.length).toBeGreaterThan(10_000)
    const target = reader()
    expect(await Effect.runPromise(verify(target.dependencies))).toBe(true)
    expect(target.queries.length).toBeGreaterThan(1)
    expect(target.queries[1]?.timestamp_min).toBe(BigInt(LEDGER_BATCH_MAX + 1))
    expect(target.closed()).toBe(1)
    expect(await Effect.runPromise(verify(target.dependencies))).toBe(true)
    expect(target.closed()).toBe(2)
  })

  test('forward performance reconciles the whole history and retains generation totals', async () => {
    const target = reader()
    const evidence = await Effect.runPromise(
      Effect.scoped(readForwardPerformanceLedger(config, accountId, fixture.plans, undefined, target.dependencies)),
    )
    expect(evidence).toMatchObject({
      ledgerExact: true,
      missingLedgerAccountCount: 0,
      openPositionCount: 0,
      totals: { realizedGainMicros: '21000000000', brokerExecutionFeesMicros: '420000' },
    })
  })

  test('continues when the server returns a smaller page than requested', async () => {
    const target = reader({
      queryAccounts: async (filter) => queryPage(fixture.accounts, { ...filter, limit: Math.min(2, filter.limit) }),
      queryTransfers: async (filter) => queryPage(fixture.transfers, { ...filter, limit: Math.min(500, filter.limit) }),
    })
    expect(await Effect.runPromise(verify(target.dependencies))).toBe(true)
  })

  test.each(['missing', 'duplicate', 'changed', 'extra'] as const)(
    'rejects %s transfer evidence beyond the first page',
    async (fault) => {
      const transfers = [...fixture.transfers]
      const last = transfers.at(-1)
      const first = transfers[0]
      assert(last !== undefined && first !== undefined)
      if (fault === 'missing') transfers.pop()
      if (fault === 'duplicate') transfers[transfers.length - 1] = { ...last, id: first.id }
      if (fault === 'changed') transfers[transfers.length - 1] = { ...last, amount: last.amount + 1n }
      if (fault === 'extra') transfers.push({ ...last, id: last.id + 1n, timestamp: last.timestamp + 1n })
      const target = reader({ queryTransfers: async (filter) => queryPage(transfers, filter) })
      expect(await Effect.runPromise(verify(target.dependencies))).toBe(false)
    },
  )

  test('rejects a nonadvancing second page without looping', async () => {
    let reads = 0
    const target = reader({
      queryTransfers: async (filter) => {
        reads += 1
        return queryPage(fixture.transfers, { ...filter, timestamp_min: 0n })
      },
    })
    const error = await Effect.runPromise(Effect.flip(verify(target.dependencies)))
    expect(error).toMatchObject({
      operation: 'verify-account',
      cause: { reason: 'invalid-query-page' },
    })
    expect(reads).toBe(2)
    expect(target.closed()).toBe(1)
  })

  test('propagates a later page transport failure and reopens for a complete retry', async () => {
    let unavailable = true
    const target = reader({
      queryTransfers: async (filter) => {
        if (unavailable && filter.timestamp_min > 1n) throw new Error('lost second page')
        return queryPage(fixture.transfers, filter)
      },
    })
    const error = await Effect.runPromise(Effect.flip(verify(target.dependencies)))
    expect(error).toMatchObject({ operation: 'verify-account-transfers' })
    expect(target.closed()).toBe(1)
    unavailable = false
    expect(await Effect.runPromise(verify(target.dependencies))).toBe(true)
    expect(target.closed()).toBe(2)
  })

  test('rejects duplicate expected history before querying', async () => {
    const first = fixture.plans[0]
    assert(first !== undefined)
    const target = reader()
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal
        return yield* Effect.flip(journal.verifyAccount(accountId, [...fixture.plans, first]))
      }).pipe(Effect.provide(JournalLive(config, target.dependencies))),
    )
    expect(error).toMatchObject({ cause: { reason: 'duplicate-transfer' } })
    expect(target.queries).toHaveLength(0)
  })

  test.each([LEDGER_BATCH_MAX - 1, LEDGER_BATCH_MAX, LEDGER_BATCH_MAX + 1])(
    'checks the extra-record sentinel at %d expected transfers',
    async (count) => {
      const plan = { ...fixture.plan, transfers: fixture.plan.transfers.slice(0, count) }
      const balances = new Map(plan.accounts.map((account) => [account.id, { debits: 0n, credits: 0n }]))
      for (const transfer of plan.transfers) {
        const debit = balances.get(transfer.debit_account_id)
        const credit = balances.get(transfer.credit_account_id)
        assert(debit !== undefined && credit !== undefined)
        debit.debits += transfer.amount
        credit.credits += transfer.amount
      }
      const accounts = fixture.accounts.map((account) => {
        const balance = balances.get(account.id)
        assert(balance !== undefined)
        return { ...account, debits_posted: balance.debits, credits_posted: balance.credits }
      })
      for (const extra of [false, true]) {
        const transfers = fixture.transfers.slice(0, count + (extra ? 1 : 0))
        const target = reader({
          queryAccounts: async (filter) => queryPage(accounts, filter),
          queryTransfers: async (filter) => queryPage(transfers, filter),
        })
        const exact = await Effect.runPromise(
          Effect.gen(function* () {
            return yield* (yield* Journal).verifyAccount(accountId, [plan])
          }).pipe(Effect.provide(JournalLive(config, target.dependencies))),
        )
        expect(exact).toBe(!extra)
      }
    },
  )
})
