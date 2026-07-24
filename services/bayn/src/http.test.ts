import { connect, type Socket } from 'node:net'

import { describe, expect, test } from 'bun:test'

import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Ref } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpServer } from 'effect/unstable/http'

import {
  config,
  historicalEvidence,
  historicalRunId,
  provenance,
  readyState,
  successfulEvidenceStore,
} from './app-test-support'
import type { BrokerReadShape } from './broker/alpaca'
import { unusedAssetBySymbol, unusedMarketCalendar } from './broker/alpaca-test-support'
import { CycleOperationsCondition, CycleOperationsReason } from './cycle-observability'
import { CycleState, CycleTerminalReason } from './cycle'
import { DatabaseError, type EvidenceStoreService } from './db/evidence-store'
import type { BrokerProbe } from './health'
import {
  fallbackResponseDecision,
  historicalEvidenceResponseDecision,
  historicalReadFailureDecision,
  makeHttpLayer,
  readHistoricalEvidence,
  readinessResponseDecision,
  renderPrometheusMetrics,
  statusFacts,
  statusResponseDecision,
  validateHistoricalRunRequest,
} from './http'
import { Authority, KillState } from './paper'
import { initialState, type RuntimeState } from './runtime-state'

const metricValue = (metrics: string, name: string): number => {
  const line = metrics.split('\n').find((candidate) => candidate.startsWith(`${name} `))
  expect(line).toBeDefined()
  return line === undefined ? Number.NaN : Number(line.slice(name.length + 1))
}

interface TestServerOptions {
  readonly state?: RuntimeState
  readonly maximumAuthority?: Authority
  readonly operationTimeoutMs?: number
  readonly readEvidence?: EvidenceStoreService['read']
}

interface TestServer {
  readonly port: number
  readonly state: Ref.Ref<RuntimeState>
}

const withHttpServer = (
  options: TestServerOptions,
  use: (server: TestServer) => Effect.Effect<void, unknown>,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Ref.make(options.state ?? initialState()).pipe(
        Effect.flatMap((state) =>
          Layer.build(
            makeHttpLayer(
              {
                cycleStallThresholdMs: config.cycleStallThresholdMs,
                host: '127.0.0.1',
                maximumAuthority: options.maximumAuthority ?? Authority.Observe,
                operationTimeoutMs: options.operationTimeoutMs ?? 250,
                port: 0,
                reconciliationStaleThresholdMs: config.reconciliationStaleThresholdMs,
                unknownMutationThresholdMs: config.unknownMutationThresholdMs,
              },
              state,
              provenance,
              'embedded',
              options.readEvidence ?? successfulEvidenceStore.read,
            ),
          ).pipe(
            Effect.flatMap((context) => {
              const address = Context.get(context, HttpServer.HttpServer).address
              expect(address._tag).toBe('TcpAddress')
              return address._tag === 'TcpAddress' ? use({ port: address.port, state }) : Effect.die('expected TCP')
            }),
          ),
        ),
      ),
    ),
  )

const request = (port: number, path: string, method = 'GET') =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal })
      const contentType = response.headers.get('content-type')
      const body = contentType?.includes('application/json') ? await response.json() : await response.text()
      return {
        status: response.status,
        allow: response.headers.get('allow'),
        cacheControl: response.headers.get('cache-control'),
        contentType,
        body,
      }
    },
    catch: (cause) => cause,
  })

const connectSocket = (port: number): Effect.Effect<Socket> =>
  Effect.callback<Socket>((resume) => {
    const socket = connect({ host: '127.0.0.1', port })
    const onConnect = () => {
      socket.off('error', onError)
      resume(Effect.succeed(socket))
    }
    const onError = (cause: unknown) => {
      socket.off('connect', onConnect)
      resume(Effect.die(cause))
    }
    socket.once('connect', onConnect)
    socket.once('error', onError)
    return Effect.sync(() => {
      socket.off('connect', onConnect)
      socket.off('error', onError)
      socket.destroy()
    })
  })

const withConnectedSocket = <A, E, R>(
  port: number,
  use: (socket: Socket) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.acquireRelease(connectSocket(port), (socket) => Effect.sync(() => socket.destroy())).pipe(
      Effect.flatMap(use),
    ),
  )

