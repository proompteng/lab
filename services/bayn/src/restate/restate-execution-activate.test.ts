import { describe, expect, test } from 'bun:test'
import { ConfigProvider, Effect, Fiber, Layer, Logger, Redacted, References, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { ExecutionControllerOutcome } from '../execution/controller-status'
import {
  activateRestateExecutionController,
  restateExecutionActivationCompletionWindowMs,
  restateExecutionActivationIdempotencyKey,
  restateExecutionActivationRequest,
  restateExecutionActivationTransportConfig,
  runFiniteLayer,
  verifyRestateExecutionActivation,
  type RestateExecutionActivationConfig,
} from './restate-execution-activate'

const config: RestateExecutionActivationConfig = {
  activationAttemptId: '5c25a32e-938a-47d1-8e8c-0b254679a591',
  activationGeneration: '1'.repeat(64),
  controllerKey: 'a'.repeat(64),
  ingressOrigin: 'http://restate.example.test:8080',
  operationTimeoutMs: 30_000,
  planHash: 'b'.repeat(64),
  sourceRevision: 'c'.repeat(40),
}
const token = Buffer.alloc(32, 9).toString('base64url')
const invocationId = 'inv_1aiqX0vFEFNH1Umgre58JiCLgHfTtztYK5'
const transportConfig = (activationAttemptId: string | undefined) =>
  restateExecutionActivationTransportConfig.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({
        ...(activationAttemptId === undefined ? {} : { BAYN_EXECUTION_ACTIVATION_ATTEMPT_ID: activationAttemptId }),
        BAYN_EXECUTION_ACTIVATION_GENERATION: config.activationGeneration,
        BAYN_EXECUTION_ACTIVATION_TOKEN: token,
        RESTATE_INGRESS_ORIGIN: config.ingressOrigin,
      }),
    ),
  )
const activeState = {
  schemaVersion: 1 as const,
  active: true,
  epoch: 1,
  planHash: config.planHash,
  sourceRevision: config.sourceRevision,
  initialSequence: 0,
  nextSequence: 2,
  lastCompletion: {
    sequence: 1,
    outcome: ExecutionControllerOutcome.Blocked,
    receiptHash: 'd'.repeat(64),
    completedAt: '2026-08-17T18:00:00.000Z',
  },
  nextDueAt: '2026-08-17T18:01:00.000Z',
}

