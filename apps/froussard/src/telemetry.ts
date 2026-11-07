import os from 'node:os'

import { ConfigProvider, Data, Effect, Layer, Metric, Option } from 'effect'
import { FetchHttpClient, Headers, HttpClient, HttpTraceContext } from 'effect/http'
import { OtlpMetrics, OtlpSerialization, OtlpTracer } from 'effect/observability'

export const makeTelemetryLayer = () => {
  const resource = {
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'froussard',
    serviceVersion: process.env.FROUSSARD_COMMIT ?? 'dev',
    attributes: {
      'service.namespace': process.env.OTEL_SERVICE_NAMESPACE ?? process.env.POD_NAMESPACE ?? 'default',
      'service.instance.id': process.env.POD_NAME ?? os.hostname(),
    },
  }
  const client = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      client.pipe(
        HttpClient.tap((response) => Effect.ignore(response.arrayBuffer)),
        HttpClient.timeout('10 seconds'),
        HttpClient.filterStatusOk,
        HttpClient.tapError((error) => Effect.logWarning('OTLP export request failed', error)),
      ),
    ),
  ).pipe(Layer.provide(FetchHttpClient.layer))

  return Layer.mergeAll(OtlpTracer.layerFromConfig({ resource }), OtlpMetrics.layerFromConfig({ resource })).pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
    Layer.provide(OtlpSerialization.layerJson),
    Layer.provide(client),
    Layer.provideMerge(Layer.sync(Metric.MetricRegistry, () => new Map())),
  )
}

const requests = Metric.counter('froussard_http_requests_total', { incremental: true })
const duration = Metric.histogram('froussard_http_request_duration_ms', {
  boundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  attributes: { unit: 'milliseconds' },
})

class HttpResponseError extends Data.TaggedError('HttpResponseError')<{ response: Response }> {}

export const traceRequest = (request: Request, route: string, handle: () => Response | Promise<Response>) =>
  Effect.suspend(() => {
    const startedAt = performance.now()
    const attributes = { method: request.method, route }
    const record = (status: number) =>
      Effect.all([
        Metric.update(Metric.withAttributes(requests, { ...attributes, status: String(status) }), 1),
        Metric.update(Metric.withAttributes(duration, attributes), performance.now() - startedAt),
      ])

    return Effect.tryPromise({
      try: async () => handle(),
      catch: (cause) => (cause instanceof Error ? cause : new Error('HTTP handler failed', { cause })),
    }).pipe(
      Effect.tapError(() => Effect.annotateCurrentSpan('http.response.status_code', 500)),
      Effect.tap((response) => Effect.annotateCurrentSpan('http.response.status_code', response.status)),
      Effect.flatMap((response) =>
        response.status >= 500 ? Effect.fail(new HttpResponseError({ response })) : Effect.succeed(response),
      ),
      Effect.withSpan(`${request.method} ${route}`, {
        kind: 'server',
        parent: Option.getOrUndefined(HttpTraceContext.fromHeaders(Headers.fromInput(request.headers))),
        attributes: { 'http.request.method': request.method, 'http.route': route },
      }),
      Effect.catchTag('HttpResponseError', ({ response }) => Effect.succeed(response)),
      Effect.onError(() => record(500)),
      Effect.tap((response) => record(response.status)),
    )
  })
