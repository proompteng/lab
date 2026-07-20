import { createServer } from 'node:http'

import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer, Ref } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'

import type { RuntimeConfig } from './config'
import { formatError, operationalError, type Component, type OperationalError } from './errors'
import { Journal } from './ledger'
import { MarketData } from './market-data'
import { Strategy } from './strategy-service'
import type { EvaluationResult, ReconciliationResult } from './types'

interface RuntimeEvidence {
  readonly evaluation: Omit<EvaluationResult, 'events'> & { readonly eventCount: number }
  readonly reconciliation: ReconciliationResult
}

export type RuntimeState =
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

const jsonResponse = (body: unknown, status = 200, headers?: Readonly<Record<string, string>>) =>
  HttpServerResponse.text(json(body), { status, contentType: 'application/json', headers })

export const makeHttpLayer = (
  config: Pick<RuntimeConfig, 'host' | 'port'>,
  state: Ref.Ref<RuntimeState>,
): ReturnType<typeof NodeHttpServer.layer> => {
  const ready = Ref.get(state).pipe(
    Effect.map((current) => {
      const isReady = current.status === 'READY'
      return jsonResponse({ ready: isReady, status: current.status }, isReady ? 200 : 503)
    }),
  )
  const status = Ref.get(state).pipe(Effect.map((current) => jsonResponse(publicState(current))))
  const fallback = (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    Effect.succeed(
      request.method === 'GET'
        ? jsonResponse({ error: 'not_found' }, 404)
        : jsonResponse({ error: 'method_not_allowed' }, 405, { allow: 'GET' }),
    )
  const routes: Layer.Layer<never, never, HttpRouter.HttpRouter> = HttpRouter.addAll([
    HttpRouter.route<never, never>('GET', '/livez', jsonResponse({ service: 'bayn', live: true })),
    HttpRouter.route<never, never>('GET', '/readyz', ready),
    HttpRouter.route<never, never>('GET', '/v1/status', status),
    HttpRouter.route<never, never>('*', '*', fallback),
  ] as const)

  return HttpRouter.serve(routes, { disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { host: config.host, port: config.port })),
  )
}

const withinDeadline = <A, R>(
  effect: Effect.Effect<A, OperationalError, R>,
  timeoutMs: number,
  component: Component,
  operation: string,
): Effect.Effect<A, OperationalError, R> =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(operationalError(component, operation, `${operation} timed out after ${timeoutMs}ms`)),
    }),
  )

const failClosed = (state: Ref.Ref<RuntimeState>, error: OperationalError): Effect.Effect<void> =>
  Effect.logError('Bayn startup failed closed').pipe(
    Effect.annotateLogs({
      service: 'bayn',
      component: error.component,
      operation: error.operation,
      error: error.message,
    }),
    Effect.andThen(
      Ref.set(state, {
        status: 'FAIL_CLOSED',
        evidence: null,
        error: formatError(error),
      }),
    ),
  )

const evaluateAndJournal = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<void, OperationalError, MarketData | Journal | Strategy> =>
  Effect.gen(function* () {
    const marketData = yield* MarketData
    const journal = yield* Journal
    const strategy = yield* Strategy
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
      try: () => strategy.evaluate(snapshot.bars, snapshot.manifest, config.codeRevision),
      catch: (cause) => operationalError('strategy', 'evaluate', `${strategy.name} evaluation failed`, cause),
    })
    yield* Effect.logInfo('Bayn strategy evaluation completed').pipe(
      Effect.annotateLogs({
        service: 'bayn',
        runId: evaluation.runId,
        strategy: strategy.name,
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
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<void, OperationalError, MarketData | Journal> =>
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

export const initialize = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<void, never, MarketData | Journal | Strategy> =>
  (config.runOnStartup ? evaluateAndJournal(config, state) : checkWithoutJournal(config, state)).pipe(
    Effect.catch((error) => failClosed(state, error)),
  )

export const run = (config: RuntimeConfig): Effect.Effect<never, OperationalError, MarketData | Journal | Strategy> =>
  Effect.scoped(
    Effect.gen(function* () {
      const state = yield* Ref.make<RuntimeState>({ status: 'STARTING', evidence: null, error: null })
      yield* Layer.build(makeHttpLayer(config, state)).pipe(
        Effect.mapError((cause) => operationalError('http', 'listen', 'HTTP server failed to listen', cause)),
      )
      yield* initialize(config, state)
      return yield* Effect.never
    }),
  )
