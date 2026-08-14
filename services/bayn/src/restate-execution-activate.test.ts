import { describe, expect, test } from 'bun:test'
import { Effect, Redacted, Result } from 'effect'

import {
  activateRestateExecutionController,
  restateExecutionActivationCompletionWindowMs,
  restateExecutionActivationIdempotencyKey,
  restateExecutionActivationRequest,
  verifyRestateExecutionActivation,
  type RestateExecutionActivationConfig,
} from './restate-execution-activate'

const config: RestateExecutionActivationConfig = {
  controllerKey: 'a'.repeat(64),
  ingressOrigin: 'http://restate.example.test:8080',
  operationTimeoutMs: 30_000,
  planHash: 'b'.repeat(64),
  sourceRevision: 'c'.repeat(40),
}
const token = Buffer.alloc(32, 9).toString('base64url')
const invocationId = 'inv_1aiqX0vFEFNH1Umgre58JiCLgHfTtztYK5'
const activeState = {
  schemaVersion: 1 as const,
  active: true,
  epoch: 1,
  planHash: config.planHash,
  sourceRevision: config.sourceRevision,
  initialSequence: 0,
  nextSequence: 0,
}

describe('native Restate execution activation', () => {
  test('binds one authenticated idempotent bootstrap request to the immutable deployment', () => {
    expect(restateExecutionActivationIdempotencyKey(config.sourceRevision, config.controllerKey)).toBe(
      `bayn-execution-${config.sourceRevision}-${config.controllerKey}`,
    )
    expect(restateExecutionActivationRequest(config, token)).toEqual({
      path: '/restate/send/BaynExecutionBootstrap/start',
      body: {
        schemaVersion: 'bayn.execution-controller-bootstrap.v1',
        controllerKey: config.controllerKey,
        planHash: config.planHash,
        sourceRevision: config.sourceRevision,
      },
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': `bayn-execution-${config.sourceRevision}-${config.controllerKey}`,
      },
      timeoutMs: 30_000,
    })
    expect(restateExecutionActivationCompletionWindowMs(config.operationTimeoutMs)).toBe(240_000)
  })

  test('verifies only the exact active controller binding', () => {
    expect(Result.getOrThrow(verifyRestateExecutionActivation(config, activeState))).toEqual(activeState)
    for (const invalid of [
      { ...activeState, active: false },
      { ...activeState, planHash: 'd'.repeat(64) },
      { ...activeState, sourceRevision: 'e'.repeat(40) },
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
      `${config.ingressOrigin}/restate/send/BaynExecutionBootstrap/start`,
      `${config.ingressOrigin}/restate/invocation/${invocationId}/output`,
    ])
    expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe(`Bearer ${token}`)
    expect(JSON.stringify(state)).not.toContain(token)
  })

  test('fails before invocation when the bootstrap token is malformed', async () => {
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
