import { createServer } from 'node:http'

import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer, Ref } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'

import type { RuntimeBuildMetadata, RuntimeConfig } from './config'
import type { RuntimeProvenance } from './contracts'
import { EvidenceStore, type PersistenceReceipt } from './db/evidence-store'
import { formatError, operationalError, type Component, type OperationalError } from './errors'
import { Journal } from './ledger'
import { MarketData } from './market-data'
import { Strategy } from './strategy-service'
import type { EvaluationResult, ReconciliationResult } from './types'

interface RuntimeEvidence {
  readonly provenance: RuntimeProvenance
  readonly evaluation: Omit<EvaluationResult, 'events'> & { readonly eventCount: number }
  readonly reconciliation: ReconciliationResult
  readonly persistence: PersistenceReceipt
}

export type RuntimeState =
  | { readonly status: 'STARTING'; readonly evidence: null; readonly error: null }
  | { readonly status: 'READY'; readonly evidence: RuntimeEvidence; readonly error: null }
  | { readonly status: 'FAIL_CLOSED'; readonly evidence: null; readonly error: string }

const json = (value: unknown): string =>
  JSON.stringify(value, (_, nested) => (typeof nested === 'bigint' ? nested.toString() : nested))

const publicState = (
  state: RuntimeState,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
) => ({
  service: 'bayn',
  status: state.status,
  authority: { brokerOrders: false, capitalPromotion: false },
  provenanceVerification,
  provenance,
  evidence: state.evidence,
  error: state.error,
})

const jsonResponse = (body: unknown, status = 200, headers?: Readonly<Record<string, string>>) =>
  HttpServerResponse.text(json(body), { status, contentType: 'application/json', headers })

export const makeHttpLayer = (
  config: Pick<RuntimeConfig, 'host' | 'port'>,
  state: Ref.Ref<RuntimeState>,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
): ReturnType<typeof NodeHttpServer.layer> => {
  const ready = Ref.get(state).pipe(
    Effect.map((current) => {
      const isReady = current.status === 'READY'
      return jsonResponse({ ready: isReady, status: current.status }, isReady ? 200 : 503)
    }),
  )
  const status = Ref.get(state).pipe(
    Effect.map((current) => jsonResponse(publicState(current, provenance, provenanceVerification))),
  )
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

const databaseOperation = <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>, operation: string) =>
  effect.pipe(
    Effect.mapError((cause) => operationalError('database', operation, `PostgreSQL ${operation} failed`, cause)),
  )

const evaluateAndJournal = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<void, OperationalError, MarketData | Journal | Strategy | EvidenceStore> =>
  Effect.gen(function* () {
    const marketData = yield* MarketData
    const journal = yield* Journal
    const strategy = yield* Strategy
    const evidenceStore = yield* EvidenceStore
    yield* Effect.logInfo('Bayn startup evaluation started').pipe(
      Effect.annotateLogs({
        service: 'bayn',
        sourceRevision: config.build.sourceRevision,
        imageDigest: config.build.imageDigest,
        strategyBehaviorHash: strategy.provenance.strategy.behaviorHash,
        parameterHash: strategy.provenance.strategy.parameterHash,
        snapshotId: config.clickhouse.snapshotId,
        evaluationStart: config.clickhouse.bounds.evaluationStart,
        evaluationEnd: config.clickhouse.bounds.evaluationEnd,
      }),
    )
    yield* withinDeadline(journal.check, config.operationTimeoutMs, 'journal', 'connectivity-check')
    yield* withinDeadline(
      databaseOperation(evidenceStore.check, 'health-check'),
      config.operationTimeoutMs,
      'database',
      'health-check',
    )
    const snapshot = yield* withinDeadline(marketData.load, config.operationTimeoutMs, 'market-data', 'load')
    yield* Effect.logInfo('Bayn signal snapshot loaded').pipe(
      Effect.annotateLogs({
        service: 'bayn',
        inputManifestHash: snapshot.manifest.hash,
        rowCount: snapshot.manifest.rowCount,
      }),
    )
    const evaluation = yield* Effect.try({
      try: () => strategy.evaluate(snapshot.bars, snapshot.manifest),
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
    const persistence = yield* withinDeadline(
      databaseOperation(
        evidenceStore.persist({
          provenance: strategy.provenance,
          parameters: strategy.parameters,
          evaluation,
          reconciliation,
        }),
        'persist-evaluation',
      ),
      config.operationTimeoutMs,
      'database',
      'persist-evaluation',
    )
    const { events, ...evaluationWithoutEvents } = evaluation
    yield* Ref.set(state, {
      status: 'READY',
      evidence: {
        provenance: strategy.provenance,
        evaluation: { ...evaluationWithoutEvents, eventCount: events.length },
        reconciliation,
        persistence,
      },
      error: null,
    })
    yield* Effect.logInfo('Bayn startup proof is ready').pipe(
      Effect.annotateLogs({
        service: 'bayn',
        runId: evaluation.runId,
        accountCount: reconciliation.accountCount,
        transferCount: reconciliation.transferCount,
        persistenceDeduplicated: persistence.deduplicated,
      }),
    )
  }).pipe(Effect.withLogSpan('startup'))

const checkWithoutJournal = (
  config: RuntimeConfig,
  state: Ref.Ref<RuntimeState>,
): Effect.Effect<void, OperationalError, MarketData | Journal | EvidenceStore> =>
  Effect.gen(function* () {
    const marketData = yield* MarketData
    const journal = yield* Journal
    const evidenceStore = yield* EvidenceStore
    yield* withinDeadline(journal.check, config.operationTimeoutMs, 'journal', 'connectivity-check')
    yield* withinDeadline(
      databaseOperation(evidenceStore.check, 'health-check'),
      config.operationTimeoutMs,
      'database',
      'health-check',
    )
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
): Effect.Effect<void, never, MarketData | Journal | Strategy | EvidenceStore> =>
  (config.runOnStartup ? evaluateAndJournal(config, state) : checkWithoutJournal(config, state)).pipe(
    Effect.catch((error) => failClosed(state, error)),
  )

export const run = (
  config: RuntimeConfig,
): Effect.Effect<never, OperationalError, MarketData | Journal | Strategy | EvidenceStore> =>
  Effect.scoped(
    Effect.gen(function* () {
      const strategy = yield* Strategy
      const state = yield* Ref.make<RuntimeState>({ status: 'STARTING', evidence: null, error: null })
      yield* Layer.build(makeHttpLayer(config, state, strategy.provenance, config.build.verification)).pipe(
        Effect.mapError((cause) => operationalError('http', 'listen', 'HTTP server failed to listen', cause)),
      )
      yield* initialize(config, state)
      return yield* Effect.never
    }),
  )
