import { describe, expect, test } from 'bun:test'

import type { ObjectContext } from '@restatedev/restate-sdk'
import { Result } from 'effect'

import { maximumConsistencyDelayMs } from './execution/mutations'
import { lifecycleCommandId } from './lifecycle-command-contract'
import { decodeRestateLifecycleConfig, initialRestateLifecycleState } from './restate-lifecycle'
import {
  lifecycleAdvanceRetryPolicy,
  lifecycleAdvanceMaximumDeliveryAttempts,
  lifecycleAdvanceRunRetryPolicy,
  lifecycleActivationAwaitTimeoutMs,
  lifecycleActivationHandlerTimeouts,
  lifecycleActivationIdempotencyRetentionMs,
  lifecycleActivationMaximumAttempts,
  lifecycleActivationRetryPolicy,
  lifecycleBootstrapRetryPolicy,
  lifecycleCommandFinalizationHeadroomMs,
  lifecycleCommandRequestTimeoutMs,
  lifecycleCursorRequestTimeoutMs,
  lifecycleHandlerTimeouts,
  lifecycleTickIdempotencyKey,
  makeBaynLifecycle,
  makeLifecycleCommandClient,
} from './restate-lifecycle-controller'

const configInput = {
  schemaVersion: 'bayn.restate-lifecycle-config.v1',
  controllerKey: 'primary',
  commandBaseUrl: 'http://bayn-lifecycle-command.bayn.svc.cluster.local:8081',
  operationTimeoutMs: 30_000,
  pollIntervalMs: 30_000,
  sourceRevision: 'a'.repeat(40),
  port: 9080,
} as const
const config = Result.getOrThrow(decodeRestateLifecycleConfig(configInput))

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(body), { ...init, headers })
}

