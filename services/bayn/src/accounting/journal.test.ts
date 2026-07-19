import { describe, expect, test } from 'bun:test'
import { Effect, Either } from 'effect'

import { BaynReconciliationError, TigerBeetleDuplicateConflictError } from './errors'
import { journalEvaluation } from './journal'
import { reconcileEvaluation, requireExactReconciliation } from './reconcile'
import { evaluationFixture, FakeTigerBeetleClient } from './test-support'
import type { PlannedTransferKind } from './types'
import { makeTigerBeetleTestLayer } from './tigerbeetle-client'

describe('idempotent Bayn evaluation journal', () => {
  test('replay creates no duplicate economics and reconciles exactly', async () => {
    const rawClient = new FakeTigerBeetleClient()
    const layer = makeTigerBeetleTestLayer(rawClient)
    const evaluation = evaluationFixture()

    const first = await Effect.runPromise(journalEvaluation(evaluation).pipe(Effect.provide(layer)))
    const balancesAfterFirst = new Map(
      [...rawClient.accounts].map(([id, account]) => [
        id,
        { debits: account.debits_posted, credits: account.credits_posted },
      ]),
    )
    const second = await Effect.runPromise(journalEvaluation(evaluation).pipe(Effect.provide(layer)))
    const independentReconciliation = await Effect.runPromise(
      reconcileEvaluation(evaluation).pipe(Effect.provide(layer)),
    )

    expect(first.accounts).toEqual({ created: 8, existing: 0 })
    expect(first.transfers).toEqual({ created: 10, existing: 0 })
    expect(second.accounts).toEqual({ created: 0, existing: 8 })
    expect(second.transfers).toEqual({ created: 0, existing: 10 })
    expect(second.reconciliation.ok).toBe(true)
    expect(independentReconciliation.ok).toBe(true)
    expect(rawClient.accounts.size).toBe(8)
    expect(rawClient.transfers.size).toBe(10)
    expect(
      new Map(
        [...rawClient.accounts].map(([id, account]) => [
          id,
          { debits: account.debits_posted, credits: account.credits_posted },
        ]),
      ),
    ).toEqual(balancesAfterFirst)
  })

  test('reusing an evaluation identity with changed economics fails before any new transfer', async () => {
    const rawClient = new FakeTigerBeetleClient()
    const layer = makeTigerBeetleTestLayer(rawClient)
    const original = evaluationFixture()
    await Effect.runPromise(journalEvaluation(original).pipe(Effect.provide(layer)))

    const changed = evaluationFixture()
    changed.trades[0]!.grossAmount += 1n
    changed.ending.cash -= 1n
    changed.ending.equity -= 1n
    const result = await Effect.runPromise(journalEvaluation(changed).pipe(Effect.provide(layer), Effect.either))

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(TigerBeetleDuplicateConflictError)
      expect(result.left).toMatchObject({ entity: 'account', field: 'user_data_128' })
    }
    expect(rawClient.transfers.size).toBe(10)
    expect(rawClient.createTransfersCallCount).toBe(1)
  })

  test('any transfer or ending account mismatch fails exact reconciliation', async () => {
    const rawClient = new FakeTigerBeetleClient()
    const layer = makeTigerBeetleTestLayer(rawClient)
    const journaled = await Effect.runPromise(journalEvaluation(evaluationFixture()).pipe(Effect.provide(layer)))

    const trade = journaled.plan.transfers.find(({ kind }) => kind === 'trade-cash')!.transfer
    rawClient.transfers.get(trade.id)!.amount += 1n
    const cash = journaled.plan.accounts.find(({ kind }) => kind === 'cash')!.account
    rawClient.accounts.get(cash.id)!.credits_posted += 1n

    const result = await Effect.runPromise(
      requireExactReconciliation(journaled.plan).pipe(Effect.provide(layer), Effect.either),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(BaynReconciliationError)
      if (result.left instanceof BaynReconciliationError) {
        expect(result.left.report.ok).toBe(false)
        expect(result.left.report.differences).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ entity: 'transfer', field: 'amount' }),
            expect.objectContaining({ entity: 'account', semanticKey: 'cash', field: 'credits_posted' }),
            expect.objectContaining({ entity: 'evaluation', field: 'cash' }),
          ]),
        )
      }
    }
  })

  test('a missing expected trade fails reconciliation instead of being ignored', async () => {
    const rawClient = new FakeTigerBeetleClient()
    const layer = makeTigerBeetleTestLayer(rawClient)
    const journaled = await Effect.runPromise(journalEvaluation(evaluationFixture()).pipe(Effect.provide(layer)))
    const trade = journaled.plan.transfers.find(({ kind }) => kind === 'trade-quantity')!.transfer
    rawClient.transfers.delete(trade.id)

    const result = await Effect.runPromise(
      requireExactReconciliation(journaled.plan).pipe(Effect.provide(layer), Effect.either),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result) && result.left instanceof BaynReconciliationError) {
      expect(result.left.report.actualTransferCount).toBe(9)
      expect(result.left.report.differences).toEqual(
        expect.arrayContaining([expect.objectContaining({ entity: 'transfer', field: 'exists', actual: 'missing' })]),
      )
    }
  })

  for (const kind of [
    'initial-cash',
    'cash-entry',
    'trade-cash',
    'trade-quantity',
    'fee',
    'ending-valuation',
  ] satisfies readonly PlannedTransferKind[]) {
    test(`detects an exact ${kind} transfer mismatch`, async () => {
      const rawClient = new FakeTigerBeetleClient()
      const layer = makeTigerBeetleTestLayer(rawClient)
      const journaled = await Effect.runPromise(journalEvaluation(evaluationFixture()).pipe(Effect.provide(layer)))
      const expected = journaled.plan.transfers.find((transfer) => transfer.kind === kind)!.transfer
      rawClient.transfers.get(expected.id)!.amount += 1n

      const result = await Effect.runPromise(
        requireExactReconciliation(journaled.plan).pipe(Effect.provide(layer), Effect.either),
      )

      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result) && result.left instanceof BaynReconciliationError) {
        expect(result.left.report.differences).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ entity: 'transfer', id: expected.id.toString(), field: 'amount' }),
          ]),
        )
      }
    })
  }
})
