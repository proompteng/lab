import { makeResearchStore, projectResearchExpenses } from './research-inference/store'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Effect, Schema } from 'effect'
import { Statement } from 'effect/sql'

import type { LoadedRuntimeConfig } from './config/model'
import { PostgresClientLive } from './db/postgres-client'
import { postgresMigrations } from './db/postgres-migrations'
import {
  buildInferenceExpensePlan,
  inferenceExpenseLedger,
  inferenceExpenseRateCard,
  makeInferenceExpenseQuotes,
  inferenceExpenseBatchSize,
} from './inference-expense'
import { postInferenceExpenses } from './inference-expense-journal'
import { makeInferenceExpenseStore } from './inference-expense-postgres'
import { InferenceCostError } from './inference-costs'
import { makeTigerBeetleRequestClient, type TigerBeetleRequestClient } from './tigerbeetle-client'

export const runInferenceExpensePass = Effect.fn('bayn.inference-expense.pass')(function* (
  store: Pick<ReturnType<typeof makeInferenceExpenseStore>, 'newSources' | 'freeze' | 'pending' | 'acknowledge'>,
  client: TigerBeetleRequestClient,
  rateCard: Parameters<typeof makeInferenceExpenseQuotes>[1] = inferenceExpenseRateCard,
) {
  const sources = yield* store.newSources
  const quotes = (yield* Effect.forEach(sources, (source) =>
    Effect.fromResult(makeInferenceExpenseQuotes(source, rateCard)),
  )).flat()
  for (let offset = 0; offset < quotes.length; offset += inferenceExpenseBatchSize)
    yield* store.freeze(quotes.slice(offset, offset + inferenceExpenseBatchSize))
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

const OwnershipRows = Schema.Tuple([Schema.Struct({ acquired: Schema.Boolean })])

export const withInferenceExpenseOwner = <A, E, R>(
  postgres: PgClient.PgClientConfig,
  projection: string,
  pass: (sql: PgClient.PgClient) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const [{ acquired }] = yield* sql`
        SELECT pg_try_advisory_lock(hashtextextended(${`bayn.inference-expense-projection.v1:${projection}`}, 0)) AS acquired
      `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(OwnershipRows)),
        Effect.mapError(
          (cause) => new InferenceCostError({ message: 'Inference expense ownership could not be acquired', cause }),
        ),
      )
      if (!acquired) return
      return yield* pass(sql)
    }).pipe(
      // A physical session owns this advisory lock, including when its acquisition response is lost.
      // Closing it releases ownership on every exit; no pooled session or transaction spans ledger I/O.
      // @effect-diagnostics-next-line strictEffectProvide:off -- each projection pass owns its PostgreSQL session
      Effect.provide(PgClient.layerFrom(PgClient.makeClient(postgres))),
      Effect.provideService(Statement.SpanPropagationEnabled, true),
    ),
  )

export const startInferenceExpenseProjection = (config: LoadedRuntimeConfig) =>
  Effect.gen(function* () {
    if (config.tigerBeetle.ledger === inferenceExpenseLedger)
      return yield* new InferenceCostError({
        message: 'Trading and inference expense ledgers must use different units and identities',
      })
    const owned = Effect.scoped(
      Effect.gen(function* () {
        const postgres = yield* Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* postgresMigrations
          return sql.config
        }).pipe(
          // Close the bootstrap pool before the two independent projection sessions start.
          // @effect-diagnostics-next-line strictEffectProvide:off -- migration startup owns its configured PostgreSQL pool
          Effect.provide(
            PostgresClientLive(
              { operationTimeoutMs: config.operationTimeoutMs, postgres: config.postgres },
              { maxConnections: 2, applicationName: 'bayn-inference-expenses' },
            ),
          ),
        )
        const client = yield* makeTigerBeetleRequestClient(config)
        yield* inferenceExpenseLoop(
          withInferenceExpenseOwner(postgres, 'research', (sql) =>
            projectResearchExpenses(makeResearchStore(sql), client),
          ),
        ).pipe(Effect.forkScoped)
        return yield* inferenceExpenseLoop(
          withInferenceExpenseOwner(postgres, `account:${config.alpaca.expectedAccountId}`, (sql) =>
            runInferenceExpensePass(makeInferenceExpenseStore(sql, config.alpaca.expectedAccountId), client),
          ),
        )
      }),
    ).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- independent background accounting owns its platform resources
      Effect.provide(NodeServices.layer),
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
