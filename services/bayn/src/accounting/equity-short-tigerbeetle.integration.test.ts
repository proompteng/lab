import { describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'

import { OrderSide, type Fill } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import { Journal, JournalLive } from '../ledger'
import { baynTestTigerBeetleAddress } from '../test-environment.test-support'
import { AccountingInventorySide, prepareAccounting, rebuildAccountingLedger } from './domain'
import type { PositionCost } from './model'

const integration = baynTestTigerBeetleAddress === undefined ? describe.skip : describe

integration('equity short native ledger', () => {
  test('posts, restarts, replays and reconciles partial covers and an unbounded adverse cover exactly once', async () => {
    const address = baynTestTigerBeetleAddress ?? ''
    if (!/^127\.0\.0\.1:\d+$/.test(address))
      throw new Error('Short ledger integration requires an isolated loopback TigerBeetle cluster')
    const accountId = `synthetic-equity-short-${crypto.randomUUID()}`
    const config = {
      operationTimeoutMs: 5_000,
      tigerBeetle: { clusterId: 20912n, replicaAddresses: [address], ledger: 7_001 },
    }
    let prior: PositionCost = { quantityAtoms: '0', costMicros: '0' }
    const prepared = (
      [
        [OrderSide.Sell, 3n, 100n],
        [OrderSide.Buy, 1n, 90n],
        [OrderSide.Buy, 2n, 350n],
      ] as const
    ).map(([side, quantity, price], index) => {
      const fill: Fill = {
        schemaVersion: 'bayn.fill.v2',
        accountId,
        fillId: `${index}`,
        brokerOrderId: `${index}`,
        clientOrderId: `${index}`,
        symbol: 'AAPL',
        side,
        quantityAtoms: (quantity * 1_000_000_000n).toString(),
        priceAtoms: (price * 1_000_000_000n).toString(),
        feeMicros: '10000',
        occurredAt: `2026-11-13T15:0${index}:00.000Z`,
      }
      const eventId = Result.getOrThrow(canonicalHashV1Result({ accountId, index }))
      const value = Result.getOrThrow(prepareAccounting(eventId, fill, prior, 7001, AccountingInventorySide.Short))
      prior = {
        quantityAtoms: (BigInt(prior.quantityAtoms) + BigInt(value.transaction.quantityDeltaAtoms)).toString(),
        costMicros: (BigInt(prior.costMicros) + BigInt(value.transaction.costBasisDeltaMicros)).toString(),
      }
      return value
    })
    const plans = prepared.map(({ transaction }) => Result.getOrThrow(rebuildAccountingLedger(transaction, 7001)))
    // Closing the first scoped client models a process restart after the opening and partial cover.
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal
        for (const plan of plans.slice(0, 2)) yield* journal.post(plan)
        expect(yield* journal.verifyAccount(accountId, plans.slice(0, 2))).toBe(true)
      }).pipe(Effect.provide(JournalLive(config))),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Journal
        for (const plan of plans) yield* journal.post(plan)
        for (const plan of plans) yield* journal.post(plan)
        expect(yield* journal.verifyAccount(accountId, plans)).toBe(true)
      }).pipe(Effect.provide(JournalLive(config))),
    )
    expect(prior).toEqual({ quantityAtoms: '0', costMicros: '0' })
    expect(prepared.reduce((sum, p) => sum + BigInt(p.transaction.realizedPnlMicros), 0n)).toBe(-490_000_000n)
    expect(prepared.reduce((sum, p) => sum + BigInt(p.transaction.cashDeltaMicros), 0n)).toBe(-490_030_000n)
  })
})
