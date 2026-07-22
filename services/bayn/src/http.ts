import { createServer } from 'node:http'

import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer, Option, Ref } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'

import type { RuntimeBuildMetadata, RuntimeConfig } from './config'
import type { RuntimeProvenance } from './contracts'
import { isReady, type DependencyHealth, type RuntimeState } from './runtime-state'

type ReadEvidence = (runId: string) => Effect.Effect<Option.Option<unknown>, { readonly message: string }>

const json = (value: unknown): string =>
  JSON.stringify(value, (_, nested) => (typeof nested === 'bigint' ? nested.toString() : nested))

const verifiedState = (state: RuntimeState, dependency: DependencyHealth) => {
  if (state.evidence === null || dependency.status === 'UNKNOWN') return 'UNKNOWN'
  return dependency.status === 'AVAILABLE' ? 'CURRENT' : 'INVALID'
}

const publicState = (
  state: RuntimeState,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
) => {
  let economic = 'UNKNOWN'
  let accounting = 'UNKNOWN'
  if (state.evidence !== null) {
    economic = state.evidence.qualification.verdict
    if (state.health.dependencies.tigerBeetle.status === 'AVAILABLE') accounting = 'EXACT'
    if (state.health.dependencies.tigerBeetle.status === 'UNAVAILABLE') accounting = 'UNAVAILABLE'
  }

  return {
    service: 'bayn',
    operational: {
      status: state.status,
      ready: isReady(state),
      probeSequence: state.health.sequence,
      checkedAt: state.health.checkedAt,
    },
    dependencies: state.health.dependencies,
    data: {
      status: verifiedState(state, state.health.dependencies.signal),
      input: state.evidence?.evaluation.input ?? null,
    },
    evidence: {
      status: verifiedState(state, state.health.dependencies.evidence),
      runId: state.evidence?.evaluation.runId ?? null,
      startupMode: state.evidence?.startupMode ?? null,
      persistence: state.evidence?.persistence ?? null,
    },
    economic: {
      status: economic,
      verdict: state.evidence?.qualification.evaluationVerdict ?? null,
    },
    qualification: {
      status: state.evidence?.qualification.verdict ?? 'UNKNOWN',
      executable: state.evidence?.qualification.verdict === 'QUALIFIED',
      lockId: state.evidence?.qualification.lockId ?? null,
      resultHash: state.evidence?.qualification.resultHash ?? null,
      analysisHash: state.evidence?.qualification.analysis.analysisHash ?? null,
      candidateOrdinal: state.evidence?.qualification.analysis.candidateOrdinal ?? null,
      reasonCodes: state.evidence?.qualification.reasonCodes ?? [],
      executionProvenance: state.evidence?.provenance ?? null,
    },
    accounting: {
      status: accounting,
      reconciliation: state.evidence?.reconciliation ?? null,
    },
    authority: {
      maximum: 'observe',
      brokerOrders: false,
      capitalPromotion: false,
    },
    build: {
      sourceRevision: provenance.sourceRevision,
      image: provenance.image,
      verification: provenanceVerification,
    },
    error: state.error,
  }
}

const jsonResponse = (body: unknown, status = 200, headers?: Readonly<Record<string, string>>) =>
  HttpServerResponse.text(json(body), { status, contentType: 'application/json', headers })

export const makeHttpLayer = (
  config: Pick<RuntimeConfig, 'host' | 'operationTimeoutMs' | 'port'>,
  state: Ref.Ref<RuntimeState>,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
  readEvidence: ReadEvidence,
): ReturnType<typeof NodeHttpServer.layer> => {
  const ready = Ref.get(state).pipe(
    Effect.map((current) => {
      const ready = isReady(current)
      const failedDependencies = Object.entries(current.health.dependencies)
        .filter(([, dependency]) => dependency.status !== 'AVAILABLE')
        .map(([name]) => name)
      return jsonResponse(
        {
          ready,
          status: current.status,
          checkedAt: current.health.checkedAt,
          probeSequence: current.health.sequence,
          failedDependencies,
        },
        ready ? 200 : 503,
      )
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
      return readEvidence(runId).pipe(
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
