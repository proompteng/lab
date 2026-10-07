import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Effect, Layer } from 'effect'

import type { LoadedRuntimeConfig } from './config'
import { PostgresClientLive } from './db/postgres-client'
import { postgresMigrations } from './db/postgres-migrations'
import {
  buildInferenceExpensePlan,
  inferenceExpenseLedger,
  inferenceExpenseRateCard,
  makeInferenceExpenseQuote,
} from './inference-expense'
import { postInferenceExpenses } from './inference-expense-journal'
import { makeInferenceExpenseStore } from './inference-expense-postgres'
import { InferenceCostError } from './inference-costs'
import { makeTigerBeetleRequestClient, type TigerBeetleRequestClient } from './tigerbeetle-client'

export const runInferenceExpensePass = Effect.fn('bayn.inference-expense.pass')(function* (
  store: ReturnType<typeof makeInferenceExpenseStore>,
  client: TigerBeetleRequestClient,
  rateCard: Parameters<typeof makeInferenceExpenseQuote>[1] = inferenceExpenseRateCard,
) {
  const sources = yield* store.newSources
  const quotes = yield* Effect.forEach(sources, (source) =>
    Effect.fromResult(makeInferenceExpenseQuote(source, rateCard)),
  )
  yield* store.freeze(quotes)
  const pending = yield* store.pending
  const plan = yield* Effect.fromResult(buildInferenceExpensePlan(pending))
  yield* postInferenceExpenses(client, plan)
  yield* store.acknowledge(pending)
  const summary = {
    discovered: sources.length,
    verifiedQuotes: pending.length,
    transferCount: plan.transfers.length,
    gapCount: pending.filter((quote) => quote.line.estimatedCostPicoUsd === null).length,
    estimatedCostPicoUsd: plan.transfers.reduce((total, transfer) => total + transfer.amount, 0n).toString(),
    ledger: inferenceExpenseLedger,
    unit: 'USD_PICO',
    invoiceReconciled: false,
  }
  if (sources.length > 0 || pending.length > 0)
    yield* Effect.logInfo('Bayn inference expense projection completed').pipe(Effect.annotateLogs(summary))
  return summary
})

export const inferenceExpenseLoop = <A, E, R>(pass: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    while (true) {
      yield* pass.pipe(
        Effect.catch((error) =>
          Effect.logWarning('Bayn inference expense projection unavailable; frozen quotes remain pending').pipe(
            Effect.annotateLogs({
              errorTag: typeof error === 'object' && error !== null && '_tag' in error ? String(error._tag) : 'UNKNOWN',
              ...(error instanceof InferenceCostError ? { reason: error.message } : {}),
            }),
          ),
        ),
      )
      yield* Effect.sleep('30 seconds')
    }
  })

export const startInferenceExpenseProjection = (config: LoadedRuntimeConfig) =>
  Effect.gen(function* () {
    if (config.tigerBeetle.ledger === inferenceExpenseLedger)
      return yield* new InferenceCostError({
        message: 'Trading and inference expense ledgers must use different units and identities',
      })
    const owned = Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* postgresMigrations
        const client = yield* makeTigerBeetleRequestClient(config)
        const store = makeInferenceExpenseStore(sql, config.alpaca.expectedAccountId)
        return yield* inferenceExpenseLoop(runInferenceExpensePass(store, client))
      }),
    ).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- independent background accounting owns its database and platform resources
      Effect.provide(
        PostgresClientLive({ operationTimeoutMs: config.operationTimeoutMs, postgres: config.postgres }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    )
    return yield* inferenceExpenseLoop(owned).pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError('Bayn inference expense background task stopped unexpectedly'),
      ),
      Effect.forkScoped,
    )
  })
