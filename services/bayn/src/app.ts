import { createServer, type Server } from 'node:http'
import process from 'node:process'

import { Deferred, Effect, Ref, Runtime } from 'effect'

import type { BaynConfig } from './config'
import { baynError, formatBaynError, type BaynComponent, type BaynError } from './errors'
import { Journal, type JournalService } from './ledger'
import { MarketData, type MarketDataService } from './market-data'
import { evaluateTsmom } from './strategy'
import type { EvaluationResult, ReconciliationResult } from './types'

interface RuntimeEvidence {
  readonly evaluation: Omit<EvaluationResult, 'events'> & { readonly eventCount: number }
  readonly reconciliation: ReconciliationResult
}

export type RuntimeState =
  | { readonly status: 'STARTING'; readonly evidence: null; readonly error: null }
  | { readonly status: 'READY'; readonly evidence: RuntimeEvidence; readonly error: null }
  | { readonly status: 'FAIL_CLOSED'; readonly evidence: null; readonly error: string }

interface HttpResult {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body: unknown
}

const json = (value: unknown): string =>
  JSON.stringify(value, (_, nested) => (typeof nested === 'bigint' ? nested.toString() : nested))

const publicState = (state: RuntimeState) => ({
  service: 'bayn',
  status: state.status,
  authority: { brokerOrders: false, capitalPromotion: false },
  evidence: state.evidence,
  error: state.error,
})

const routeRequest = (method: string | undefined, url: string | undefined, state: RuntimeState): HttpResult => {
  const path = url?.split('?')[0] ?? '/'
  if (method !== 'GET') {
    return { status: 405, headers: { allow: 'GET' }, body: { error: 'method_not_allowed' } }
  }
  if (path === '/livez') {
    return { status: 200, body: { service: 'bayn', live: true } }
  }
  if (path === '/readyz') {
    const ready = state.status === 'READY'
    return { status: ready ? 200 : 503, body: { ready, status: state.status } }
  }
  if (path === '/v1/status' || path === '/v1/evidence/latest') {
    return { status: 200, body: publicState(state) }
  }
  return { status: 404, body: { error: 'not_found' } }
}

export const makeHttpServer = (config: Pick<BaynConfig, 'host' | 'port'>, state: Ref.Ref<RuntimeState>) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>()
    const runSync = Runtime.runSync(runtime)
    const logCloseFailure = (cause: unknown) =>
      runSync(
        Effect.logWarning('Bayn HTTP server close failed').pipe(
          Effect.annotateLogs({ service: 'bayn', component: 'http', operation: 'close', error: String(cause) }),
        ),
      )

    return yield* Effect.acquireRelease(
      Effect.async<Server, BaynError>((resume) => {
        const server = createServer((request, response) => {
          let result: HttpResult
          try {
            result = routeRequest(request.method, request.url, runSync(Ref.get(state)))
          } catch {
            result = { status: 500, body: { error: 'internal_server_error' } }
          }
          response.writeHead(result.status, { 'content-type': 'application/json', ...result.headers })
          response.end(json(result.body))
        })
        const onError = (cause: Error) =>
          resume(Effect.fail(baynError('http', 'listen', 'Bayn HTTP server failed to listen', cause)))
        server.once('error', onError)
        server.listen(config.port, config.host, () => {
          server.off('error', onError)
          resume(Effect.succeed(server))
        })
      }),
      (server) =>
        Effect.async<void>((resume) => {
          if (!server.listening) {
            resume(Effect.void)
            return
          }
          try {
            server.close((cause) => {
              if (cause) logCloseFailure(cause)
              resume(Effect.void)
            })
          } catch (cause) {
            logCloseFailure(cause)
            resume(Effect.void)
          }
        }),
    )
  })

const withinDeadline = <A, R>(
  effect: Effect.Effect<A, BaynError, R>,
  timeoutMs: number,
  component: BaynComponent,
  operation: string,
): Effect.Effect<A, BaynError, R> =>
  effect.pipe(
    Effect.timeoutFail({
      duration: timeoutMs,
      onTimeout: () => baynError(component, operation, `${operation} timed out after ${timeoutMs}ms`),
    }),
  )

const failClosed = (state: Ref.Ref<RuntimeState>, error: BaynError): Effect.Effect<void> =>
  Effect.logError('Bayn startup failed closed').pipe(
    Effect.annotateLogs({
      service: 'bayn',
      component: error.component,
      operation: error.operation,
      error: error.message,
    }),
    Effect.zipRight(
      Ref.set(state, {
        status: 'FAIL_CLOSED',
        evidence: null,
        error: formatBaynError(error),
      }),
    ),
  )

