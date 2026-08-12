import { describe, expect, test } from 'bun:test'

import { ConfigProvider, Effect, Exit, Fiber, Result } from 'effect'

import {
  decodeRestateAcceptedInvocation,
  postAcceptedInvocation,
  restateDeploymentRegistration,
  restateLifecycleActivationAcceptTimeoutMs,
  restateLifecycleActivationCompletionMaximumAttempts,
  restateLifecycleActivationCompletionPollIntervalMs,
  restateLifecycleActivationIdempotencyKey,
  restateLifecycleActivationOutputRequestTimeoutMs,
  restateLifecycleActivationRequest,
  restateLifecycleRegistrationConfig,
  waitForRestateInvocationCompletion,
} from './restate-lifecycle-register'

describe('Restate lifecycle deployment registration', () => {
  test('registers one immutable HTTP/2 endpoint without forcing replacement', () => {
    const sourceRevision = 'a'.repeat(40)

    expect(
      restateDeploymentRegistration('http://bayn-lifecycle-a.bayn.svc.cluster.local:9080', sourceRevision),
    ).toEqual({
      uri: 'http://bayn-lifecycle-a.bayn.svc.cluster.local:9080',
      force: false,
      metadata: {
        managed_by: 'argocd',
        service: 'bayn-lifecycle',
        source_revision: sourceRevision,
      },
    })
  })

  test('deduplicates pod retries while accepting a detached activation', () => {
    const sourceRevision = 'b'.repeat(40)
    const controllerKey = 'primary'

    expect(restateLifecycleActivationIdempotencyKey(sourceRevision, controllerKey)).toBe(
      `bayn-lifecycle-${sourceRevision}-${controllerKey}`,
    )
    expect(restateLifecycleActivationRequest(sourceRevision, controllerKey)).toEqual({
      path: '/restate/send/BaynLifecycleBootstrap/start',
      body: {
        schemaVersion: 'bayn.restate-lifecycle-activation.v1',
        controllerKey,
      },
      headers: {
        'idempotency-key': `bayn-lifecycle-${sourceRevision}-${controllerKey}`,
      },
      timeoutMs: restateLifecycleActivationAcceptTimeoutMs,
    })
  })

  test('rejects operation timeouts outside the lifecycle endpoint bound before registration', async () => {
    for (const operationTimeoutMs of ['999', '86400001']) {
      const loaded = await Effect.runPromiseExit(
        restateLifecycleRegistrationConfig.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ BAYN_OPERATION_TIMEOUT_MS: operationTimeoutMs }),
          ),
        ),
      )
      expect(Exit.isFailure(loaded)).toBe(true)
    }
  })

  test('accepts only a closed Restate send receipt', () => {
    expect(
      Result.isSuccess(
        decodeRestateAcceptedInvocation({ invocationId: 'inv_1aiqX0vFEFNH1Umgre58JiCLgHfTtztYK5', status: 'Accepted' }),
      ),
    ).toBe(true)
    expect(Result.isFailure(decodeRestateAcceptedInvocation({ invocationId: 'other', status: 'Accepted' }))).toBe(true)
    expect(
      Result.isFailure(
        decodeRestateAcceptedInvocation({ invocationId: 'inv_1aiqX0vFEFNH1Umgre58JiCLgHfTtztYK5', status: 'Done' }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        decodeRestateAcceptedInvocation({
          invocationId: 'inv_1aiqX0vFEFNH1Umgre58JiCLgHfTtztYK5',
          status: 'Accepted',
          extra: true,
        }),
      ),
    ).toBe(true)
  })

  test('waits for the accepted invocation to complete successfully', async () => {
    const invocationId = 'inv_1aiqX0vFEFNH1Umgre58JiCLgHfTtztYK5'
    const requests: Array<{ readonly init: RequestInit | undefined; readonly url: string }> = []
    const responses = [
      new Response(JSON.stringify({ message: 'the invocation exists but has not completed yet' }), {
        status: 470,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(JSON.stringify({ epoch: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-restate-id': invocationId },
      }),
    ]

    await Effect.runPromise(
      waitForRestateInvocationCompletion(
        'http://restate.example.test:8080',
        invocationId,
        async (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          requests.push({ url, init })
          const response = responses.shift()
          if (response === undefined) throw new Error('unexpected output poll')
          return response
        },
        2,
        0,
      ),
    )

    expect(requests.map(({ url }) => url)).toEqual([
      `http://restate.example.test:8080/restate/invocation/${invocationId}/output`,
      `http://restate.example.test:8080/restate/invocation/${invocationId}/output`,
    ])
    expect(requests.every(({ init }) => init?.method === 'GET' && init.signal instanceof AbortSignal)).toBe(true)
    expect(restateLifecycleActivationOutputRequestTimeoutMs).toBe(10_000)
    expect(restateLifecycleActivationCompletionMaximumAttempts(30_000)).toBe(208)
    expect(
      (restateLifecycleActivationCompletionMaximumAttempts(30_000) - 1) *
        restateLifecycleActivationCompletionPollIntervalMs,
    ).toBe(621_000)
    expect(restateLifecycleActivationCompletionPollIntervalMs).toBe(3_000)
  })

  test('fails the registration job when activation remains pending or terminates unsuccessfully', async () => {
    const invocationId = 'inv_1aiqX0vFEFNH1Umgre58JiCLgHfTtztYK5'
    const pending = () =>
      new Response(JSON.stringify({ message: 'the invocation exists but has not completed yet' }), {
        status: 470,
        headers: { 'content-type': 'application/json' },
      })

    const pendingFailure = await Effect.runPromise(
      Effect.flip(
        waitForRestateInvocationCompletion(
          'http://restate.example.test:8080',
          invocationId,
          async () => pending(),
          2,
          0,
        ),
      ),
    )
    expect(pendingFailure).toMatchObject({
      message: 'Bayn Restate lifecycle activation remains incomplete after the bounded completion check',
      operation: 'activate',
    })

    const terminalFailure = await Effect.runPromise(
      Effect.flip(
        waitForRestateInvocationCompletion(
          'http://restate.example.test:8080',
          invocationId,
          async () => new Response(JSON.stringify({ message: 'activation failed' }), { status: 500 }),
          1,
          0,
        ),
      ),
    )
    expect(terminalFailure).toMatchObject({
      message: 'Bayn Restate lifecycle activation completion check failed',
      operation: 'activate',
    })
  })

  test('fails closed when the completed output belongs to another invocation', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        waitForRestateInvocationCompletion(
          'http://restate.example.test:8080',
          'inv_1aiqX0vFEFNH1Umgre58JiCLgHfTtztYK5',
          async () =>
            new Response(null, {
              status: 200,
              headers: { 'x-restate-id': 'inv_other' },
            }),
          1,
          0,
        ),
      ),
    )
    expect(failure).toMatchObject({ operation: 'activate' })
  })

  test('aborts activation HTTP work when the registration Effect is interrupted', async () => {
    const invocationId = 'inv_1aiqX0vFEFNH1Umgre58JiCLgHfTtztYK5'
    type Request = (input: string | URL | globalThis.Request, init?: RequestInit) => Promise<Response>
    const requestEffects = [
      (request: Request) =>
        postAcceptedInvocation(
          'http://restate.example.test:8080/restate/send/BaynLifecycleBootstrap/start',
          { schemaVersion: 'bayn.restate-lifecycle-activation.v1', controllerKey: 'primary' },
          { timeoutMs: restateLifecycleActivationAcceptTimeoutMs },
          request,
        ),
      (request: Request) =>
        waitForRestateInvocationCompletion('http://restate.example.test:8080', invocationId, request, 1, 0),
    ]

    for (const makeEffect of requestEffects) {
      let captureSignal: ((signal: AbortSignal) => void) | undefined
      const observedSignal = new Promise<AbortSignal>((resolve) => void (captureSignal = resolve))
      const request = async (_input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
        if (!(init?.signal instanceof AbortSignal)) throw new Error('request did not receive an abort signal')
        captureSignal?.(init.signal)
        return new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }),
        )
      }
      const fiber = Effect.runFork(makeEffect(request))
      const signal = await observedSignal

      expect(signal.aborted).toBe(false)
      await Effect.runPromise(Fiber.interrupt(fiber))
      expect(signal.aborted).toBe(true)
    }
  })
})
