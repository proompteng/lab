import { createServer, type Server } from 'node:http'
import process from 'node:process'

import { Deferred, Effect, Fiber, Ref } from 'effect'

import type { BaynConfig } from './config'
import { Journal, type JournalService } from './ledger'
import { MarketData, type MarketDataService } from './market-data'
import { evaluateTsmom } from './strategy'
import type { EvaluationResult, ReconciliationResult } from './types'

interface RuntimeEvidence {
  readonly evaluation: Omit<EvaluationResult, 'events'> & { readonly eventCount: number }
  readonly reconciliation: ReconciliationResult
}

type RuntimeState =
  | { readonly status: 'STARTING'; readonly evidence: null; readonly error: null }
  | { readonly status: 'READY'; readonly evidence: RuntimeEvidence; readonly error: null }
  | { readonly status: 'FAIL_CLOSED'; readonly evidence: null; readonly error: string }

const json = (value: unknown): string =>
  JSON.stringify(value, (_, nested) => (typeof nested === 'bigint' ? nested.toString() : nested))

const publicState = (state: RuntimeState) => ({
  service: 'bayn',
  status: state.status,
  authority: { brokerOrders: false, capitalPromotion: false },
  evidence: state.evidence,
  error: state.error,
})

const makeHttpServer = (config: BaynConfig, state: Ref.Ref<RuntimeState>) =>
  Effect.acquireRelease(
    Effect.async<Server, Error>((resume) => {
      const server = createServer((request, response) => {
        void Effect.runPromise(Ref.get(state)).then((current) => {
          const path = request.url?.split('?')[0] ?? '/'
          if (request.method !== 'GET') {
            response.writeHead(405, { 'content-type': 'application/json', allow: 'GET' })
            response.end(json({ error: 'method_not_allowed' }))
            return
          }
          if (path === '/healthz') {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(json({ service: 'bayn', live: true }))
            return
          }
          if (path === '/readyz') {
            const ready = current.status === 'READY'
            response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' })
            response.end(json({ ready, status: current.status }))
            return
          }
          if (path === '/v1/status' || path === '/v1/evidence/latest') {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(json(publicState(current)))
            return
          }
          response.writeHead(404, { 'content-type': 'application/json' })
          response.end(json({ error: 'not_found' }))
        })
      })
      const onError = (cause: Error) => resume(Effect.fail(new Error(`Bayn HTTP server failed: ${cause.message}`)))
      server.once('error', onError)
      server.listen(config.port, config.host, () => {
        server.off('error', onError)
        resume(Effect.succeed(server))
      })
    }),
    (server) =>
      Effect.async<void>((resume) => {
        server.close(() => resume(Effect.void))
      }),
  )

const evaluateAndJournal = (
  config: BaynConfig,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<void, never, MarketDataService | JournalService> =>
  Effect.gen(function* () {
    const marketData = yield* MarketData
    const journal = yield* Journal
    yield* journal.check
    const snapshot = yield* marketData.load
    const evaluation = evaluateTsmom(snapshot.bars, snapshot.manifest, config.protocol, config.codeRevision)
    const reconciliation = yield* journal.journalAndReconcile(evaluation)
    const { events, ...evaluationWithoutEvents } = evaluation
    yield* Ref.set(state, {
      status: 'READY',
      evidence: { evaluation: { ...evaluationWithoutEvents, eventCount: events.length }, reconciliation },
      error: null,
    })
  }).pipe(
    Effect.catchAll((cause) =>
      Ref.set(state, {
        status: 'FAIL_CLOSED',
        evidence: null,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    ),
  )

const checkWithoutJournal = (
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<void, never, MarketDataService | JournalService> =>
  Effect.gen(function* () {
    const marketData = yield* MarketData
    const journal = yield* Journal
    yield* journal.check
    yield* marketData.load
    yield* Ref.set(state, {
      status: 'FAIL_CLOSED',
      evidence: null,
      error: 'BAYN_RUN_ON_STARTUP=false; evaluation and accounting proof were not executed',
    })
  }).pipe(
    Effect.catchAll((cause) =>
      Ref.set(state, {
        status: 'FAIL_CLOSED',
        evidence: null,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    ),
  )

export const runBayn = (config: BaynConfig): Effect.Effect<void, Error, MarketDataService | JournalService> =>
  Effect.scoped(
    Effect.gen(function* () {
      const state = yield* Ref.make<RuntimeState>({ status: 'STARTING', evidence: null, error: null })
      yield* makeHttpServer(config, state)
      const work = config.runOnStartup ? evaluateAndJournal(config, state) : checkWithoutJournal(state)
      const worker = yield* Effect.forkScoped(work)

      const shutdown = yield* Deferred.make<void>()
      const onSignal = () => {
        Effect.runFork(Deferred.succeed(shutdown, undefined))
      }
      process.once('SIGINT', onSignal)
      process.once('SIGTERM', onSignal)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.off('SIGINT', onSignal)
          process.off('SIGTERM', onSignal)
        }),
      )
      yield* Deferred.await(shutdown)
      yield* Fiber.interrupt(worker)
    }),
  )
