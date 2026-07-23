import { describe, expect, test } from 'bun:test'

import { Context, Effect, Layer, Ref } from 'effect'
import { HttpServer } from 'effect/unstable/http'

import {
  config,
  provenance,
  historicalRunId,
  successfulEvidenceStore,
  fixtureQualification,
  fetchJson,
  readyState,
} from './app-test-support'
import type { BrokerReadShape } from './broker/alpaca'
import { unusedMarketCalendar } from './broker/alpaca-test-support'
import { DatabaseError, type EvidenceStoreService } from './db/evidence-store'
import type { BrokerProbe } from './health'
import { makeHttpLayer, renderPrometheusMetrics } from './http'
import { Authority } from './paper'
import { initialState, type RuntimeState } from './runtime-state'

describe('Bayn HTTP probes', () => {
  test('serves every route from the current runtime state and closes its socket', async () => {
    let port = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const state = yield* Ref.make(initialState())
          const context = yield* Layer.build(
            makeHttpLayer(
              {
                cycleStallThresholdMs: config.cycleStallThresholdMs,
                host: '127.0.0.1',
                maximumAuthority: Authority.Observe,
                operationTimeoutMs: 250,
                port: 0,
                reconciliationStaleThresholdMs: config.reconciliationStaleThresholdMs,
                unknownMutationThresholdMs: config.unknownMutationThresholdMs,
              },
              state,
              provenance,
              'embedded',
              successfulEvidenceStore.read,
            ),
          )
          const address = Context.get(context, HttpServer.HttpServer).address
          if (address._tag !== 'TcpAddress') throw new Error('test server did not bind a TCP port')
          port = address.port

          expect(yield* Effect.promise(() => fetchJson(port, '/livez'))).toEqual({
            status: 200,
            allow: null,
            body: { service: 'bayn', live: true },
          })
          expect(yield* Effect.promise(() => fetchJson(port, '/readyz'))).toMatchObject({
            status: 503,
            body: { ready: false, status: 'STARTING' },
          })

          yield* Ref.set(state, readyState())
          expect(yield* Effect.promise(() => fetchJson(port, '/readyz'))).toMatchObject({
            status: 200,
            body: { ready: true, status: 'READY' },
          })
          const statusResponse = yield* Effect.promise(() => fetchJson(port, '/v1/status'))
          expect(statusResponse).toMatchObject({
            status: 200,
            body: {
              service: 'bayn',
              operational: { status: 'READY', ready: true, probeSequence: 1 },
              cycle: {
                condition: 'WAITING',
                reason: 'NO_CYCLE_RECORDED',
                zeroMutation: true,
                mutations: { eventCount: 0, unresolvedCount: 0 },
              },
              autonomousCycleLoop: {
                configured: false,
                startedAt: null,
                lastPass: null,
              },
              authority: { maximum: 'observe', brokerOrders: false, capitalPromotion: false },
              broker: {
                configured: false,
                accountBound: false,
                readAvailable: false,
                executionEligible: false,
                executionDisabledReason: 'ALPACA_NOT_CONFIGURED',
              },
              build: { sourceRevision: provenance.sourceRevision, verification: 'embedded' },
              data: { status: 'CURRENT' },
              evidence: { status: 'CURRENT' },
              economic: { verdict: fixtureQualification.evaluationVerdict },
              qualification: {
                verdict: 'REJECTED',
                lockId: fixtureQualification.lockId,
                resultHash: fixtureQualification.resultHash,
                executionProvenance: provenance,
              },
              accounting: { status: 'EXACT' },
            },
          })
          expect(statusResponse.body.economic).not.toHaveProperty('status')
          expect(statusResponse.body.qualification).not.toHaveProperty('status')
          expect(statusResponse.body.qualification).not.toHaveProperty('executable')
          const metricsResponse = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/metrics`))
          const metrics = yield* Effect.promise(() => metricsResponse.text())
          expect(metricsResponse.status).toBe(200)
          expect(metricsResponse.headers.get('content-type')).toContain('text/plain')
          expect(metrics).toContain('bayn_cycle_condition{condition="waiting"} 1')
          expect(metrics).toContain('bayn_autonomous_cycle_loop_configured 0')
          expect(metrics).toContain('bayn_autonomous_cycle_loop_health_available 0')
          expect(metrics).toContain('bayn_autonomous_cycle_loop_last_pass{result="unknown"} 1')
          expect(metrics).toContain('bayn_mutation_events_total 0')
          expect(metrics).toContain('bayn_broker_orders_enabled 0')
          expect(metrics).toContain('bayn_capital_promotion_enabled 0')
          expect(yield* Effect.promise(() => fetchJson(port, `/v1/evaluations/${historicalRunId}`))).toMatchObject({
            status: 200,
            body: { run: { runId: historicalRunId } },
          })
          expect(yield* Effect.promise(() => fetchJson(port, '/v1/evaluations/not-a-run'))).toMatchObject({
            status: 400,
            body: { error: 'invalid_run_id' },
          })
          expect(yield* Effect.promise(() => fetchJson(port, `/v1/evaluations/${'f'.repeat(64)}`))).toMatchObject({
            status: 404,
            body: { error: 'evaluation_not_found' },
          })
          yield* Ref.set(state, { ...initialState(), status: 'FAILED', error: 'test failure' })
          expect(yield* Effect.promise(() => fetchJson(port, '/readyz'))).toMatchObject({
            status: 503,
            body: { ready: false, status: 'FAILED' },
          })
          const failedStatus = yield* Effect.promise(() => fetchJson(port, '/v1/status'))
          expect(failedStatus).toMatchObject({
            status: 200,
            body: {
              operational: { status: 'FAILED' },
              cycle: {
                observationAvailable: false,
                condition: 'UNKNOWN',
                zeroMutation: null,
              },
              authority: { durable: { available: false } },
              error: 'test failure',
            },
          })
          const failedBody = failedStatus.body as {
            readonly authority: { readonly durable: Record<string, unknown> }
            readonly cycle: Record<string, unknown>
          }
          expect(failedBody.cycle).not.toHaveProperty('unfinishedCycleCount')
          expect(failedBody.cycle).not.toHaveProperty('mutations')
          expect(failedBody.authority.durable).not.toHaveProperty('configured')
          expect(yield* Effect.promise(() => fetchJson(port, '/v1/evidence/latest'))).toMatchObject({
            status: 404,
            body: { error: 'not_found' },
          })
          expect(yield* Effect.promise(() => fetchJson(port, '/livez', 'POST'))).toEqual({
            status: 405,
            allow: 'GET',
            body: { error: 'method_not_allowed' },
          })
        }),
      ),
    )

    let rejected = false
    try {
      await fetch(`http://127.0.0.1:${port}/livez`)
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
  })

  test('keeps a typed latest loop failure visible and makes readiness and metrics fail closed', async () => {
    const failedAt = '2026-07-20T00:00:00.000Z'
    const failedState: RuntimeState = {
      ...readyState(),
      status: 'DEGRADED',
      health: {
        ...readyState().health,
        dependencies: {
          ...readyState().health.dependencies,
          cycleRunner: {
            status: 'UNAVAILABLE',
            checkedAt: failedAt,
            error: 'market-calendar/calendar-read: authoritative calendar unavailable',
          },
        },
      },
      autonomousCycleLoop: {
        configured: true,
        startedAt: failedAt,
        lastPass: {
          result: 'FAILURE',
          observedAt: failedAt,
          operation: 'market-calendar',
          failure: 'calendar-read',
          message: 'authoritative calendar unavailable',
        },
      },
      error: 'cycleRunner: market-calendar/calendar-read: authoritative calendar unavailable',
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const state = yield* Ref.make(failedState)
          const context = yield* Layer.build(
            makeHttpLayer(
              {
                cycleStallThresholdMs: config.cycleStallThresholdMs,
                host: '127.0.0.1',
                maximumAuthority: Authority.Observe,
                operationTimeoutMs: 250,
                port: 0,
                reconciliationStaleThresholdMs: config.reconciliationStaleThresholdMs,
                unknownMutationThresholdMs: config.unknownMutationThresholdMs,
              },
              state,
              provenance,
              'embedded',
              successfulEvidenceStore.read,
            ),
          )
          const address = Context.get(context, HttpServer.HttpServer).address
          if (address._tag !== 'TcpAddress') throw new Error('test server did not bind a TCP port')

          expect(yield* Effect.promise(() => fetchJson(address.port, '/readyz'))).toMatchObject({
            status: 503,
            body: {
              ready: false,
              status: 'DEGRADED',
              failedDependencies: expect.arrayContaining(['cycleRunner']),
            },
          })
          expect(yield* Effect.promise(() => fetchJson(address.port, '/v1/status'))).toMatchObject({
            status: 200,
            body: {
              autonomousCycleLoop: {
                configured: true,
                startedAt: failedAt,
                lastPass: {
                  result: 'FAILURE',
                  observedAt: failedAt,
                  operation: 'market-calendar',
                  failure: 'calendar-read',
                  message: 'authoritative calendar unavailable',
                },
              },
            },
          })
          const metrics = yield* Effect.promise(() =>
            fetch(`http://127.0.0.1:${address.port}/metrics`).then((response) => response.text()),
          )
          expect(metrics).toContain('bayn_autonomous_cycle_loop_configured 1')
          expect(metrics).toContain('bayn_autonomous_cycle_loop_health_available 0')
          expect(metrics).toContain('bayn_autonomous_cycle_loop_last_pass{result="failure"} 1')
          expect(metrics).toContain(
            `bayn_autonomous_cycle_loop_last_pass_timestamp_seconds ${Date.parse(failedAt) / 1_000}`,
          )
        }),
      ),
    )
  })

  test('returns service unavailable when durable evidence cannot be read', async () => {
    const unavailableStore: EvidenceStoreService = {
      ...successfulEvidenceStore,
      read: () =>
        Effect.fail(
          new DatabaseError({
            failure: 'unavailable',
            operation: 'read-evidence',
            message: 'database unavailable',
          }),
        ),
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const state = yield* Ref.make(initialState())
          const context = yield* Layer.build(
            makeHttpLayer(
              {
                cycleStallThresholdMs: config.cycleStallThresholdMs,
                host: '127.0.0.1',
                maximumAuthority: Authority.Observe,
                operationTimeoutMs: 250,
                port: 0,
                reconciliationStaleThresholdMs: config.reconciliationStaleThresholdMs,
                unknownMutationThresholdMs: config.unknownMutationThresholdMs,
              },
              state,
              provenance,
              'embedded',
              unavailableStore.read,
            ),
          )
          const address = Context.get(context, HttpServer.HttpServer).address
          if (address._tag !== 'TcpAddress') throw new Error('test server did not bind a TCP port')

          expect(
            yield* Effect.promise(() => fetchJson(address.port, `/v1/evaluations/${historicalRunId}`)),
          ).toMatchObject({ status: 503, body: { error: 'evidence_unavailable' } })
        }),
      ),
    )
  })

  test('reports the configured ceiling without implying broker capability', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const state = yield* Ref.make(initialState())
          const context = yield* Layer.build(
            makeHttpLayer(
              {
                cycleStallThresholdMs: config.cycleStallThresholdMs,
                host: '127.0.0.1',
                maximumAuthority: Authority.Paper,
                operationTimeoutMs: 250,
                port: 0,
                reconciliationStaleThresholdMs: config.reconciliationStaleThresholdMs,
                unknownMutationThresholdMs: config.unknownMutationThresholdMs,
              },
              state,
              provenance,
              'embedded',
              successfulEvidenceStore.read,
            ),
          )
          const address = Context.get(context, HttpServer.HttpServer).address
          if (address._tag !== 'TcpAddress') throw new Error('test server did not bind a TCP port')

          expect(yield* Effect.promise(() => fetchJson(address.port, '/v1/status'))).toMatchObject({
            status: 200,
            body: { authority: { maximum: 'paper', brokerOrders: false, capitalPromotion: false } },
          })
        }),
      ),
    )
  })

  test('keeps broker read capability out of runtime state and public status', async () => {
    const unused = Effect.die(new Error('status must not invoke broker reads'))
    const read: BrokerReadShape = {
      account: unused,
      positions: unused,
      orders: () => unused,
      orderById: () => unused,
      orderByClientId: () => unused,
      fillActivities: () => unused,
      marketCalendar: unusedMarketCalendar,
    }
    const broker: BrokerProbe = {
      read,
      expectedAccountId: 'paper-account-1',
      executionEligible: false,
      executionDisabledReason: 'MAXIMUM_AUTHORITY_OBSERVE',
    }
    const runtimeState = initialState(broker)
    expect(runtimeState.broker).not.toHaveProperty('read')
    expect(Object.values(runtimeState.broker ?? {}).some((value) => typeof value === 'function')).toBe(false)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const state = yield* Ref.make(runtimeState)
          const context = yield* Layer.build(
            makeHttpLayer(
              {
                cycleStallThresholdMs: config.cycleStallThresholdMs,
                host: '127.0.0.1',
                maximumAuthority: Authority.Observe,
                operationTimeoutMs: 250,
                port: 0,
                reconciliationStaleThresholdMs: config.reconciliationStaleThresholdMs,
                unknownMutationThresholdMs: config.unknownMutationThresholdMs,
              },
              state,
              provenance,
              'embedded',
              successfulEvidenceStore.read,
            ),
          )
          const address = Context.get(context, HttpServer.HttpServer).address
          if (address._tag !== 'TcpAddress') throw new Error('test server did not bind a TCP port')

          const response = yield* Effect.promise(() => fetchJson(address.port, '/v1/status'))
          expect(response.body).toMatchObject({
            broker: {
              configured: true,
              expectedAccountId: 'paper-account-1',
              executionEligible: false,
              executionDisabledReason: 'MAXIMUM_AUTHORITY_OBSERVE',
            },
          })
          const publicBroker = response.body.broker as Record<string, unknown>
          expect(publicBroker).not.toHaveProperty('read')
          expect(Object.values(publicBroker).some((value) => typeof value === 'function')).toBe(false)
        }),
      ),
    )
  })

  test('does not synthesize durable cycle, mutation, reconciliation, or authority observations', () => {
    const metrics = renderPrometheusMetrics(initialState(), config, provenance, 'embedded')

    expect(metrics).toContain('bayn_cycle_observation_available 0')
    expect(metrics).toContain('bayn_cycle_condition{condition="unknown"} 1')
    expect(metrics).toContain('bayn_cycle_reason{reason="observation_unavailable"} 1')
    expect(metrics).toContain('bayn_cycle_phase{phase="unknown"} 1')
    expect(metrics).toContain('bayn_zero_mutation_confirmed 0')
    expect(metrics).not.toContain('bayn_cycle_unfinished_count ')
    expect(metrics).not.toContain('bayn_mutation_events_total ')
    expect(metrics).not.toContain('bayn_unresolved_mutations ')
    expect(metrics).not.toContain('bayn_reconciliation_available ')
    expect(metrics).not.toContain('bayn_authority_coherent ')
    expect(metrics).not.toContain('bayn_authority_kill_active ')
  })
})