describe('Bayn HTTP pure decisions', () => {
  test.each([
    {
      name: 'missing parameter',
      runId: undefined,
      expected: {
        _tag: 'Respond',
        response: { _tag: 'Json', status: 400, body: { error: 'invalid_run_id' } },
      },
    },
    {
      name: 'short parameter',
      runId: 'a'.repeat(63),
      expected: {
        _tag: 'Respond',
        response: { _tag: 'Json', status: 400, body: { error: 'invalid_run_id' } },
      },
    },
    {
      name: 'uppercase parameter',
      runId: 'A'.repeat(64),
      expected: {
        _tag: 'Respond',
        response: { _tag: 'Json', status: 400, body: { error: 'invalid_run_id' } },
      },
    },
    {
      name: 'non-hex parameter',
      runId: `${'a'.repeat(63)}g`,
      expected: {
        _tag: 'Respond',
        response: { _tag: 'Json', status: 400, body: { error: 'invalid_run_id' } },
      },
    },
    {
      name: 'canonical parameter',
      runId: historicalRunId,
      expected: { _tag: 'ReadEvidence', runId: historicalRunId },
    },
  ])('validates $name without I/O', ({ runId, expected }) => {
    expect(validateHistoricalRunRequest(runId)).toEqual(expected)
  })

  test('decides historical evidence, fallback, and status responses from immutable values', () => {
    const initial = initialState()
    expect(historicalEvidenceResponseDecision(Option.some(historicalEvidence))).toEqual({
      _tag: 'Json',
      status: 200,
      body: historicalEvidence,
    })
    expect(historicalEvidenceResponseDecision(Option.none())).toEqual({
      _tag: 'Json',
      status: 404,
      body: { error: 'evaluation_not_found' },
    })
    expect(['GET', 'POST', 'HEAD'].map((method) => ({ method, decision: fallbackResponseDecision(method) }))).toEqual([
      {
        method: 'GET',
        decision: { _tag: 'Json', status: 404, body: { error: 'not_found' } },
      },
      {
        method: 'POST',
        decision: {
          _tag: 'Json',
          status: 405,
          body: { error: 'method_not_allowed' },
          headers: { allow: 'GET' },
        },
      },
      {
        method: 'HEAD',
        decision: {
          _tag: 'Json',
          status: 405,
          body: { error: 'method_not_allowed' },
          headers: { allow: 'GET' },
        },
      },
    ])
    expect(statusResponseDecision(initial, Authority.Observe, provenance, 'embedded')).toEqual({
      _tag: 'Json',
      status: 200,
      body: statusFacts(initial, Authority.Observe, provenance, 'embedded'),
    })
  })

  test('covers every readiness decision branch without mutating runtime facts', () => {
    const healthy = readyState()
    const checkedAt = healthy.health.checkedAt
    const broker = {
      configured: true as const,
      expectedAccountId: 'paper-account-1',
      accountId: 'paper-account-1',
      accountBound: false,
      readAvailable: true,
      checkedAt,
      error: 'binding unavailable',
      executionEligible: false,
      executionDisabledReason: 'MAXIMUM_AUTHORITY_OBSERVE',
    }
    const loopFailure: RuntimeState = {
      ...healthy,
      autonomousCycleLoop: {
        configured: true,
        startedAt: checkedAt,
        lastPass: {
          result: 'FAILURE',
          observedAt: checkedAt ?? '2026-07-20T00:00:00.000Z',
          operation: 'market-calendar',
          failure: 'calendar-read',
          message: 'calendar unavailable',
        },
      },
    }
    const failedDependency: RuntimeState = {
      ...healthy,
      health: {
        ...healthy.health,
        dependencies: {
          ...healthy.health.dependencies,
          signal: { status: 'UNAVAILABLE', checkedAt, error: 'signal unavailable' },
        },
      },
    }
    const cycleState = (condition: CycleOperationsCondition): RuntimeState => ({
      ...healthy,
      cycle: { ...healthy.cycle, condition },
    })
    const duplicateFailures: RuntimeState = {
      ...loopFailure,
      cycle: { ...healthy.cycle, condition: CycleOperationsCondition.Failed },
      health: {
        ...healthy.health,
        dependencies: {
          ...healthy.health.dependencies,
          cycle: { status: 'UNAVAILABLE', checkedAt, error: 'cycle unavailable' },
          cycleRunner: { status: 'UNAVAILABLE', checkedAt, error: 'runner unavailable' },
        },
      },
    }
    const cases: readonly {
      readonly name: string
      readonly state: RuntimeState
      readonly ready: boolean
      readonly status: 200 | 503
      readonly failedDependencies: readonly string[]
    }[] = [
      { name: 'ready', state: healthy, ready: true, status: 200, failedDependencies: [] },
      {
        name: 'runtime status',
        state: { ...healthy, status: 'DEGRADED' },
        ready: false,
        status: 503,
        failedDependencies: [],
      },
      {
        name: 'missing evidence',
        state: { ...healthy, evidence: null },
        ready: false,
        status: 503,
        failedDependencies: [],
      },
      {
        name: 'dependency failure',
        state: failedDependency,
        ready: false,
        status: 503,
        failedDependencies: ['signal'],
      },
      {
        name: 'broker binding',
        state: { ...healthy, broker },
        ready: false,
        status: 503,
        failedDependencies: ['broker'],
      },
      {
        name: 'unknown cycle',
        state: cycleState(CycleOperationsCondition.Unknown),
        ready: false,
        status: 503,
        failedDependencies: ['cycle'],
      },
      {
        name: 'stalled cycle',
        state: cycleState(CycleOperationsCondition.Stalled),
        ready: false,
        status: 503,
        failedDependencies: ['cycle'],
      },
      {
        name: 'failed cycle',
        state: cycleState(CycleOperationsCondition.Failed),
        ready: false,
        status: 503,
        failedDependencies: ['cycle'],
      },
      {
        name: 'loop failure',
        state: loopFailure,
        ready: false,
        status: 503,
        failedDependencies: ['cycleRunner'],
      },
      {
        name: 'deduplicated observed failures',
        state: duplicateFailures,
        ready: false,
        status: 503,
        failedDependencies: ['cycle', 'cycleRunner'],
      },
      {
        name: 'initial unknown dependencies',
        state: initialState(),
        ready: false,
        status: 503,
        failedDependencies: ['postgresql', 'signal', 'tigerBeetle', 'evidence', 'cycle', 'cycleRunner'],
      },
    ]

    for (const testCase of cases) {
      expect(readinessResponseDecision(testCase.state), testCase.name).toEqual({
        _tag: 'Json',
        status: testCase.status,
        body: {
          ready: testCase.ready,
          status: testCase.state.status,
          checkedAt: testCase.state.health.checkedAt,
          probeSequence: testCase.state.health.sequence,
          failedDependencies: testCase.failedDependencies,
        },
      })
    }
  })

  test('covers every public status projection branch from immutable facts', () => {
    const initial = initialState()
    const healthy = readyState()
    const checkedAt = healthy.health.checkedAt
    const observedAt = checkedAt ?? '2026-07-20T00:00:00.000Z'
    const unknownDependencies: RuntimeState = {
      ...healthy,
      health: {
        ...healthy.health,
        dependencies: {
          ...healthy.health.dependencies,
          signal: { status: 'UNKNOWN', checkedAt, error: null },
          tigerBeetle: { status: 'UNKNOWN', checkedAt, error: null },
          evidence: { status: 'UNKNOWN', checkedAt, error: null },
        },
      },
    }
    const unavailableDependencies: RuntimeState = {
      ...healthy,
      health: {
        ...healthy.health,
        dependencies: {
          ...healthy.health.dependencies,
          signal: { status: 'UNAVAILABLE', checkedAt, error: 'signal unavailable' },
          tigerBeetle: { status: 'UNAVAILABLE', checkedAt, error: 'journal unavailable' },
          evidence: { status: 'UNAVAILABLE', checkedAt, error: 'evidence unavailable' },
        },
      },
    }
    const configured: RuntimeState = {
      ...healthy,
      cycle: {
        ...healthy.cycle,
        authority: {
          generationHash: 'a'.repeat(64),
          maximum: Authority.Paper,
          effective: Authority.Observe,
          kill: KillState.Active,
          reason: 'operator kill',
          updatedAt: observedAt,
        },
      },
      broker: {
        configured: true,
        expectedAccountId: 'paper-account-1',
        accountId: 'paper-account-1',
        accountBound: true,
        readAvailable: true,
        checkedAt,
        error: null,
        executionEligible: false,
        executionDisabledReason: 'MAXIMUM_AUTHORITY_OBSERVE',
      },
    }
    const cases = [
      {
        name: 'no evidence or observations',
        state: initial,
        maximum: Authority.Observe,
        expected: {
          data: 'UNKNOWN',
          evidence: 'UNKNOWN',
          accounting: 'UNKNOWN',
          observationAvailable: false,
          maximum: 'observe',
          durable: { available: false },
          broker: { configured: false, accountBound: false, readAvailable: false },
        },
      },
      {
        name: 'current evidence without durable authority',
        state: healthy,
        maximum: Authority.Observe,
        expected: {
          data: 'CURRENT',
          evidence: 'CURRENT',
          accounting: 'EXACT',
          observationAvailable: true,
          maximum: 'observe',
          durable: {
            available: true,
            configured: false,
            maximum: null,
            effective: null,
            kill: null,
            reason: null,
            updatedAt: null,
          },
          broker: { configured: false, accountBound: false, readAvailable: false },
        },
      },
      {
        name: 'unknown dependency verification',
        state: unknownDependencies,
        maximum: Authority.Observe,
        expected: {
          data: 'UNKNOWN',
          evidence: 'UNKNOWN',
          accounting: 'UNKNOWN',
          observationAvailable: true,
          maximum: 'observe',
          durable: {
            available: true,
            configured: false,
            maximum: null,
            effective: null,
            kill: null,
            reason: null,
            updatedAt: null,
          },
          broker: { configured: false, accountBound: false, readAvailable: false },
        },
      },
      {
        name: 'invalid dependency verification',
        state: unavailableDependencies,
        maximum: Authority.Observe,
        expected: {
          data: 'INVALID',
          evidence: 'INVALID',
          accounting: 'UNAVAILABLE',
          observationAvailable: true,
          maximum: 'observe',
          durable: {
            available: true,
            configured: false,
            maximum: null,
            effective: null,
            kill: null,
            reason: null,
            updatedAt: null,
          },
          broker: { configured: false, accountBound: false, readAvailable: false },
        },
      },
      {
        name: 'configured paper ceiling and durable observe kill',
        state: configured,
        maximum: Authority.Paper,
        expected: {
          data: 'CURRENT',
          evidence: 'CURRENT',
          accounting: 'EXACT',
          observationAvailable: true,
          maximum: 'paper',
          durable: {
            available: true,
            configured: true,
            maximum: 'paper',
            effective: 'observe',
            kill: 'active',
            reason: 'operator kill',
            updatedAt: observedAt,
          },
          broker: { configured: true, accountBound: true, readAvailable: true },
        },
      },
    ] as const

    for (const testCase of cases) {
      const facts = statusFacts(testCase.state, testCase.maximum, provenance, 'embedded')
      expect(
        {
          data: facts.data.status,
          evidence: facts.evidence.status,
          accounting: facts.accounting.status,
          observationAvailable: facts.cycle.observationAvailable,
          maximum: facts.authority.maximum,
          durable: facts.authority.durable,
          broker: {
            configured: facts.broker.configured,
            accountBound: facts.broker.accountBound,
            readAvailable: facts.broker.readAvailable,
          },
        },
        testCase.name,
      ).toEqual(testCase.expected)
    }
  })

  test('maps database and timeout failures to the typed operational boundary with the cause intact', async () => {
    const databaseCause = new DatabaseError({
      failure: 'unavailable',
      operation: 'read-evidence',
      message: 'database unavailable',
    })
    const databaseFailure = await Effect.runPromise(
      Effect.flip(readHistoricalEvidence(Effect.fail(databaseCause), 250)),
    )
    expect(databaseFailure).toMatchObject({
      _tag: 'OperationalError',
      component: 'database',
      operation: 'read-evidence',
      message: 'PostgreSQL read-evidence failed: database unavailable',
      retryable: true,
    })
    expect(databaseFailure.cause).toBe(databaseCause)
    expect(historicalReadFailureDecision(historicalRunId, databaseFailure)).toEqual({
      response: { _tag: 'Json', status: 503, body: { error: 'evidence_unavailable' } },
      log: {
        message: 'Bayn historical evidence read failed',
        cause: databaseFailure,
        annotations: {
          service: 'bayn',
          runId: historicalRunId,
          component: 'database',
          operation: 'read-evidence',
          retryable: true,
          error: 'PostgreSQL read-evidence failed: database unavailable',
        },
      },
    })

    const timeout = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const finalizations = yield* Ref.make(0)
        const read = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Ref.update(finalizations, (count) => count + 1)),
        )
        const failureFiber = yield* Effect.flip(readHistoricalEvidence(read, 1_000)).pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust(1_000)
        const error = yield* Fiber.join(failureFiber)
        return { error, finalizations: yield* Ref.get(finalizations) }
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(timeout).toMatchObject({
      error: {
        _tag: 'OperationalError',
        component: 'database',
        operation: 'read-evidence',
        message: 'read-evidence timed out after 1000ms',
        retryable: true,
      },
      finalizations: 1,
    })
    expect(timeout.error.cause).toBeUndefined()
  })

  test('preserves a historical read defect as the identical Die cause', async () => {
    const sentinel = { _tag: 'HistoricalReadDefect' } as const
    const exit = await Effect.runPromise(Effect.exit(readHistoricalEvidence(Effect.die(sentinel), 250)))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(Cause.hasFails(exit.cause)).toBe(false)
      const [reason] = exit.cause.reasons
      expect(reason?._tag).toBe('Die')
      if (reason?._tag === 'Die') expect(reason.defect).toBe(sentinel)
    }
  })
})

