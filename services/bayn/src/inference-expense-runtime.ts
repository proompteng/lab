import { makeResearchStore, projectResearchExpenses } from './research-inference/store'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import * as PgConnection from '@effect/sql-pg/PgConnection'
import { Cause, Clock, Duration, Effect, Queue, Schedule, Schema } from 'effect'
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
import { makeJevTerminalBatchSettlementCursor } from './db/jev-batch-postgres'
import { InferenceCostError } from './inference-costs'
import { makeTigerBeetleRequestClient, type TigerBeetleRequestClient } from './tigerbeetle-client'

export const runInferenceExpensePass = Effect.fn('bayn.inference-expense.pass')(function* (
  store: Pick<
    ReturnType<typeof makeInferenceExpenseStore>,
    'newSources' | 'freeze' | 'pending' | 'acknowledge' | 'settleExpiredTerminalBatches' | 'settleExpiredInferenceWork'
  >,
  client: TigerBeetleRequestClient,
  rateCard: Parameters<typeof makeInferenceExpenseQuotes>[1] = inferenceExpenseRateCard,
) {
  // This history scan owns independent expense SQL; it must never extend an account's protection turn.
  const inferenceWork = yield* store.settleExpiredInferenceWork
  const settlement = yield* store.settleExpiredTerminalBatches
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
    settledBatchCandidates: settlement.candidates,
    sealedBatchCount: settlement.sealed,
    pendingBatchCount: settlement.pending,
    failedBatchCount: settlement.failed,
    sealedInferenceWorkCount: inferenceWork.sealed,
    failedInferenceWorkCount: inferenceWork.failed,
    inferenceWorkRecoveryPending: inferenceWork.remaining,
    ledger: inferenceExpenseLedger,
    unit: 'USD_PICO',
    invoiceReconciled: false,
  }
  if (
    sources.length > 0 ||
    pending.length > 0 ||
    settlement.candidates > 0 ||
    inferenceWork.sealed > 0 ||
    inferenceWork.failed > 0
  )
    yield* Effect.logInfo('Bayn inference expense projection completed').pipe(Effect.annotateLogs(summary))
  return summary
})

type ExpenseContinuation = { readonly pending: boolean; readonly nextWakeAt: string | null }

const expenseRecoverySchedule = Schedule.exponential('1 second').pipe(
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(30)))),
)

const logExpenseFailure = (error: unknown) =>
  Effect.logWarning('Bayn inference expense projection unavailable; frozen quotes remain pending').pipe(
    Effect.annotateLogs({
      errorTag: typeof error === 'object' && error !== null && '_tag' in error ? String(error._tag) : 'UNKNOWN',
      ...(error instanceof InferenceCostError ? { reason: error.message } : {}),
    }),
  )

// PostgreSQL retains microseconds. Round a future deadline up instead of firing before its original instant.
const expenseWakeAtMillis = (at: string) => {
  const fraction = /\.(\d+)(?:Z|[+-]\d\d(?::?\d\d)?)$/.exec(at)?.[1]
  return Date.parse(at) + (fraction !== undefined && /[1-9]/.test(fraction.slice(3)) ? 1 : 0)
}

export const inferenceExpenseLoop = <E, R>(
  changed: Queue.Dequeue<void>,
  pass: Effect.Effect<ExpenseContinuation | undefined, E, R>,
) =>
  Effect.gen(function* () {
    while (true) {
      // Clear only before the drain: a commit during it must retain its wakeup.
      yield* Queue.clear(changed)
      const continuation = yield* pass.pipe(
        Effect.tapError(logExpenseFailure),
        Effect.retry({ schedule: expenseRecoverySchedule }),
      )
      if (continuation === undefined) {
        // Another replica owns this known drain. Retain the obligation until its lock is released or lost.
        yield* Effect.sleep('1 second')
        continue
      }
      if (continuation.pending) {
        yield* Effect.yieldNow
        continue
      }
      if (continuation.nextWakeAt === null) yield* Queue.take(changed)
      else {
        const now = yield* Clock.currentTimeMillis
        yield* Queue.take(changed).pipe(
          Effect.raceFirst(Effect.sleep(Math.max(0, expenseWakeAtMillis(continuation.nextWakeAt) - now))),
        )
      }
    }
  })

