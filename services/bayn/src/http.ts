import { createServer } from 'node:http'

import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer, Option, Ref } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'

import type { RuntimeBuildMetadata, RuntimeConfig } from './config'
import type { RuntimeProvenance } from './contracts'
import { Authority } from './paper'
import { isReady, type DependencyHealth, type RuntimeState } from './runtime-state'

type ReadEvidence = (runId: string) => Effect.Effect<Option.Option<unknown>, { readonly message: string }>

const verifiedState = (state: RuntimeState, dependency: DependencyHealth) => {
  if (state.evidence === null || dependency.status === 'UNKNOWN') return 'UNKNOWN'
  return dependency.status === 'AVAILABLE' ? 'CURRENT' : 'INVALID'
}

const publicState = (
  state: RuntimeState,
  maximumAuthority: Authority,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
) => {
  let accounting = 'UNKNOWN'
  if (state.evidence !== null) {
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
      verdict: state.evidence?.qualification.evaluationVerdict ?? null,
    },
    qualification: {
      verdict: state.evidence?.qualification.verdict ?? null,
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
      maximum: maximumAuthority === Authority.Paper ? 'paper' : 'observe',
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
  HttpServerResponse.json(body, { status, headers }).pipe(Effect.orDie)

export const makeHttpLayer = (
  config: Pick<RuntimeConfig, 'host' | 'maximumAuthority' | 'operationTimeoutMs' | 'port'>,
  state: Ref.Ref<RuntimeState>,
  provenance: RuntimeProvenance,
  provenanceVerification: RuntimeBuildMetadata['verification'],
  readEvidence: ReadEvidence,
): ReturnType<typeof NodeHttpServer.layer> => {
  const ready = Ref.get(state).pipe(
    Effect.flatMap((current) => {
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
    Effect.flatMap((current) =>
      jsonResponse(publicState(current, config.maximumAuthority, provenance, provenanceVerification)),
    ),
  )
  const historicalEvaluation = HttpRouter.params.pipe(
    Effect.flatMap(({ runId }) => {
      if (runId === undefined || !/^[0-9a-f]{64}$/.test(runId)) {
        return jsonResponse({ error: 'invalid_run_id' }, 400)
      }
      return readEvidence(runId).pipe(
        Effect.timeoutOrElse({
          duration: config.operationTimeoutMs,
          orElse: () => Effect.fail(new Error(`evidence read timed out after ${config.operationTimeoutMs}ms`)),
        }),
        Effect.flatMap((stored) =>
          Option.match(stored, {
            onNone: () => jsonResponse({ error: 'evaluation_not_found' }, 404),
            onSome: (evidence) => jsonResponse(evidence),
          }),
        ),
        Effect.catch((error) =>
          Effect.logError('Bayn historical evidence read failed').pipe(
            Effect.annotateLogs({ service: 'bayn', runId, error: error.message }),
            Effect.andThen(jsonResponse({ error: 'evidence_unavailable' }, 503)),
          ),
        ),
      )
    }),
  )
  const fallback = (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    request.method === 'GET'
      ? jsonResponse({ error: 'not_found' }, 404)
      : jsonResponse({ error: 'method_not_allowed' }, 405, { allow: 'GET' })
  const routes = HttpRouter.addAll([
    HttpRouter.route('GET', '/livez', jsonResponse({ service: 'bayn', live: true })),
    HttpRouter.route('GET', '/readyz', ready),
    HttpRouter.route('GET', '/v1/status', status),
    HttpRouter.route('GET', '/v1/evaluations/:runId', historicalEvaluation),
    HttpRouter.route('*', '*', fallback),
  ] as const)

  return HttpRouter.serve(routes, { disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { host: config.host, port: config.port })),
  )
}
