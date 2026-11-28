import { expect, test } from 'bun:test'
import { Effect, Metric, Ref } from 'effect'
import { HttpServer } from 'effect/http'

import { ExecutionControllerOutcome } from './execution/controller-status'
import { HttpServerLive, renderPrometheusMetrics, serveHttp } from './http'
import { initialState } from './runtime-state'
import { config, provenance } from './testing/runtime-fixtures'
import { makeTelemetryRuntimeLayer, withObservedStage } from './telemetry'

test('the existing pull endpoint includes native histograms, source identity and a fresh scrape heartbeat', async () => {
  const metrics = await Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* Ref.make(initialState({}))
      yield* serveHttp(config, state, provenance, config.build.verification)
      const server = yield* HttpServer.HttpServer
      const origin = HttpServer.formatAddress(server.address)
      yield* Effect.void.pipe(withObservedStage('bayn.postgres.commit', { dependency: 'postgresql' }))
      return yield* Effect.tryPromise(async () => {
        const response = await fetch(`${origin}/metrics`)
        expect(response.status).toBe(200)
        return response.text()
      })
    }).pipe(
      Effect.scoped,
      Effect.provide(HttpServerLive({ host: '127.0.0.1', port: 0 })),
      Effect.provide(makeTelemetryRuntimeLayer({ serviceName: 'bayn', serviceVersion: provenance.sourceRevision })),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    ),
  )
  expect(metrics).toContain(`bayn_operation_metrics_expected{source_revision="${provenance.sourceRevision}"} 1`)
  expect(metrics).toContain('bayn_build_info{')
  expect(metrics).toMatch(/bayn_operation_duration_seconds_count\{[^\n]*stage="bayn.postgres.commit"[^\n]*\} 1/)
  expect(metrics).toMatch(/bayn_telemetry_heartbeat_timestamp_seconds\{[^\n]*service="bayn"/)
  expect(metrics).toContain(`source_revision="${provenance.sourceRevision}"`)
  expect(metrics.match(/# TYPE bayn_operation_duration_seconds histogram/g)).toHaveLength(1)
})

test.each(Object.values(ExecutionControllerOutcome))('exports one active controller outcome for %s', (lastOutcome) => {
  const metrics = renderPrometheusMetrics(
    {
      ...initialState({}),
      executionController: {
        configured: true,
        controllerKey: 'primary',
        planHash: 'f'.repeat(64),
        readAvailable: true,
        checkedAt: '2026-09-17T14:30:00.000Z',
        error: null,
        status: {
          schemaVersion: 1,
          controllerKey: 'primary',
          planHash: 'f'.repeat(64),
          active: true,
          epoch: 1,
          nextSequence: 2,
          lastSequence: 1,
          lastOutcome,
          lastReceiptHash: 'a'.repeat(64),
          completedAt: '2026-09-17T14:30:00.000Z',
        },
      },
    },
    config,
    provenance,
    config.build.verification,
  )
  const outcomes = metrics.split('\n').filter((line) => line.startsWith('bayn_execution_controller_last_outcome{'))
  expect(outcomes).toHaveLength(4)
  expect(outcomes.filter((line) => line.endsWith(' 1'))).toEqual([
    `bayn_execution_controller_last_outcome{outcome="${lastOutcome.toLowerCase()}"} 1`,
  ])
})