describe('native Restate execution activation', () => {
  test('runs the one-shot process to completion and releases its runtime layer', async () => {
    let released = false
    const layer = Layer.effectDiscard(
      Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          released = true
        }),
      ),
    )

    await Effect.runPromise(runFiniteLayer(layer))

    expect(released).toBe(true)
  })

  test('binds one activation Job to its exact deployment generation and controller', () => {
    const idempotencyKey = restateExecutionActivationIdempotencyKey(config)
    expect(idempotencyKey).toMatch(/^bayn-execution-[0-9a-f]{64}$/)
    expect(idempotencyKey.length).toBeLessThanOrEqual(128)
    expect(restateExecutionActivationRequest(config, token).headers['idempotency-key']).toBe(idempotencyKey)
    expect(restateExecutionActivationIdempotencyKey({ ...config, activationGeneration: '2'.repeat(64) })).not.toBe(
      idempotencyKey,
    )
    expect(restateExecutionActivationIdempotencyKey({ ...config, sourceRevision: 'd'.repeat(40) })).not.toBe(
      idempotencyKey,
    )
    expect(restateExecutionActivationIdempotencyKey({ ...config, controllerKey: 'e'.repeat(64) })).not.toBe(
      idempotencyKey,
    )
    expect(restateExecutionActivationIdempotencyKey({ ...config, planHash: 'f'.repeat(64) })).not.toBe(idempotencyKey)
    expect(
      restateExecutionActivationRequest({ ...config, activationGeneration: '2'.repeat(64) }, token).headers[
        'idempotency-key'
      ],
    ).not.toBe(idempotencyKey)
    expect(restateExecutionActivationRequest(config, token)).toEqual({
      path: `/restate/send/BaynExecutionController/${config.controllerKey}/activateDeployment`,
      body: {
        schemaVersion: 'bayn.execution-deployment-activation.v1',
        controllerKey: config.controllerKey,
        planHash: config.planHash,
        sourceRevision: config.sourceRevision,
      },
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': idempotencyKey,
      },
      timeoutMs: 30_000,
    })
    expect(restateExecutionActivationCompletionWindowMs(config.operationTimeoutMs)).toBe(480_000)
  })

  test('binds a rotation request and its idempotency identity to the exact previous controller', () => {
    const previousBinding = { planHash: 'd'.repeat(64), sourceRevision: 'e'.repeat(40) }
    const rotating = { ...config, previousBinding }
    const request = restateExecutionActivationRequest(rotating, token)

    expect(request.body).toEqual({
      schemaVersion: 'bayn.execution-deployment-activation.v1',
      controllerKey: config.controllerKey,
      planHash: config.planHash,
      sourceRevision: config.sourceRevision,
      previousBinding,
    })
    expect(request.headers['idempotency-key']).toBe(restateExecutionActivationIdempotencyKey(rotating))
    expect(request.headers['idempotency-key']).not.toBe(restateExecutionActivationIdempotencyKey(config))
    expect(
      restateExecutionActivationIdempotencyKey({
        ...rotating,
        previousBinding: { ...previousBinding, planHash: 'f'.repeat(64) },
      }),
    ).not.toBe(request.headers['idempotency-key'])
    expect(restateExecutionActivationCompletionWindowMs(config.operationTimeoutMs)).toBeLessThan(900_000)
  })

  test('reuses the Job identity across fresh container and replacement Pod configuration loads', async () => {
    const requests = []
    for (let restart = 0; restart < 3; restart += 1) {
      const loaded = await Effect.runPromise(transportConfig(config.activationAttemptId))
      expect(loaded.activationAttemptId).toBe(config.activationAttemptId)
      requests.push(restateExecutionActivationRequest({ ...config, ...loaded }, token))
    }
    expect(new Set(requests.map((request) => request.headers['idempotency-key'])).size).toBe(1)
    const recreated = await Effect.runPromise(transportConfig('5c25a32e-938a-47d1-8e8c-0b254679a592'))
    expect(restateExecutionActivationRequest({ ...config, ...recreated }, token).headers['idempotency-key']).not.toBe(
      requests[0]?.headers['idempotency-key'],
    )
  })

  test('rejects missing and malformed Job identities before an activation can be sent', async () => {
    for (const identity of [
      undefined,
      '',
      'pod-name',
      '00000000-0000-0000-0000-000000000000',
      `${config.activationAttemptId}\n`,
    ]) {
      let requests = 0
      const outcome = await Effect.runPromise(
        transportConfig(identity).pipe(
          Effect.flatMap((loaded) =>
            activateRestateExecutionController({ ...config, ...loaded }, Redacted.make(token), async () => {
              requests += 1
              throw new Error('invalid configuration must not send')
            }),
          ),
          Effect.result,
        ),
      )
      expect(Result.isFailure(outcome)).toBe(true)
      expect(requests).toBe(0)
    }
  })

  test('a completion timeout and restarted waiter keep the accepted invocation and log its safe receipt', async () => {
    const keys: Array<string | null> = []
    const outputUrls: string[] = []
    const logs: Array<{ message: unknown; annotations: unknown }> = []
    let complete = false
    const logger = Logger.make<unknown, void>((entry) => {
      const { trace_id: _trace, span_id: _span, ...annotations } = entry.fiber.getRef(References.CurrentLogAnnotations)
      logs.push({ message: entry.message, annotations })
    })
    const request = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (init?.method === 'POST') {
        keys.push(new Headers(init.headers).get('idempotency-key'))
        return new Response(
          JSON.stringify({ invocationId, status: keys.length === 1 ? 'Accepted' : 'PreviouslyAccepted' }),
          {
            status: 202,
            headers: { 'content-type': 'application/json' },
          },
        )
      }
      outputUrls.push(url)
      return complete
        ? new Response(JSON.stringify(activeState), {
            status: 200,
            headers: { 'content-type': 'application/json', 'x-restate-id': invocationId },
          })
        : new Response(null, { status: 470 })
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const loaded = yield* transportConfig(config.activationAttemptId)
        const pending = yield* activateRestateExecutionController(
          { ...config, ...loaded },
          Redacted.make(token),
          request,
        ).pipe(Effect.result, Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust(480_000)
        const timedOut = yield* Fiber.join(pending)
        expect(Result.isFailure(timedOut)).toBe(true)
        if (Result.isFailure(timedOut))
          expect(timedOut.failure).toMatchObject({
            operation: 'invoke',
            cause: {
              operation: 'await',
              message: 'Restate invocation remains incomplete after the bounded completion check',
            },
          })
        expect(keys).toHaveLength(1)
        expect(logs).toEqual([
          {
            message: ['Bayn native Restate execution controller activation accepted'],
            annotations: {
              activationAttemptId: config.activationAttemptId,
              activationInvocationId: invocationId,
              sourceRevision: config.sourceRevision,
              status: 'Accepted',
            },
          },
        ])
        complete = true
        const restarted = yield* transportConfig(config.activationAttemptId)
        expect(
          yield* activateRestateExecutionController({ ...config, ...restarted }, Redacted.make(token), request),
        ).toEqual(activeState)
      }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([logger]))),
    )
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(1)
    expect(new Set(outputUrls)).toEqual(new Set([`${config.ingressOrigin}/restate/invocation/${invocationId}/output`]))
    expect(logs[1]).toMatchObject({
      annotations: { status: 'PreviouslyAccepted', activationInvocationId: invocationId },
    })
    expect(JSON.stringify(logs)).not.toContain(token)
  })

  test('verifies the active controller plan after the current worker completed a successor pass', () => {
    expect(Result.getOrThrow(verifyRestateExecutionActivation(config, activeState))).toEqual(activeState)
    for (const invalid of [
      { ...activeState, active: false },
      { ...activeState, planHash: 'd'.repeat(64) },
      { ...activeState, sourceRevision: 'e'.repeat(40) },
      { ...activeState, lastCompletion: undefined },
      { ...activeState, nextSequence: 1 },
      {
        ...activeState,
        nextSequence: 1,
        lastCompletion: { ...activeState.lastCompletion, sequence: activeState.initialSequence },
      },
      { active: true },
    ]) {
      expect(Result.isFailure(verifyRestateExecutionActivation(config, invalid))).toBe(true)
    }
  })

  test('sends, awaits, and verifies one activation without exposing the token in the result', async () => {
    const requests: Array<{ readonly init: RequestInit | undefined; readonly url: string }> = []
    const responses = [
      new Response(JSON.stringify({ invocationId, status: 'Accepted' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(JSON.stringify(activeState), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-restate-id': invocationId },
      }),
    ]
    const state = await Effect.runPromise(
      activateRestateExecutionController(config, Redacted.make(token), async (input, init) => {
        requests.push({
          init,
          url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        })
        const response = responses.shift()
        if (response === undefined) throw new Error('unexpected request')
        return response
      }),
    )

    expect(state).toEqual(activeState)
    expect(requests.map(({ url }) => url)).toEqual([
      `${config.ingressOrigin}/restate/send/BaynExecutionController/${config.controllerKey}/activateDeployment`,
      `${config.ingressOrigin}/restate/invocation/${invocationId}/output`,
    ])
    expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe(`Bearer ${token}`)
    expect(JSON.stringify(state)).not.toContain(token)
  })

  test('fails before invocation when the activation token is malformed', async () => {
    let requests = 0
    const failure = await Effect.runPromise(
      Effect.flip(
        activateRestateExecutionController(config, Redacted.make('invalid'), async () => {
          requests += 1
          throw new Error('must not request')
        }),
      ),
    )

    expect(failure).toMatchObject({ operation: 'configuration' })
    expect(requests).toBe(0)
  })
})