describe('Restate lifecycle command client', () => {
  test('bounds every external advance phase and retains durable finalization headroom', () => {
    expect(lifecycleCommandRequestTimeoutMs(1_000)).toBe(
      3_000 + maximumConsistencyDelayMs + lifecycleCommandFinalizationHeadroomMs,
    )
    expect(lifecycleCommandRequestTimeoutMs(30_000)).toBe(420_000)
    expect(lifecycleCommandRequestTimeoutMs(86_400_000)).toBe(
      259_200_000 + maximumConsistencyDelayMs + lifecycleCommandFinalizationHeadroomMs,
    )
  })

  test('keeps Restate inactivity and abort limits beyond every accepted command request', () => {
    for (const operationTimeoutMs of [1_000, 30_000, 86_400_000]) {
      const expected = lifecycleHandlerTimeouts(operationTimeoutMs)

      expect(expected).toEqual({
        inactivityTimeout:
          operationTimeoutMs * 3 + maximumConsistencyDelayMs + lifecycleCommandFinalizationHeadroomMs * 2,
        abortTimeout: lifecycleCommandFinalizationHeadroomMs,
      })
      expect(expected.inactivityTimeout).toBeGreaterThan(lifecycleCommandRequestTimeoutMs(operationTimeoutMs))
    }
  })

  test('bounds activation lock ownership and keeps the registration waiter outside that boundary', () => {
    expect(lifecycleActivationRetryPolicy).toEqual({
      maxAttempts: 8,
      onMaxAttempts: 'kill',
      initialInterval: 1_000,
      maxInterval: 30_000,
      exponentiationFactor: 2,
    })
    expect(lifecycleBootstrapRetryPolicy).toEqual({ maxAttempts: 1, onMaxAttempts: 'kill' })
    expect(lifecycleAdvanceRetryPolicy).toEqual({ maxAttempts: 1, onMaxAttempts: 'kill' })
    expect(lifecycleAdvanceRunRetryPolicy).toEqual({ maxRetryAttempts: 0 })
    expect(lifecycleAdvanceMaximumDeliveryAttempts).toBe(3)
    expect(lifecycleActivationIdempotencyRetentionMs).toBe(600_000)
    expect(lifecycleCursorRequestTimeoutMs).toBe(10_000)
    expect(lifecycleActivationAwaitTimeoutMs(config.operationTimeoutMs)).toBe(621_000)
    expect(lifecycleActivationAwaitTimeoutMs(config.operationTimeoutMs)).toBe(
      lifecycleCommandRequestTimeoutMs(config.operationTimeoutMs) +
        lifecycleCursorRequestTimeoutMs * lifecycleActivationMaximumAttempts +
        91_000 +
        lifecycleCommandFinalizationHeadroomMs,
    )
    expect(lifecycleActivationHandlerTimeouts(config.operationTimeoutMs)).toEqual({
      inactivityTimeout: 651_000,
      abortTimeout: lifecycleCommandFinalizationHeadroomMs,
    })
    expect(lifecycleActivationHandlerTimeouts(config.operationTimeoutMs).inactivityTimeout).toBeGreaterThan(
      lifecycleActivationAwaitTimeoutMs(config.operationTimeoutMs),
    )
  })

  test('gives each detached retry a distinct durable invocation identity', () => {
    expect(lifecycleTickIdempotencyKey(5, 2307, 0)).toBe('bayn-lifecycle-5-2307-0')
    expect(lifecycleTickIdempotencyKey(5, 2307, 1)).toBe('bayn-lifecycle-5-2307-1')
    expect(lifecycleTickIdempotencyKey(6, 2307, 0)).toBe('bayn-lifecycle-6-2307-0')
  })

  test('recovers a killed advance through the queued delivery with one persisted command identity', async () => {
    const initial = initialRestateLifecycleState(config, { _tag: 'Next', sequence: 7 }, 4)
    let state = initial
    const commands: Array<{
      readonly controllerKey: string
      readonly commandId: string
      readonly sequence: number
      readonly issuedAt: string
    }> = []
    const deliveries: Array<{
      readonly parameter: unknown
      readonly idempotencyKey?: string
    }> = []
    const client = {
      readCursor: () => Promise.reject(new Error('not used by advance')),
      advance: async (command: (typeof commands)[number]) => {
        commands.push(command)
        if (commands.length === 1) throw new Error('simulated response loss')
        return {
          schemaVersion: 'bayn.lifecycle-command-response.v1' as const,
          accepted: true as const,
          commandId: command.commandId,
          sequence: command.sequence,
          sourceRevision: config.sourceRevision,
          replayed: true,
          nextDelayMs: 30_000,
          observation: {
            result: 'SUCCESS' as const,
            outcome: 'RECOVERED' as const,
            observedAt: '2026-08-10T20:00:02.000Z',
          },
        }
      },
    }
    const lifecycle = makeBaynLifecycle(config, client)
    const instants = ['2026-08-10T20:00:00.000Z', '2026-08-10T20:00:01.000Z', '2026-08-10T20:00:02.000Z']
    const context = {
      key: 'primary',
      get: async () => state,
      set: (_key: string, next: typeof state) => {
        state = next
      },
      genericSend: (delivery: (typeof deliveries)[number]) => {
        deliveries.push(delivery)
      },
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      date: {
        toJSON: async () => instants.shift() ?? '2026-08-10T20:00:03.000Z',
      },
    } as unknown as ObjectContext<{ readonly controller: typeof state }>
    const firstTick = {
      schemaVersion: 'bayn.restate-lifecycle-tick.v1' as const,
      epoch: initial.epoch,
      sequence: 7,
      deliveryAttempt: 0,
    }
    // Restate's runtime definition retains the wrapped server handlers for endpoint binding, but the 1.16 public
    // VirtualObjectDefinition type intentionally exposes only the client contract. Cross that test-only boundary once
    // so this regression executes the exact handler installed by makeBaynLifecycle.
    const advance = (
      lifecycle as unknown as {
        readonly object: {
          readonly advance: (handlerContext: typeof context, candidate: unknown) => Promise<void>
        }
      }
    ).object.advance

    let firstFailure: unknown
    try {
      await advance(context, firstTick)
    } catch (cause) {
      firstFailure = cause
    }
    if (!(firstFailure instanceof Error)) throw new Error('first advance did not fail with an Error')
    expect(firstFailure.message).toBe('simulated response loss')
    expect(commands).toHaveLength(1)
    expect(state.cursor).toEqual({ _tag: 'Pending', command: commands[0] })
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      parameter: { ...firstTick, deliveryAttempt: 1 },
      idempotencyKey: lifecycleTickIdempotencyKey(initial.epoch, 7, 1),
    })

    const firstRecovery = deliveries.shift()
    if (firstRecovery === undefined) throw new Error('recovery delivery was not scheduled')
    await advance(context, firstRecovery.parameter)

    expect(commands).toHaveLength(2)
    expect(commands[1]).toEqual(commands[0])
    expect(state).toMatchObject({
      cursor: { _tag: 'Next', sequence: 8 },
      lastCompletion: { commandId: commands[0]?.commandId, sequence: 7, replayed: true, result: 'SUCCESS' },
    })
    expect(deliveries).toHaveLength(2)

    const staleRecovery = deliveries.find(
      ({ idempotencyKey }) => idempotencyKey === lifecycleTickIdempotencyKey(initial.epoch, 7, 2),
    )
    if (staleRecovery === undefined) throw new Error('second recovery delivery was not scheduled')
    await advance(context, staleRecovery.parameter)
    expect(commands).toHaveLength(2)
  })

  test('bounds persistent command failures to the durable delivery budget', async () => {
    const initial = initialRestateLifecycleState(config, { _tag: 'Next', sequence: 7 }, 4)
    let state = initial
    let commandAttempts = 0
    const deliveries: Array<{ readonly parameter: unknown; readonly idempotencyKey?: string }> = []
    const lifecycle = makeBaynLifecycle(config, {
      readCursor: () => Promise.reject(new Error('not used by advance')),
      advance: () => {
        commandAttempts += 1
        return Promise.reject(new Error('persistent command outage'))
      },
    })
    const context = {
      key: 'primary',
      get: async () => state,
      set: (_key: string, next: typeof state) => {
        state = next
      },
      genericSend: (delivery: (typeof deliveries)[number]) => {
        deliveries.push(delivery)
      },
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      date: {
        toJSON: async () => '2026-08-10T20:00:00.000Z',
      },
    } as unknown as ObjectContext<{ readonly controller: typeof state }>
    const advance = (
      lifecycle as unknown as {
        readonly object: {
          readonly advance: (handlerContext: typeof context, candidate: unknown) => Promise<void>
        }
      }
    ).object.advance
    let candidate: unknown = {
      schemaVersion: 'bayn.restate-lifecycle-tick.v1',
      epoch: initial.epoch,
      sequence: 7,
      deliveryAttempt: 0,
    }

    for (let attempt = 0; attempt < lifecycleAdvanceMaximumDeliveryAttempts; attempt += 1) {
      let failure: unknown
      try {
        await advance(context, candidate)
      } catch (cause) {
        failure = cause
      }
      if (!(failure instanceof Error)) throw new Error('persistent command outage did not fail with an Error')
      expect(failure.message).toBe('persistent command outage')
      if (attempt + 1 < lifecycleAdvanceMaximumDeliveryAttempts) {
        const delivery = deliveries.shift()
        if (delivery === undefined) throw new Error('bounded recovery delivery was not scheduled')
        candidate = delivery.parameter
      }
    }

    expect(commandAttempts).toBe(lifecycleAdvanceMaximumDeliveryAttempts)
    expect(deliveries).toHaveLength(0)
    expect(state.cursor).toMatchObject({ _tag: 'Pending', command: { sequence: 7 } })
  })

  test('uses only the bound command origin and exact typed contracts', async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = []
    const credentialSignals: AbortSignal[] = []
    const request = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      if (url.endsWith('/cursor')) {
        return jsonResponse({
          schemaVersion: 'bayn.lifecycle-command-cursor.v1',
          controllerKey: 'primary',
          sourceRevision: config.sourceRevision,
          cursor: { _tag: 'Next', sequence: 4 },
        })
      }
      return jsonResponse({
        schemaVersion: 'bayn.lifecycle-command-response.v1',
        accepted: true,
        commandId: lifecycleCommandId('primary', 4),
        sequence: 4,
        sourceRevision: config.sourceRevision,
        replayed: false,
        nextDelayMs: 30_000,
        observation: {
          result: 'SUCCESS',
          outcome: 'NOT_DUE',
          observedAt: '2026-08-10T20:00:01.000Z',
        },
      })
    }
    const client = makeLifecycleCommandClient(
      config,
      async (signal) => {
        credentialSignals.push(signal)
        return 'projected-worker-token'
      },
      request,
      () => ({
        traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
        tracestate: 'bayn=test',
      }),
    )

    expect(await client.readCursor()).toMatchObject({ cursor: { _tag: 'Next', sequence: 4 } })
    expect(
      await client.advance({
        controllerKey: 'primary',
        commandId: lifecycleCommandId('primary', 4),
        sequence: 4,
        issuedAt: '2026-08-10T20:00:00.000Z',
      }),
    ).toMatchObject({ sequence: 4, replayed: false })

    expect(requests.map(({ url }) => url)).toEqual([
      `${config.commandBaseUrl}/v1/lifecycle/cursor`,
      `${config.commandBaseUrl}/v1/lifecycle/advance`,
    ])
    expect(requests.map(({ init }) => new Headers(init.headers).get('authorization'))).toEqual([
      'Bearer projected-worker-token',
      'Bearer projected-worker-token',
    ])
    expect(requests.map(({ init }) => new Headers(init.headers).get('traceparent'))).toEqual([
      '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
      '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    ])
    expect(requests.map(({ init }) => new Headers(init.headers).get('tracestate'))).toEqual(['bayn=test', 'bayn=test'])
    expect(requests.every(({ init }) => init.signal instanceof AbortSignal && !init.signal.aborted)).toBe(true)
    expect(requests.map(({ init }) => init.signal)).toEqual(credentialSignals)
    const advanceBody = requests[1]?.init.body
    if (typeof advanceBody !== 'string') throw new Error('advance request body is not a string')
    expect(JSON.parse(advanceBody)).toEqual({
      schemaVersion: 'bayn.lifecycle-command.v1',
      controllerKey: 'primary',
      commandId: lifecycleCommandId('primary', 4),
      sequence: 4,
      issuedAt: '2026-08-10T20:00:00.000Z',
      sourceRevision: config.sourceRevision,
    })
  })

  test('fails closed on invalid, non-JSON, or oversized Bayn responses', async () => {
    const invalidBodies: readonly Response[] = [
      jsonResponse({ controllerKey: 'primary', cursor: { _tag: 'Next', sequence: 1 } }),
      new Response('not json', { headers: { 'content-type': 'text/plain' } }),
      new Response('x'.repeat(65 * 1024), { headers: { 'content-type': 'application/json' } }),
    ]

    for (const response of invalidBodies) {
      const client = makeLifecycleCommandClient(
        config,
        async () => 'projected-worker-token',
        async () => response,
      )
      let rejected = false
      try {
        await client.readCursor()
      } catch {
        rejected = true
      }
      expect(rejected).toBe(true)
    }
  })
})