describe('Bayn HTTP probes', () => {
  test('serves every route from the current runtime state and closes its socket', async () => {
    const initial = initialState()
    let port = 0
    await withHttpServer({ state: initial }, (server) => {
      port = server.port
      const routeCases = [
        {
          name: 'liveness',
          path: '/livez',
          method: 'GET',
          expected: {
            status: 200,
            allow: null,
            cacheControl: null,
            contentType: 'application/json',
            body: { service: 'bayn', live: true },
          },
        },
        {
          name: 'readiness',
          path: '/readyz',
          method: 'GET',
          expected: {
            status: 503,
            allow: null,
            cacheControl: null,
            contentType: 'application/json',
            body: readinessResponseDecision(initial).body,
          },
        },
        {
          name: 'metrics',
          path: '/metrics',
          method: 'GET',
          expected: {
            status: 200,
            allow: null,
            cacheControl: 'no-store',
            contentType: 'text/plain; version=0.0.4; charset=utf-8',
            body: renderPrometheusMetrics(initial, config, provenance, 'embedded'),
          },
        },
        {
          name: 'status',
          path: '/v1/status',
          method: 'GET',
          expected: {
            status: 200,
            allow: null,
            cacheControl: null,
            contentType: 'application/json',
            body: statusFacts(initial, Authority.Observe, provenance, 'embedded'),
          },
        },
        {
          name: 'historical evidence',
          path: `/v1/evaluations/${historicalRunId}`,
          method: 'GET',
          expected: {
            status: 200,
            allow: null,
            cacheControl: null,
            contentType: 'application/json',
            body: historicalEvidence,
          },
        },
        {
          name: 'invalid historical run',
          path: '/v1/evaluations/not-a-run',
          method: 'GET',
          expected: {
            status: 400,
            allow: null,
            cacheControl: null,
            contentType: 'application/json',
            body: { error: 'invalid_run_id' },
          },
        },
        {
          name: 'missing historical run',
          path: `/v1/evaluations/${'f'.repeat(64)}`,
          method: 'GET',
          expected: {
            status: 404,
            allow: null,
            cacheControl: null,
            contentType: 'application/json',
            body: { error: 'evaluation_not_found' },
          },
        },
        {
          name: 'unknown route',
          path: '/v1/evidence/latest',
          method: 'GET',
          expected: {
            status: 404,
            allow: null,
            cacheControl: null,
            contentType: 'application/json',
            body: { error: 'not_found' },
          },
        },
        {
          name: 'unsupported method',
          path: '/livez',
          method: 'POST',
          expected: {
            status: 405,
            allow: 'GET',
            cacheControl: null,
            contentType: 'application/json',
            body: { error: 'method_not_allowed' },
          },
        },
      ] as const
      const assertRoutes = Effect.forEach(
        routeCases,
        (testCase) =>
          request(server.port, testCase.path, testCase.method).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response, testCase.name).toEqual(testCase.expected))),
          ),
        { discard: true },
      )
      const ready = readyState()
      const assertCurrentState = Ref.set(server.state, ready).pipe(
        Effect.andThen(request(server.port, '/readyz')),
        Effect.tap((response) =>
          Effect.sync(() =>
            expect(response).toEqual({
              status: 200,
              allow: null,
              cacheControl: null,
              contentType: 'application/json',
              body: readinessResponseDecision(ready).body,
            }),
          ),
        ),
        Effect.andThen(request(server.port, '/v1/status')),
        Effect.tap((response) =>
          Effect.sync(() =>
            expect(response.body).toEqual(statusFacts(ready, Authority.Observe, provenance, 'embedded')),
          ),
        ),
        Effect.asVoid,
      )
      return assertRoutes.pipe(Effect.andThen(assertCurrentState))
    })

    await Effect.runPromise(Effect.flip(request(port, '/livez')))
  })

  test('does not convert a historical read defect into an operational 503 response', async () => {
    const sentinel = { _tag: 'HistoricalRouteDefect' } as const

    await withHttpServer({ readEvidence: () => Effect.die(sentinel) }, ({ port }) =>
      request(port, `/v1/evaluations/${historicalRunId}`).pipe(
        Effect.tap((response) =>
          Effect.sync(() => {
            expect(response.status).not.toBe(503)
            expect(response.body).not.toEqual({ error: 'evidence_unavailable' })
          }),
        ),
        Effect.asVoid,
      ),
    )
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

    await withHttpServer({ state: failedState }, ({ port }) =>
      Effect.all([request(port, '/readyz'), request(port, '/v1/status'), request(port, '/metrics')]).pipe(
        Effect.tap(([ready, status, metrics]) =>
          Effect.sync(() => {
            expect(ready).toMatchObject({
              status: 503,
              body: {
                ready: false,
                status: 'DEGRADED',
                failedDependencies: expect.arrayContaining(['cycleRunner']),
              },
            })
            expect(status).toMatchObject({
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
            expect(metrics.body).toContain('bayn_autonomous_cycle_loop_configured 1')
            expect(metrics.body).toContain('bayn_autonomous_cycle_loop_health_available 0')
            expect(metrics.body).toContain('bayn_runtime_ready 0')
            expect(metrics.body).toContain('bayn_autonomous_cycle_loop_last_pass{result="failure"} 1')
            expect(metrics.body).toContain(
              `bayn_autonomous_cycle_loop_last_pass_timestamp_seconds ${Date.parse(failedAt) / 1_000}`,
            )
          }),
        ),
        Effect.asVoid,
      ),
    )
  })

  test('injects and clears bounded runtime readiness for loop and broker failures', () => {
    const observedAt = '2026-07-20T00:00:00.000Z'
    const broker = {
      configured: true as const,
      expectedAccountId: 'paper-account-1',
      accountId: 'paper-account-1',
      accountBound: true,
      readAvailable: true,
      checkedAt: observedAt,
      error: null,
      executionEligible: false,
      executionDisabledReason: 'MAXIMUM_AUTHORITY_OBSERVE',
    }
    const healthy: RuntimeState = {
      ...readyState(),
      autonomousCycleLoop: {
        configured: true,
        startedAt: observedAt,
        lastPass: { result: 'SUCCESS', observedAt, outcome: 'NO_PUBLICATION' },
      },
      broker,
    }
    const loopFailure: RuntimeState = {
      ...healthy,
      status: 'DEGRADED',
      health: {
        ...healthy.health,
        dependencies: {
          ...healthy.health.dependencies,
          cycleRunner: {
            status: 'UNAVAILABLE',
            checkedAt: observedAt,
            error: 'market-calendar/calendar-read: authoritative calendar unavailable',
          },
        },
      },
      autonomousCycleLoop: {
        ...healthy.autonomousCycleLoop,
        lastPass: {
          result: 'FAILURE',
          observedAt,
          operation: 'market-calendar',
          failure: 'calendar-read',
          message: 'authoritative calendar unavailable',
        },
      },
    }
    const brokerReadFailure: RuntimeState = {
      ...healthy,
      status: 'DEGRADED',
      broker: {
        ...broker,
        accountId: null,
        accountBound: false,
        readAvailable: false,
        error: 'Alpaca account unavailable',
      },
    }
    const brokerBindingFailure: RuntimeState = {
      ...healthy,
      status: 'DEGRADED',
      broker: {
        ...broker,
        accountId: 'other-paper-account',
        accountBound: false,
        error: 'Alpaca account binding mismatch',
      },
    }
    const render = (state: RuntimeState) => renderPrometheusMetrics(state, config, provenance, 'embedded')

    const healthyBefore = render(healthy)
    const loopInjected = render(loopFailure)
    const loopCleared = render(healthy)
    const brokerReadInjected = render(brokerReadFailure)
    const brokerReadCleared = render(healthy)
    const brokerBindingInjected = render(brokerBindingFailure)
    const brokerBindingCleared = render(healthy)

    expect(metricValue(healthyBefore, 'bayn_runtime_ready')).toBe(1)
    expect(metricValue(loopInjected, 'bayn_runtime_ready')).toBe(0)
    expect(metricValue(loopInjected, 'bayn_autonomous_cycle_loop_health_available')).toBe(0)
    expect(metricValue(loopCleared, 'bayn_runtime_ready')).toBe(1)
    expect(metricValue(loopCleared, 'bayn_autonomous_cycle_loop_health_available')).toBe(1)

    expect(metricValue(brokerReadInjected, 'bayn_runtime_ready')).toBe(0)
    expect(metricValue(brokerReadInjected, 'bayn_broker_read_available')).toBe(0)
    expect(metricValue(brokerReadCleared, 'bayn_runtime_ready')).toBe(1)
    expect(metricValue(brokerReadCleared, 'bayn_broker_read_available')).toBe(1)

    expect(metricValue(brokerBindingInjected, 'bayn_runtime_ready')).toBe(0)
    expect(metricValue(brokerBindingInjected, 'bayn_broker_account_bound')).toBe(0)
    expect(metricValue(brokerBindingCleared, 'bayn_runtime_ready')).toBe(1)
    expect(metricValue(brokerBindingCleared, 'bayn_broker_account_bound')).toBe(1)
  })

  test('renders the exact bounded terminal reason behind the canonical blocked condition', () => {
    const base = readyState()
    const blocked: RuntimeState = {
      ...base,
      status: 'DEGRADED',
      cycle: {
        ...base.cycle,
        last: {
          cycleId: '1'.repeat(64),
          accountId: 'paper-account-1',
          signalSessionDate: '2026-07-17',
          executionSessionDate: '2026-07-20',
          phase: CycleState.Blocked,
          snapshotId: '2'.repeat(64),
          decisionHash: null,
          terminalReason: CycleTerminalReason.ProvenanceMismatch,
          submissionOpenAt: '2026-07-20T11:30:00.000Z',
          submissionCutoffAt: '2026-07-20T12:30:00.000Z',
          executionOpenAt: '2026-07-20T12:32:00.000Z',
          executionCloseAt: '2026-07-20T20:00:00.000Z',
          createdAt: '2026-07-20T11:29:00.000Z',
          updatedAt: '2026-07-20T12:00:00.000Z',
          terminalAt: '2026-07-20T12:00:00.000Z',
        },
        condition: CycleOperationsCondition.Failed,
        reason: CycleOperationsReason.LastCycleBlocked,
        alerts: { ...base.cycle.alerts, cycleFailed: true },
      },
    }

    const metrics = renderPrometheusMetrics(blocked, config, provenance, 'embedded')

    expect(metrics).toContain('bayn_cycle_condition{condition="failed"} 1')
    expect(metrics).toContain('bayn_cycle_reason{reason="last_cycle_blocked"} 1')
    expect(metrics).toContain('bayn_cycle_terminal_reason{reason="blocked_provenance_mismatch"} 1')
    expect(metrics).toContain('bayn_cycle_terminal_reason{reason="blocked_data_stale"} 0')
  })

  test('propagates interruption and finalizes a historical read exactly once', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const finalizations = yield* Ref.make(0)
        const read = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Ref.update(finalizations, (count) => count + 1)),
        )
        const readFiber = yield* readHistoricalEvidence(read, 5_000).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        yield* Fiber.interrupt(readFiber)
        return yield* Ref.get(finalizations)
      }),
    )

    expect(result).toBe(1)
  })

  test('interrupts and finalizes a historical read when the real client socket disconnects', async () => {
    const started = await Effect.runPromise(Deferred.make<void>())
    const finalized = await Effect.runPromise(Deferred.make<void>())
    const finalizations = await Effect.runPromise(Ref.make(0))
    const responseChunks: Array<string> = []
    const read = () =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Ref.update(finalizations, (count) => count + 1).pipe(Effect.andThen(Deferred.succeed(finalized, undefined))),
        ),
      )

    await withHttpServer({ readEvidence: read, operationTimeoutMs: 5_000 }, ({ port }) =>
      withConnectedSocket(port, (socket) => {
        const onData = (chunk: Buffer) => responseChunks.push(chunk.toString())
        return Effect.sync(() => {
          socket.on('data', onData)
          socket.write(
            `GET /v1/evaluations/${historicalRunId} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
          )
        }).pipe(
          Effect.andThen(Deferred.await(started)),
          Effect.andThen(Effect.sync(() => socket.destroy())),
          Effect.andThen(
            Deferred.await(finalized).pipe(
              Effect.timeoutOrElse({
                duration: 1_000,
                orElse: () => Effect.die({ _tag: 'ClientDisconnectFinalizerTimeout' } as const),
              }),
            ),
          ),
          Effect.andThen(Effect.sleep(25)),
          Effect.andThen(Ref.get(finalizations)),
          Effect.tap((count) =>
            Effect.sync(() => {
              expect(count).toBe(1)
              expect(responseChunks.join('')).not.toContain('503')
            }),
          ),
          Effect.ensuring(Effect.sync(() => socket.off('data', onData))),
          Effect.asVoid,
        )
      }),
    )
  })

  test('interrupts and finalizes a timed-out historical read before rendering the bounded response', async () => {
    const finalizations = await Effect.runPromise(Ref.make(0))
    const read = () => Effect.never.pipe(Effect.ensuring(Ref.update(finalizations, (count) => count + 1)))

    await withHttpServer({ readEvidence: read, operationTimeoutMs: 25 }, ({ port }) =>
      request(port, `/v1/evaluations/${historicalRunId}`).pipe(
        Effect.flatMap((response) =>
          Ref.get(finalizations).pipe(
            Effect.tap((count) =>
              Effect.sync(() => {
                expect(response).toEqual({
                  status: 503,
                  allow: null,
                  cacheControl: null,
                  contentType: 'application/json',
                  body: { error: 'evidence_unavailable' },
                })
                expect(count).toBe(1)
              }),
            ),
          ),
        ),
        Effect.asVoid,
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

    await withHttpServer({ readEvidence: unavailableStore.read }, ({ port }) =>
      request(port, `/v1/evaluations/${historicalRunId}`).pipe(
        Effect.tap((response) =>
          Effect.sync(() => {
            expect(response).toMatchObject({ status: 503, body: { error: 'evidence_unavailable' } })
          }),
        ),
        Effect.asVoid,
      ),
    )
  })

  test('reports the configured ceiling without implying broker capability', async () => {
    await withHttpServer({ maximumAuthority: Authority.Paper }, ({ port }) =>
      request(port, '/v1/status').pipe(
        Effect.tap((response) =>
          Effect.sync(() => {
            expect(response).toMatchObject({
              status: 200,
              body: { authority: { maximum: 'paper', brokerOrders: false, capitalPromotion: false } },
            })
          }),
        ),
        Effect.asVoid,
      ),
    )
  })

  test('keeps broker read capability out of runtime state and public status', async () => {
    const unused = Effect.die('status must not invoke broker reads')
    const read: BrokerReadShape = {
      account: unused,
      accountConfiguration: unused,
      assetBySymbol: unusedAssetBySymbol,
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

    await withHttpServer({ state: runtimeState }, ({ port }) =>
      request(port, '/v1/status').pipe(
        Effect.tap((response) =>
          Effect.sync(() => {
            expect(response.body).toMatchObject({
              broker: {
                configured: true,
                expectedAccountId: 'paper-account-1',
                executionEligible: false,
                executionDisabledReason: 'MAXIMUM_AUTHORITY_OBSERVE',
              },
            })
            const body = response.body as { readonly broker: Record<string, unknown> }
            expect(body.broker).not.toHaveProperty('read')
            expect(Object.values(body.broker).some((value) => typeof value === 'function')).toBe(false)
          }),
        ),
        Effect.asVoid,
      ),
    )
  })

  test('does not synthesize durable cycle, mutation, reconciliation, or authority observations', () => {
    const metrics = renderPrometheusMetrics(initialState(), config, provenance, 'embedded')

    expect(metrics).toContain('bayn_cycle_observation_available 0')
    expect(metrics).toContain('bayn_cycle_condition{condition="unknown"} 1')
    expect(metrics).toContain('bayn_cycle_reason{reason="observation_unavailable"} 1')
    expect(metrics).toContain('bayn_cycle_phase{phase="unknown"} 1')
    expect(metrics).toContain('bayn_cycle_terminal_reason{reason="unknown"} 1')
    expect(metrics).toContain('bayn_zero_mutation_confirmed 0')
    expect(metrics).not.toContain('bayn_cycle_unfinished_count ')
    expect(metrics).not.toContain('bayn_mutation_events_total ')
    expect(metrics).not.toContain('bayn_unresolved_mutations ')
    expect(metrics).not.toContain('bayn_reconciliation_available ')
    expect(metrics).not.toContain('bayn_authority_coherent ')
    expect(metrics).not.toContain('bayn_authority_kill_active ')
  })
})
