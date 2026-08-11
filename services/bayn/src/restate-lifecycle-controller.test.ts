import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import { lifecycleCommandId } from './lifecycle-command-contract'
import { decodeRestateLifecycleConfig } from './restate-lifecycle'
import {
  lifecycleCommandFinalizationHeadroomMs,
  lifecycleCommandRequestTimeoutMs,
  makeLifecycleCommandClient,
} from './restate-lifecycle-controller'

const config = Result.getOrThrow(
  decodeRestateLifecycleConfig({
    schemaVersion: 'bayn.restate-lifecycle-config.v1',
    controllerKey: 'primary',
    commandBaseUrl: 'http://bayn-lifecycle-command.bayn.svc.cluster.local:8081',
    operationTimeoutMs: 30_000,
    pollIntervalMs: 30_000,
    sourceRevision: 'a'.repeat(40),
    port: 9080,
  }),
)

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(body), { ...init, headers })
}

describe('Restate lifecycle command client', () => {
  test('keeps bounded finalization headroom beyond every accepted Bayn pass timeout', () => {
    expect(lifecycleCommandRequestTimeoutMs(1_000)).toBe(1_000 + lifecycleCommandFinalizationHeadroomMs)
    expect(lifecycleCommandRequestTimeoutMs(30_000)).toBe(60_000)
    expect(lifecycleCommandRequestTimeoutMs(86_400_000)).toBe(86_400_000 + lifecycleCommandFinalizationHeadroomMs)
  })

  test('uses only the bound command origin and exact typed contracts', async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = []
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
    const client = makeLifecycleCommandClient(config, async () => 'projected-worker-token', request)

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
    expect(requests.every(({ init }) => init.signal instanceof AbortSignal && !init.signal.aborted)).toBe(true)
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