const evaluateAndJournal = (
  config: BaynConfig,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<void, BaynError, MarketDataService | JournalService> =>
  Effect.gen(function* () {
    const marketData = yield* MarketData
    const journal = yield* Journal
    yield* Effect.logInfo('Bayn startup evaluation started').pipe(
      Effect.annotateLogs({
        service: 'bayn',
        codeRevision: config.codeRevision,
        datasetVersion: config.clickhouse.datasetVersion,
      }),
    )
    yield* withinDeadline(journal.check, config.operationTimeoutMs, 'journal', 'connectivity-check')
    const snapshot = yield* withinDeadline(marketData.load, config.operationTimeoutMs, 'market-data', 'load')
    yield* Effect.logInfo('Bayn signal snapshot loaded').pipe(
      Effect.annotateLogs({
        service: 'bayn',
        inputManifestHash: snapshot.manifest.hash,
        rowCount: snapshot.manifest.rowCount,
      }),
    )
    const evaluation = yield* Effect.try({
      try: () => evaluateTsmom(snapshot.bars, snapshot.manifest, config.protocol, config.codeRevision),
      catch: (cause) => baynError('strategy', 'evaluate', 'TSMOM evaluation failed', cause),
    })
    yield* Effect.logInfo('Bayn TSMOM evaluation completed').pipe(
      Effect.annotateLogs({
        service: 'bayn',
        runId: evaluation.runId,
        verdict: evaluation.verdict.status,
        eventCount: evaluation.events.length,
      }),
    )
    const reconciliation = yield* withinDeadline(
      journal.journalAndReconcile(evaluation),
      config.operationTimeoutMs,
      'journal',
      'journal-and-reconcile',
    )
    const { events, ...evaluationWithoutEvents } = evaluation
    yield* Ref.set(state, {
      status: 'READY',
      evidence: { evaluation: { ...evaluationWithoutEvents, eventCount: events.length }, reconciliation },
      error: null,
    })
    yield* Effect.logInfo('Bayn startup proof is ready').pipe(
      Effect.annotateLogs({
        service: 'bayn',
        runId: evaluation.runId,
        accountCount: reconciliation.accountCount,
        transferCount: reconciliation.transferCount,
      }),
    )
  }).pipe(Effect.withLogSpan('startup'))

const checkWithoutJournal = (
  config: BaynConfig,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<void, BaynError, MarketDataService | JournalService> =>
  Effect.gen(function* () {
    const marketData = yield* MarketData
    const journal = yield* Journal
    yield* withinDeadline(journal.check, config.operationTimeoutMs, 'journal', 'connectivity-check')
    yield* withinDeadline(marketData.load, config.operationTimeoutMs, 'market-data', 'load')
    yield* Ref.set(state, {
      status: 'FAIL_CLOSED',
      evidence: null,
      error: 'BAYN_RUN_ON_STARTUP=false; evaluation and accounting proof were not executed',
    })
  })

export const initializeBayn = (
  config: BaynConfig,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<void, never, MarketDataService | JournalService> =>
  (config.runOnStartup ? evaluateAndJournal(config, state) : checkWithoutJournal(config, state)).pipe(
    Effect.catchAll((error) => failClosed(state, error)),
  )

export const runBayn = (config: BaynConfig): Effect.Effect<void, BaynError, MarketDataService | JournalService> =>
  Effect.scoped(
    Effect.gen(function* () {
      const state = yield* Ref.make<RuntimeState>({ status: 'STARTING', evidence: null, error: null })
      yield* makeHttpServer(config, state)

      const shutdown = yield* Deferred.make<void>()
      const runtime = yield* Effect.runtime<never>()
      const signalShutdown = Runtime.runSync(runtime)
      const onSignal = () => {
        signalShutdown(Deferred.succeed(shutdown, undefined))
      }
      process.once('SIGINT', onSignal)
      process.once('SIGTERM', onSignal)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.off('SIGINT', onSignal)
          process.off('SIGTERM', onSignal)
        }),
      )

      yield* Effect.raceFirst(
        initializeBayn(config, state).pipe(Effect.zipRight(Deferred.await(shutdown))),
        Deferred.await(shutdown),
      )
    }),
  )
