import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  AgentsHttpClient,
  type AgentsHttpClientService,
  type AgentsJsonEffectRequest,
  type AgentsServiceJsonSuccess,
} from './agents-http'
import { submitAgentRunRerunToAgentsServiceEffect } from './agent-run-reruns-client'

describe('agent-run-reruns-client', () => {
  it('submits AgentRun reruns to the Agents-owned endpoint with idempotency', async () => {
    const requests: AgentsJsonEffectRequest[] = []
    const client: AgentsHttpClientService = {
      requestJson: <T>(request: AgentsJsonEffectRequest) =>
        Effect.sync(() => {
          requests.push(request)
          return {
            ok: true,
            status: 201,
            body: { ok: true, submission: { id: 'rerun-1' } },
          } satisfies AgentsServiceJsonSuccess<T>
        }),
      fetchJson: () => Effect.die('unused'),
      postJson: (path, payload, options) =>
        client.requestJson({
          path,
          method: 'POST',
          payload,
          env: options?.env,
          idempotencyKey: options?.idempotencyKey,
        }),
      patchJson: () => Effect.die('unused'),
    }

    const result = await Effect.runPromise(
      submitAgentRunRerunToAgentsServiceEffect({
        agentRunId: 'agent-run/name',
        deliveryId: 'rerun-delivery-1',
        payload: { attempt: 2, prompt: 'Try again.' },
      }).pipe(Effect.provide(Layer.succeed(AgentsHttpClient, client))),
    )

    expect(result.body).toEqual({ ok: true, submission: { id: 'rerun-1' } })
    expect(requests).toEqual([
      {
        path: '/v1/agent-runs/agent-run%2Fname/reruns',
        method: 'POST',
        payload: { attempt: 2, prompt: 'Try again.', deliveryId: 'rerun-delivery-1' },
        env: process.env,
        idempotencyKey: 'rerun-delivery-1',
      },
    ])
  })
})
