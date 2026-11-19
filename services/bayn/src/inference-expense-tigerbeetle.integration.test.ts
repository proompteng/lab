import { describe, expect, test } from 'bun:test'
import { Deferred, Effect, Ref, Result } from 'effect'

import { buildInferenceExpensePlan, makeInferenceExpenseQuote } from './inference-expense'
import { postInferenceExpenses, readInferenceExpenseLedger } from './inference-expense-journal'
import { expenseRateFixture, expenseSourceFixture } from './inference-expense.test-support'
import { baynTestTigerBeetleAddress } from './test-environment.test-support'
import { makeTigerBeetleRequestClient, type TigerBeetleRequestClient } from './tigerbeetle-client'

const describeTigerBeetle = baynTestTigerBeetleAddress === undefined ? describe.skip : describe

describeTigerBeetle('native inference expense TigerBeetle records', () => {
  test('concurrent stale preflights post exact sub-micro amounts once and reconcile native balances after replay', async () => {
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
          const empty = yield* readInferenceExpenseLedger(
            client,
            {
              evidence: {
                accountBindingHash: first.accountBindingHash,
                sessionDate: first.sessionDate,
                asOf: '1970-01-01T00:00:00.000Z',
              },
              quotes: [],
            },
            Effect.succeed([]),
          )
          const plan = Result.getOrThrow(buildInferenceExpensePlan([first, second]))
          const other = yield* makeTigerBeetleRequestClient({
            operationTimeoutMs: 5_000,
            tigerBeetle: { clusterId: 20912n, replicaAddresses: [address], ledger: 7_001 },
          })
          const bothRead = yield* Deferred.make<void>()
          const preflightReads = yield* Ref.make(0)
          const withStalePreflight = (active: TigerBeetleRequestClient): TigerBeetleRequestClient => ({
            request: (operation, execute) =>
              Effect.gen(function* () {
                const value = yield* active.request(operation, execute)
                if (operation === 'lookup-preflight-transfers') {
                  const reads = yield* Ref.updateAndGet(preflightReads, (n) => n + 1)
                  if (reads === 2) yield* Deferred.succeed(bothRead, undefined)
                  yield* Deferred.await(bothRead)
                }
                return value
              }),
          })
          yield* Effect.all(
            [
              postInferenceExpenses(withStalePreflight(client), plan),
              postInferenceExpenses(withStalePreflight(other), plan),
            ],
            { concurrency: 'unbounded' },
          )
          yield* postInferenceExpenses(client, plan)
          const owners = [first, second].map((quote) => ({ quote, verifiedAt: '1970-01-01T00:01:00.000Z' }))
          const captured = yield* readInferenceExpenseLedger(
            client,
            {
              evidence: {
                accountBindingHash: first.accountBindingHash,
                sessionDate: first.sessionDate,
                asOf: '1970-01-01T00:02:00.000Z',
              },
              quotes: owners.slice(0, 1),
            },
            Effect.succeed(owners),
          )
          return { empty, captured, preflightReads: yield* Ref.get(preflightReads) }
        }),
      ),
    )
    expect(result.empty.transferCount).toBe(0)
    expect(result.preflightReads).toBe(2)
    expect(result.empty.verifiedSessionTransferCount).toBe(0)
    expect(result.empty.ledgerTimestampMax).toBe('1')
    expect(result.captured.exactLedgerPrefix).toBe(true)
    expect(result.captured.transferCount).toBe(1)
    expect(result.captured.verifiedSessionTransferCount).toBe(2)
    expect(result.captured.knownEstimatedCostPicoUsd).toBe('42000')
    expect(result.captured.invoiceReconciled).toBe(false)
  })
})