export const listenInferenceExpenses = <E, R>(
  postgres: PgClient.PgClientConfig,
  channel: string,
  pass: Effect.Effect<ExpenseContinuation | undefined, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (postgres.connectTimeout === undefined)
        return yield* new InferenceCostError({ message: 'Inference expense listener requires a PostgreSQL deadline' })
      const connection = yield* PgConnection.make(postgres)
      const pinned = yield* connection.pin
      // Registration completes only after LISTEN ACK, before the first durable drain.
      const notifications = yield* pinned.listen(channel)
      const changed = yield* Queue.dropping<void>(1)
      const receive = Queue.take(notifications).pipe(Effect.andThen(Queue.offer(changed, undefined)), Effect.forever)
      // LISTEN pins this session. The pinned API keeps this exact socket alive without a transaction or work query.
      const keepAlive = Effect.sleep(Duration.toMillis(postgres.connectTimeout) / 2).pipe(
        Effect.andThen(pinned.query('SELECT 1')),
        Effect.forever,
      )
      return yield* inferenceExpenseLoop(changed, pass).pipe(
        Effect.raceFirst(receive.pipe(Effect.raceFirst(keepAlive))),
      )
    }),
  )

const OwnershipRows = Schema.Tuple([Schema.Struct({ acquired: Schema.Boolean })])

export const withInferenceExpenseOwner = <A, E, R>(
  postgres: PgClient.PgClientConfig,
  projection: string,
  pass: (sql: PgClient.PgClient) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const deadline = postgres.connectTimeout
      if (deadline === undefined)
        return yield* new InferenceCostError({ message: 'Inference expense ownership requires a PostgreSQL deadline' })
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
      // PostgresClientLive uses the statement budget for connectTimeout, below the socket inactivity deadline.
      // Ledger requests can outlast that inactivity budget; keep this same session alive without a transaction.
      const keepAlive = Effect.sleep(Duration.toMillis(deadline) / 2).pipe(
        Effect.andThen(sql`SELECT 1`),
        Effect.mapError(
          (cause) => new InferenceCostError({ message: 'Inference expense ownership session was lost', cause }),
        ),
        Effect.forever,
      )
      return yield* Effect.raceFirst(pass(sql), keepAlive)
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
        // Keep the settlement hint outside each pass's store and physical PostgreSQL
        // session. It is only a fairness hint; committed batch results remain the
        // authority and a process restart may safely reset this cursor.
        const settlementCursor = makeJevTerminalBatchSettlementCursor(config.alpaca.expectedAccountId)
        const research = listenInferenceExpenses(
          postgres,
          'bayn_inference_expense_research',
          withInferenceExpenseOwner(postgres, 'research', (sql) => {
            const store = makeResearchStore(sql)
            return projectResearchExpenses(store, client).pipe(Effect.andThen(store.continuation))
          }),
        ).pipe(Effect.tapError(logExpenseFailure), Effect.retry({ schedule: expenseRecoverySchedule }))
        const account = listenInferenceExpenses(
          postgres,
          'bayn_inference_expense_account',
          withInferenceExpenseOwner(postgres, `account:${config.alpaca.expectedAccountId}`, (sql) => {
            const store = makeInferenceExpenseStore(sql, config.alpaca.expectedAccountId, undefined, settlementCursor)
            return Effect.gen(function* () {
              const summary = yield* runInferenceExpensePass(store, client)
              if (summary.failedBatchCount > 0)
                return yield* new InferenceCostError({ message: 'Terminal batch expense settlement remains pending' })
              return yield* store.continuation
            })
          }),
        ).pipe(Effect.tapError(logExpenseFailure), Effect.retry({ schedule: expenseRecoverySchedule }))
        return yield* account.pipe(Effect.raceFirst(research))
      }),
    ).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- independent background accounting owns its platform resources
      Effect.provide(NodeServices.layer),
    )
    return yield* owned.pipe(
      Effect.tapError(logExpenseFailure),
      Effect.retry({ schedule: expenseRecoverySchedule }),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError('Bayn inference expense background task stopped unexpectedly'),
      ),
      Effect.forkScoped,
    )
  })
