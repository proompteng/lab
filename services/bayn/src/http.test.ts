import { describe, expect, test } from 'bun:test'

import { Context, Effect, Layer, Ref } from 'effect'
import { HttpServer } from 'effect/unstable/http'

import {
  provenance,
  historicalRunId,
  successfulEvidenceStore,
  fixtureQualification,
  fetchJson,
  readyState,
} from './app-test-support'
import { DatabaseError, type EvidenceStoreService } from './db/evidence-store'
import { makeHttpLayer } from './http'
import { initialState } from './runtime-state'

describe('Bayn HTTP probes', () => {
  test('serves every route from the current runtime state and closes its socket', async () => {
    let port = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const state = yield* Ref.make(initialState())
          const context = yield* Layer.build(
            makeHttpLayer(
              { host: '127.0.0.1', operationTimeoutMs: 250, port: 0 },
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
          expect(yield* Effect.promise(() => fetchJson(port, '/v1/status'))).toMatchObject({
            status: 200,
            body: {
              service: 'bayn',
              operational: { status: 'READY', ready: true, probeSequence: 1 },
              authority: { maximum: 'observe', brokerOrders: false, capitalPromotion: false },
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
          expect(yield* Effect.promise(() => fetchJson(port, '/v1/status'))).toMatchObject({
            status: 200,
            body: { operational: { status: 'FAILED' }, error: 'test failure' },
          })
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
              { host: '127.0.0.1', operationTimeoutMs: 250, port: 0 },
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
})
