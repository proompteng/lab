import { createServer } from 'node:http'

import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer, Option, Ref } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'

import type { RuntimeBuildMetadata, RuntimeConfig } from './config'
import type { RuntimeProvenance } from './contracts'
import { EvidenceStore, type EvidenceStoreService, type PersistenceReceipt } from './db/evidence-store'
import { formatError, operationalError, type Component, type OperationalError } from './errors'
import { Journal } from './ledger'
import { MarketData } from './market-data'
import { summarizeEvaluation } from './strategy'
import { Strategy } from './strategy-service'
import type { EvaluationSummary, ReconciliationResult } from './types'

interface RuntimeEvidence {
  readonly startupMode: 'evaluated' | 'recovered'
  readonly provenance: RuntimeProvenance
  readonly evaluation: EvaluationSummary
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
  config: Pick<RuntimeConfig, 'host' | 'operationTimeoutMs' | 'port'>,
  state: Ref.Ref<RuntimeState>,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
  evidenceStore: EvidenceStoreService,
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
  const historicalEvaluation = HttpRouter.params.pipe(
    Effect.flatMap(({ runId }) => {
      if (runId === undefined || !/^[0-9a-f]{64}$/.test(runId)) {
        return Effect.succeed(jsonResponse({ error: 'invalid_run_id' }, 400))
      }
      return evidenceStore.read(runId).pipe(
        Effect.timeoutOrElse({
          duration: config.operationTimeoutMs,
          orElse: () => Effect.fail(new Error(`evidence read timed out after ${config.operationTimeoutMs}ms`)),
        }),
        Effect.map((stored) =>
          Option.match(stored, {
            onNone: () => jsonResponse({ error: 'evaluation_not_found' }, 404),
            onSome: (evidence) => jsonResponse(evidence),
          }),
        ),
        Effect.catch((error) =>
          Effect.logError('Bayn historical evidence read failed').pipe(
            Effect.annotateLogs({ service: 'bayn', runId, error: error.message }),
            Effect.as(jsonResponse({ error: 'evidence_unavailable' }, 503)),
          ),
        ),
      )
    }),
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
    HttpRouter.route('GET', '/v1/evaluations/:runId', historicalEvaluation),
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
    const expectedRunId = yield* Effect.try({
      try: () => strategy.identify(snapshot.manifest),
      catch: (cause) => operationalError('strategy', 'identify', `${strategy.name} run identity failed`, cause),
    })
    const recovered = yield* withinDeadline(
      databaseOperation(evidenceStore.recover(expectedRunId, strategy.provenance), 'recover-evaluation'),
      config.operationTimeoutMs,
      'database',
      'recover-evaluation',
    )
    if (Option.isSome(recovered)) {
      yield* Ref.set(state, {
        status: 'READY',
        evidence: {
          startupMode: 'recovered',
          provenance: strategy.provenance,
          evaluation: recovered.value.evaluation,
          reconciliation: recovered.value.reconciliation,
          persistence: recovered.value.persistence,
        },
        error: null,
      })
      yield* Effect.logInfo('Bayn startup proof recovered').pipe(
        Effect.annotateLogs({
          service: 'bayn',
          runId: expectedRunId,
          artifactCount: recovered.value.persistence.artifactCount,
          eventCount: recovered.value.persistence.eventCount,
          gateCount: recovered.value.persistence.gateCount,
        }),
      )
      return
    }
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
    yield* Ref.set(state, {
      status: 'READY',
      evidence: {
        startupMode: 'evaluated',
        provenance: strategy.provenance,
        evaluation: summarizeEvaluation(evaluation),
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
        markedEquityDifferenceMicros: evaluation.markedEquityReconciliation.differenceMicros,
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
      const evidenceStore = yield* EvidenceStore
      const state = yield* Ref.make<RuntimeState>({ status: 'STARTING', evidence: null, error: null })
      yield* Layer.build(
        makeHttpLayer(config, state, strategy.provenance, config.build.verification, evidenceStore),
      ).pipe(Effect.mapError((cause) => operationalError('http', 'listen', 'HTTP server failed to listen', cause)))
      yield* initialize(config, state)
      return yield* Effect.never
    }),
  )
