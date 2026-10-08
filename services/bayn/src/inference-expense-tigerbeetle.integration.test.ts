import { describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'

import { buildInferenceExpensePlan, makeInferenceExpenseQuote } from './inference-expense'
import { postInferenceExpenses, readInferenceExpenseLedger } from './inference-expense-journal'
import { expenseRateFixture, expenseSourceFixture } from './inference-expense.test-support'
import { baynTestTigerBeetleAddress } from './test-environment.test-support'
import { makeTigerBeetleRequestClient } from './tigerbeetle-client'

const describeTigerBeetle = baynTestTigerBeetleAddress === undefined ? describe.skip : describe

describeTigerBeetle('native inference expense TigerBeetle records', () => {
  test('posts exact sub-micro amounts once and reconciles native balances after replay', async () => {
    const address = baynTestTigerBeetleAddress ?? '127.0.0.1:3000'
    if (!/^127\.0\.0\.1:\d+$/.test(address))
      throw new Error('Inference expense integration requires an isolated loopback TigerBeetle cluster')
    const accountId = `synthetic-inference-expense-${crypto.randomUUID()}`
    const first = Result.getOrThrow(makeInferenceExpenseQuote(expenseSourceFixture({ accountId }), expenseRateFixture))
    const second = Result.getOrThrow(
      makeInferenceExpenseQuote(expenseSourceFixture({ accountId, key: 'b', inputTokens: 2 }), expenseRateFixture),
    )
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* makeTigerBeetleRequestClient({
            operationTimeoutMs: 5_000,
            tigerBeetle: { clusterId: 20912n, replicaAddresses: [address], ledger: 7_001 },
          })
          const plan = Result.getOrThrow(buildInferenceExpensePlan([first, second]))
          yield* postInferenceExpenses(client, plan)
          yield* postInferenceExpenses(client, plan)
          return yield* readInferenceExpenseLedger(client, first.accountBindingHash, first.sessionDate, [first, second])
        }),
      ),
    )
    expect(result.exactQuotedLedger).toBe(true)
    expect(result.transferCount).toBe(2)
    expect(result.knownEstimatedCostPicoUsd).toBe('126000')
    expect(result.invoiceReconciled).toBe(false)
  })
})
